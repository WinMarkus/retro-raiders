import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { LIMITS } from '../shared/constants.js';
import type {
  ActionResult,
  DownloadResult,
  JoinResult,
  MoveBroadcast,
  SaveResult,
  Topic,
} from '../shared/types.js';
import {
  abandonEncounter,
  allTopics,
  attackAvailable,
  clearLock,
  clearReady,
  collectNearbyPowerUps,
  everyoneReady,
  findEnemy,
  lockOn,
  resolveEnemy,
} from './game.js';
import { generateCharacters, generateLevel } from './generate.js';
import { commitFile, readGithubConfig } from './github.js';
import {
  isAllowedOpenRouterModel,
  readOpenRouterConfig,
  readOpenRouterImageConfig,
  selectOpenRouterModel,
} from './openrouter.js';
import { RATE_LIMITS, rateLimit } from './ratelimit.js';
import { buildCommitMessage, buildSavePath, buildSnapshot } from './snapshot.js';
import { isFacilitator, topicsOf, type PlayerRecord, type Room, type RoomStore } from './state.js';
import { SAVE_PLAYER_NAME, buildState } from './view.js';
import {
  clampPoint,
  isId,
  isValidPlayerName,
  normalizeRoomCode,
  sanitizeSingleLine,
  validateCheckIn,
  validateTopic,
  validateTreatment,
} from './validation.js';

type Ack<T> = ((result: T) => void) | undefined;

interface Membership {
  room: Room;
  player: PlayerRecord;
}

function reply<T>(ack: Ack<T>, result: T): void {
  if (typeof ack === 'function') ack(result);
}

function fail(ack: Ack<ActionResult>, error: string): void {
  reply(ack, { ok: false, error });
}

export function pushState(io: Server, room: Room): void {
  for (const player of room.players.values()) {
    if (!player.connected || !player.socketId) continue;
    io.to(player.socketId).emit('state', buildState(room, player.id));
  }
}

function toast(io: Server, room: Room, message: string): void {
  io.to(room.code).emit('notice', { message });
}

export function registerSocketHandlers(io: Server, store: RoomStore): void {
  io.on('connection', (socket: Socket) => {
    const membership = (): Membership | null => {
      const code = socket.data.roomCode as string | undefined;
      const playerId = socket.data.playerId as string | undefined;
      if (!code || !playerId) return null;
      const room = store.get(code);
      if (!room) return null;
      const player = room.players.get(playerId);
      if (!player) return null;
      if (player.socketId !== socket.id) return null;
      room.lastActivity = Date.now();
      return { room, player };
    };

    const facilitatorOnly = (ack: Ack<ActionResult>): Membership | null => {
      const found = membership();
      if (!found) {
        fail(ack, 'You are not in this room any more. Reload the page to rejoin.');
        return null;
      }
      if (!isFacilitator(found.room, found.player.id)) {
        fail(ack, 'Only the facilitator can do that.');
        return null;
      }
      return found;
    };

    const limited = (bucket: keyof typeof RATE_LIMITS, ack: Ack<ActionResult>): boolean => {
      const rule = RATE_LIMITS[bucket];
      if (rateLimit(`${socket.id}:${bucket}`, rule.limit, rule.windowMs)) return false;
      fail(ack, 'Slow down a moment — too many actions in a row.');
      return true;
    };

    const attach = (room: Room, player: PlayerRecord): void => {
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      void socket.join(room.code);
    };

    /* -------------------------------------------------------- joining -- */

    socket.on('room:create', (payload: unknown, ack: Ack<JoinResult>) => {
      const rule = RATE_LIMITS.join;
      if (!rateLimit(`${socket.id}:join`, rule.limit, rule.windowMs)) {
        reply(ack, { ok: false, error: 'Too many attempts. Wait a minute and try again.' });
        return;
      }
      const name = sanitizeSingleLine((payload as { name?: unknown })?.name, LIMITS.playerName);
      if (!isValidPlayerName(name)) {
        reply(ack, { ok: false, error: 'Enter a player name to join the raid.' });
        return;
      }
      const room = store.create();
      const result = store.addPlayer(room, name, socket.id);
      if (!result.ok) {
        store.delete(room.code);
        reply(ack, { ok: false, error: 'Could not create the room. Try again.' });
        return;
      }
      attach(room, result.player);
      reply(ack, { ok: true, code: room.code, playerId: result.player.id });
      pushState(io, room);
    });

    socket.on('room:join', (payload: unknown, ack: Ack<JoinResult>) => {
      const rule = RATE_LIMITS.join;
      if (!rateLimit(`${socket.id}:join`, rule.limit, rule.windowMs)) {
        reply(ack, { ok: false, error: 'Too many attempts. Wait a minute and try again.' });
        return;
      }
      const data = (payload ?? {}) as { name?: unknown; code?: unknown };
      const name = sanitizeSingleLine(data.name, LIMITS.playerName);
      const code = normalizeRoomCode(data.code);
      if (!isValidPlayerName(name)) {
        reply(ack, { ok: false, error: 'Enter a player name to join the raid.' });
        return;
      }
      const room = store.get(code);
      if (!room) {
        reply(ack, {
          ok: false,
          error: `No dungeon with the code ${code || '—'}. Check the letters and try again.`,
        });
        return;
      }
      const result = store.addPlayer(room, name, socket.id);
      if (!result.ok) {
        const messages: Record<string, string> = {
          'name-taken': `Someone in this room is already called "${name}". Pick another name.`,
          'room-full': 'This dungeon is full.',
        };
        reply(ack, { ok: false, error: messages[result.error] ?? 'Could not join the room.' });
        return;
      }
      attach(room, result.player);
      reply(ack, { ok: true, code: room.code, playerId: result.player.id });
      pushState(io, room);
    });

    socket.on('room:rejoin', (payload: unknown, ack: Ack<JoinResult>) => {
      const data = (payload ?? {}) as { code?: unknown; playerId?: unknown };
      const code = normalizeRoomCode(data.code);
      const playerId = typeof data.playerId === 'string' ? data.playerId : '';
      const room = store.get(code);
      if (!room || !playerId) {
        reply(ack, { ok: false, error: 'That session has expired. Join again with your name.' });
        return;
      }
      const player = store.reattach(room, playerId, socket.id);
      if (!player) {
        reply(ack, { ok: false, error: 'That session has expired. Join again with your name.' });
        return;
      }
      attach(room, player);
      reply(ack, { ok: true, code: room.code, playerId: player.id });
      pushState(io, room);
    });

    /* ------------------------------------------------ character forge -- */

    socket.on('checkin:set', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (limited('text', ack)) return;
      if (found.room.phase !== 'forge') return fail(ack, 'The forge is closed.');

      const validation = validateCheckIn(payload);
      if (!validation.ok) return fail(ack, validation.errors.join(' '));
      found.player.checkIn = validation.value;
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('character:forge', async (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (found.room.phase !== 'forge') return fail(ack, 'The forge is closed.');
      if (!found.player.checkIn) return fail(ack, 'Fill in your check-in first.');

      const rule = RATE_LIMITS.ai;
      if (!rateLimit(`${found.room.code}:ai`, rule.limit, rule.windowMs)) {
        return fail(ack, 'The forge is overheating. Wait a few minutes before generating again.');
      }

      const config = readOpenRouterConfig(process.env, found.room.aiTextModel).config ?? null;
      const withAvatarImage = (payload as { withAvatarImage?: unknown } | null)?.withAvatarImage === true;
      const imageConfig = withAvatarImage ? readOpenRouterImageConfig() : null;
      found.room.generation = {
        busy: true,
        message: imageConfig
          ? `Forging ${found.player.name}'s hero and painting the portrait…`
          : `Forging ${found.player.name}'s hero…`,
      };
      pushState(io, found.room);

      const { characters, note } = await generateCharacters(
        [{ playerName: found.player.name, checkIn: found.player.checkIn }],
        config,
        undefined,
        imageConfig,
      );
      found.player.character = characters[0] ?? null;
      found.player.ready = true;
      found.room.generation = { busy: false, message: note };
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('ai:model:set', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      if (found.room.generation.busy) return fail(ack, 'Wait until the current generation is finished.');
      if (found.room.phase !== 'forge' && found.room.phase !== 'topics') {
        return fail(ack, 'Choose the AI model before the dungeon is generated.');
      }

      const model = sanitizeSingleLine((payload as { model?: unknown })?.model, 120);
      if (!isAllowedOpenRouterModel(model)) {
        return fail(ack, 'That model is not in the server allowlist.');
      }

      found.room.aiTextModel = selectOpenRouterModel(model).id;
      found.room.generation = {
        busy: false,
        message: `AI text model set to ${selectOpenRouterModel(model).label}.`,
      };
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* ---------------------------------------------------- topic forge -- */

    socket.on('topic:add', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (limited('text', ack)) return;
      if (found.room.phase !== 'topics') return fail(ack, 'The topic board is closed.');
      if (topicsOf(found.room, found.player.id).length >= LIMITS.maxTopicsPerPlayer) {
        return fail(ack, `That is already ${LIMITS.maxTopicsPerPlayer} topics. Sharpen them instead.`);
      }

      const validation = validateTopic(payload);
      if (!validation.ok) return fail(ack, validation.errors.join(' '));

      const topic: Topic = { id: `topic-${randomUUID().slice(0, 12)}`, ...validation.value };
      found.room.topics.set(topic.id, topic);
      found.room.topicAuthors.set(topic.id, found.player.id);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('topic:remove', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      const topicId = (payload as { topicId?: unknown })?.topicId;
      if (!isId(topicId)) return fail(ack, 'Unknown topic.');
      if (found.room.topicAuthors.get(topicId) !== found.player.id) {
        return fail(ack, 'You can only remove your own topics.');
      }
      found.room.topics.delete(topicId);
      found.room.topicAuthors.delete(topicId);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('ready:set', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      found.player.ready = Boolean((payload as { ready?: unknown })?.ready);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* ------------------------------------------------ phase switching -- */

    socket.on('phase:topics', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      if (found.room.phase !== 'forge') return fail(ack, 'The party is past the forge already.');
      const forged = [...found.room.players.values()].filter((player) => player.character).length;
      if (forged === 0) return fail(ack, 'Nobody has forged a character yet.');
      found.room.phase = 'topics';
      clearReady(found.room);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('phase:back', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const room = found.room;
      if (room.phase === 'topics') room.phase = 'forge';
      else if (room.phase === 'level') room.phase = 'topics';
      else if (room.phase === 'victory') room.phase = 'level';
      else return fail(ack, 'There is nothing to go back to.');
      reply(ack, { ok: true });
      pushState(io, room);
    });

    socket.on('level:generate', async (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const room = found.room;
      if (room.phase !== 'topics') return fail(ack, 'Level generation happens after the topic forge.');
      if (room.generation.busy) return fail(ack, 'The dungeon is already being summoned.');
      if (room.topics.size < LIMITS.minTopicsToGenerate) {
        return fail(ack, `Collect at least ${LIMITS.minTopicsToGenerate} topics first.`);
      }
      const rule = RATE_LIMITS.ai;
      if (!rateLimit(`${room.code}:ai`, rule.limit, rule.windowMs)) {
        return fail(ack, 'Too many generations in this room. Wait a few minutes.');
      }

      reply(ack, { ok: true });
      room.phase = 'generating';
      room.generation = { busy: true, message: 'Reading the post-its, sharpening their teeth…' };
      pushState(io, room);

      const config = readOpenRouterConfig(process.env, room.aiTextModel).config ?? null;
      const level = await generateLevel(allTopics(room), config);

      room.level = level;
      room.encounter = null;
      room.resolutions = [];
      room.attackCollected = 0;
      room.attackSpent = 0;
      for (const player of room.players.values()) player.lockedEnemyId = null;
      room.generation = { busy: false, message: level.note };
      room.phase = 'level';
      pushState(io, room);
      toast(io, room, level.source === 'ai' ? 'The dungeon has been generated.' : 'Dungeon built by the local generator.');
    });

    socket.on('game:end', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      found.room.encounter = null;
      found.room.phase = 'victory';
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* ------------------------------------------------------- the level -- */

    socket.on('player:move', (payload: unknown) => {
      const found = membership();
      if (!found) return;
      if (found.room.phase !== 'level' || found.room.encounter) return;
      const rule = RATE_LIMITS.action;
      if (!rateLimit(`${socket.id}:move`, rule.limit * 4, rule.windowMs)) return;

      found.player.position = clampPoint(payload);
      const broadcast: MoveBroadcast = {
        playerId: found.player.id,
        position: found.player.position,
      };
      socket.to(found.room.code).emit('player:moved', broadcast);

      const collected = collectNearbyPowerUps(found.room, found.player);
      if (collected.length > 0) {
        pushState(io, found.room);
        for (const powerUp of collected) {
          toast(
            io,
            found.room,
            `${found.player.name} picked up ${powerUp.name} (+${powerUp.attackPoints} attack).`,
          );
        }
      }
    });

    socket.on('enemy:lock', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (limited('action', ack)) return;
      if (found.room.phase !== 'level') return fail(ack, 'There is no dungeon to fight in.');
      const enemyId = (payload as { enemyId?: unknown })?.enemyId;
      if (!isId(enemyId)) return fail(ack, 'Unknown enemy.');

      const outcome = lockOn(found.room, found.player, enemyId);
      if (!outcome.ok) return fail(ack, outcome.error);
      reply(ack, { ok: true });
      pushState(io, found.room);
      if (outcome.opened) {
        toast(io, found.room, found.room.encounter?.story ?? 'The party engages the enemy.');
      }
    });

    socket.on('enemy:unlock', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      clearLock(found.room, found.player);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('encounter:abandon', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (!found.room.encounter) return fail(ack, 'There is no fight running.');
      abandonEncounter(found.room);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('encounter:resolve', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (limited('text', ack)) return;
      const room = found.room;
      if (!room.encounter) return fail(ack, 'There is no fight running.');
      const enemy = findEnemy(room, room.encounter.enemyId);
      if (!enemy) return fail(ack, 'That enemy is gone.');
      const canSubmit = enemy.lockedBy.includes(found.player.id) || room.facilitatorId === found.player.id;
      if (!canSubmit) {
        return fail(ack, 'Only locked players or the facilitator can submit the treatment.');
      }

      const validation = validateTreatment(payload, attackAvailable(room));
      if (!validation.ok) return fail(ack, validation.errors.join(' '));

      const resolution = resolveEnemy(room, enemy, validation.value);
      reply(ack, { ok: true });
      pushState(io, room);
      toast(
        io,
        room,
        resolution.story,
      );
    });

    /* ----------------------------------------------------------- save -- */

    socket.on('save:github', async (_payload: unknown, ack: Ack<SaveResult>) => {
      const found = membership();
      if (!found) {
        reply(ack, { ok: false, error: 'You are not in this room any more.' });
        return;
      }
      // Server-side permission check. Hiding the button is not the control.
      if (found.player.name !== SAVE_PLAYER_NAME) {
        reply(ack, { ok: false, error: `Only the player named ${SAVE_PLAYER_NAME} can save this retro.` });
        return;
      }
      const rule = RATE_LIMITS.save;
      if (!rateLimit(`${found.room.code}:save`, rule.limit, rule.windowMs)) {
        reply(ack, { ok: false, error: 'That save button is smoking. Wait a minute.' });
        return;
      }
      if (found.room.save.status === 'saving') {
        reply(ack, { ok: false, error: 'A save is already in flight.' });
        return;
      }

      const configResult = readGithubConfig();
      if (!configResult.ok || !configResult.config) {
        const message = configResult.message ?? 'GitHub is not configured.';
        found.room.save = { status: 'error', url: null, message };
        pushState(io, found.room);
        reply(ack, { ok: false, error: message });
        return;
      }

      found.room.save = { status: 'saving', url: null, message: 'Carving the tablet…' };
      pushState(io, found.room);

      const now = new Date();
      const model = readOpenRouterConfig(process.env, found.room.aiTextModel).config?.model ?? null;
      const snapshot = buildSnapshot(found.room, now, model);
      const path = buildSavePath(found.room.code, now);
      const result = await commitFile({
        config: configResult.config,
        path,
        message: buildCommitMessage(found.room.code, now),
        content: `${JSON.stringify(snapshot, null, 2)}\n`,
      });

      if (!result.ok || !result.url) {
        const message = result.error ?? 'GitHub did not confirm the commit.';
        found.room.save = { status: 'error', url: null, message };
        pushState(io, found.room);
        reply(ack, { ok: false, error: message });
        return;
      }

      found.room.save = { status: 'saved', url: result.url, message: `Saved as ${path}` };
      pushState(io, found.room);
      reply(ack, { ok: true, url: result.url, path });
    });

    socket.on('save:download', (_payload: unknown, ack: Ack<DownloadResult>) => {
      const found = membership();
      if (!found) {
        reply(ack, { ok: false, error: 'You are not in this room any more.' });
        return;
      }
      if (found.player.name !== SAVE_PLAYER_NAME) {
        reply(ack, { ok: false, error: `Only the player named ${SAVE_PLAYER_NAME} can export this retro.` });
        return;
      }
      const rule = RATE_LIMITS.save;
      if (!rateLimit(`${found.room.code}:download`, rule.limit, rule.windowMs)) {
        reply(ack, { ok: false, error: 'Too many exports in a row. Wait a minute.' });
        return;
      }
      const now = new Date();
      const model = readOpenRouterConfig(process.env, found.room.aiTextModel).config?.model ?? null;
      reply(ack, {
        ok: true,
        filename: buildSavePath(found.room.code, now).split('/').pop() ?? 'retro.json',
        json: `${JSON.stringify(buildSnapshot(found.room, now, model), null, 2)}\n`,
      });
    });

    /* --------------------------------------------------- disconnecting -- */

    socket.on('disconnect', () => {
      const room = store.markDisconnected(socket.id);
      if (!room) return;
      pushState(io, room);
    });
  });
}

export { everyoneReady };

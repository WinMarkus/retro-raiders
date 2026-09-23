import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { LIMITS, TIMER_PRESETS } from '../shared/constants.js';
import type {
  ActionResult,
  DownloadResult,
  Enemy,
  JoinResult,
  MoveBroadcast,
  Proposal,
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
  forceEncounter,
  lockOn,
  resolveEnemy,
} from './game.js';
import { fallbackLevel, generateCharacters, generateLevel } from './generate.js';
import { commitFile, readGithubConfig } from './github.js';
import { generateIdeas, refineIdea } from './ideas.js';
import {
  type OpenRouterConfig,
  isAllowedOpenRouterModel,
  readOpenRouterConfig,
  readOpenRouterImageConfig,
  readOpenRouterStoryConfig,
  selectOpenRouterModel,
} from './openrouter.js';
import { RATE_LIMITS, rateLimit } from './ratelimit.js';
import { buildCommitMessage, buildSavePath, buildSnapshot } from './snapshot.js';
import { isFacilitator, restartCampaign, topicsOf, type PlayerRecord, type Room, type RoomStore } from './state.js';
import { paintBattle } from './art.js';
import { applyPrivateState, applyPublicState, restoredVersion } from './restore.js';
import { generateEncounterStory, generateVictoryStory } from './stories.js';
import { SAVE_PLAYER_NAME, buildState, canRestartCampaign } from './view.js';
import {
  clampPoint,
  isId,
  isValidPlayerName,
  normalizeRoomCode,
  sanitizeSingleLine,
  sanitizeText,
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

const pending = new Map<Room, NodeJS.Timeout>();
const lastSent = new WeakMap<Room, Map<string, string>>();

/**
 * Bursts of actions (seven people forging at once) collapse into one push per
 * room, and a player whose view did not change gets nothing at all. Every push
 * used to rebuild every browser's screen, so this is also what keeps typing
 * from being interrupted.
 */
export function pushState(io: Server, room: Room): void {
  if (pending.has(room)) return;
  const timer = setTimeout(() => {
    pending.delete(room);
    flushState(io, room);
  }, 25);
  timer.unref?.();
  pending.set(room, timer);
}

function flushState(io: Server, room: Room): void {
  let sent = lastSent.get(room);
  if (!sent) {
    sent = new Map();
    lastSent.set(room, sent);
  }
  room.version += 1;
  for (const player of room.players.values()) {
    if (!player.connected || !player.socketId) continue;
    const state = buildState(room, player.id);
    // Compare without the fields that change on every flush by design.
    const signature = JSON.stringify({ ...state, version: 0, serverTime: 0 });
    const key = `${player.id}:${player.socketId}`;
    if (sent.get(key) === signature) continue;
    sent.set(key, signature);
    io.to(player.socketId).emit('state', state);
  }
}

function toast(io: Server, room: Room, message: string): void {
  io.to(room.code).emit('notice', { message });
}

export function registerSocketHandlers(io: Server, store: RoomStore): void {
  io.on('connection', (socket: Socket) => {
    /**
     * One bad payload or a bug in one handler used to take the whole process
     * down, and every room with it. Errors now stay inside the event.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = (event: string, handler: (payload: unknown, ack: any) => unknown): void => {
      socket.on(event, (payload: unknown, ack: unknown) => {
        const safeAck = typeof ack === 'function' ? (ack as Ack<ActionResult>) : undefined;
        const report = (error: unknown): void => {
          console.error(`[socket] ${event} failed:`, error);
          reply(safeAck, { ok: false, error: 'Something went wrong on the server. Try again.' });
        };
        try {
          const result = handler(payload, safeAck);
          if (result instanceof Promise) result.catch(report);
        } catch (error) {
          report(error);
        }
      });
    };

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

    const detachCurrent = (): void => {
      const code = socket.data.roomCode as string | undefined;
      const playerId = socket.data.playerId as string | undefined;
      if (!code || !playerId) return;
      const room = store.get(code);
      const player = room?.players.get(playerId);
      if (room && player) {
        player.connected = false;
        player.socketId = null;
        player.lastSeen = Date.now();
        room.lastActivity = Date.now();
        pushState(io, room);
      }
      void socket.leave(code);
      delete socket.data.roomCode;
      delete socket.data.playerId;
    };

    /** Swaps the local fight intro for a short AI one when it arrives in time. */
    const narrate = async (room: Room): Promise<void> => {
      const encounter = room.encounter;
      const enemy = encounter ? findEnemy(room, encounter.enemyId) : undefined;
      if (!encounter || !enemy) return;
      const story = await generateEncounterStory(room, enemy, readOpenRouterStoryConfig());
      if (room.encounter !== encounter) return;
      encounter.story = story;
      pushState(io, room);
      toast(io, room, story);
    };

    /**
     * Paints the victory scene. Runs in the background: the report is usable
     * straight away and the painting slides in when it is ready (~30-90 s).
     */
    const paint = async (room: Room): Promise<ActionResult> => {
      const config = readOpenRouterImageConfig();
      if (!config) return { ok: false, error: 'Set OPENROUTER_IMAGE_MODEL on the server to paint the battle.' };
      if (room.battleArt.status === 'painting') return { ok: false, error: 'The painters are already at work.' };
      const rule = RATE_LIMITS.art;
      if (!rateLimit(`${room.code}:art`, rule.limit, rule.windowMs)) {
        return { ok: false, error: 'The painters need a break. Try again in a few minutes.' };
      }
      const campaign = room.createdAt;
      const previous = room.battleArt.image;
      room.battleArt = { status: 'painting', image: previous, prompt: null, message: 'The court painters are at work…' };
      pushState(io, room);
      const result = await paintBattle(room, config);
      if (room.createdAt !== campaign) return { ok: false, error: 'The campaign was restarted.' };
      room.battleArt = result.ok
        ? {
            status: 'done',
            image: { dataUrl: result.dataUrl, mediaType: result.mediaType, model: config.model },
            prompt: result.prompt,
            message: null,
          }
        : { status: 'error', image: previous, prompt: result.prompt, message: result.error };
      pushState(io, room);
      if (result.ok) toast(io, room, 'The battle has been painted. Scroll up on the victory report.');
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    };

    /* -------------------------------------------------------- joining -- */

    on('room:create', (payload: unknown, ack: Ack<JoinResult>) => {
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

    on('room:create:fresh', (_payload: unknown, ack: Ack<JoinResult>) => {
      const found = membership();
      if (!found) return reply(ack, { ok: false, error: 'You are not in this room any more.' });
      if (!canRestartCampaign(found.player.name)) {
        return reply(ack, { ok: false, error: 'Only the player named Markus can start a new room.' });
      }

      const name = found.player.name;
      detachCurrent();

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

    on('room:join', (payload: unknown, ack: Ack<JoinResult>) => {
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

    /**
     * Reconnecting browsers send their last copy of the room along. Normally it
     * is ignored; after a server restart it is how the room comes back.
     */
    on('room:rejoin', (payload: unknown, ack: Ack<JoinResult>) => {
      const data = (payload ?? {}) as { code?: unknown; playerId?: unknown; state?: unknown };
      const code = normalizeRoomCode(data.code);
      const playerId = typeof data.playerId === 'string' ? data.playerId : '';
      const copy = typeof data.state === 'object' && data.state !== null ? data.state : null;
      const expired = (reason: 'room-missing' | 'player-missing'): void =>
        reply(ack, { ok: false, error: 'That session has expired. Join again with your name.', reason });

      let room = store.get(code);
      if (!room && copy && code.length === LIMITS.roomCode && isId(playerId)) {
        const rule = RATE_LIMITS.join;
        if (!rateLimit(`${socket.id}:join`, rule.limit, rule.windowMs)) return expired('room-missing');
        room = store.createWithCode(code) ?? undefined;
        if (room) {
          room.restored = true;
          applyPublicState(room, copy);
          if (room.players.size === 0) {
            store.delete(code);
            room = undefined;
          } else {
            console.log(`[restore] room ${code} rebuilt from a client copy (version ${room.version}).`);
          }
        }
      } else if (room?.restored && copy && restoredVersion(copy) > room.version) {
        applyPublicState(room, copy);
      }
      if (!room || !playerId) return expired('room-missing');

      const player = store.reattach(room, playerId, socket.id);
      if (!player) return expired('player-missing');
      if (room.restored && copy) applyPrivateState(room, player, copy);
      attach(room, player);
      reply(ack, { ok: true, code: room.code, playerId: player.id });
      pushState(io, room);
    });

    /* ------------------------------------------------ character forge -- */

    on('checkin:set', (payload: unknown, ack: Ack<ActionResult>) => {
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

    on('character:forge', async (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      const { room, player } = found;
      if (room.phase !== 'forge') return fail(ack, 'The forge is closed.');
      if (!player.checkIn) return fail(ack, 'Fill in your check-in first.');
      if (player.forging) return fail(ack, 'Your hero is already on the anvil.');

      // Per player, not per room: seven people forging at once is the normal case.
      const rule = RATE_LIMITS.forge;
      if (!rateLimit(`${room.code}:${player.id}:forge`, rule.limit, rule.windowMs)) {
        return fail(ack, 'The forge is overheating. Wait a few minutes before re-forging.');
      }

      const config = readOpenRouterConfig(process.env, room.aiTextModel).config ?? null;
      const withAvatarImage = (payload as { withAvatarImage?: unknown } | null)?.withAvatarImage === true;
      const imageConfig = withAvatarImage ? readOpenRouterImageConfig() : null;
      const campaign = room.createdAt;
      player.forging = true;
      pushState(io, room);

      try {
        const { characters, note } = await generateCharacters(
          [{ playerName: player.name, checkIn: player.checkIn }],
          config,
          undefined,
          imageConfig,
        );
        // The campaign may have been restarted while the AI was thinking.
        if (room.createdAt !== campaign || room.phase !== 'forge' || !room.players.has(player.id)) {
          return fail(ack, 'The forge was reset while your hero was being made.');
        }
        player.character = characters[0] ?? null;
        player.ready = true;
        reply(ack, note ? { ok: true, message: `Forged locally: ${note}` } : { ok: true });
      } finally {
        player.forging = false;
        pushState(io, room);
      }
    });

    on('ai:model:set', (payload: unknown, ack: Ack<ActionResult>) => {
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

    on('topic:add', (payload: unknown, ack: Ack<ActionResult>) => {
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

    on('topic:remove', (payload: unknown, ack: Ack<ActionResult>) => {
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

    on('ready:set', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      found.player.ready = Boolean((payload as { ready?: unknown })?.ready);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* ------------------------------------------------ phase switching -- */

    on('phase:topics', (_payload: unknown, ack: Ack<ActionResult>) => {
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

    on('phase:back', (_payload: unknown, ack: Ack<ActionResult>) => {
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

    on('level:generate', async (_payload: unknown, ack: Ack<ActionResult>) => {
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
      const campaign = room.createdAt;
      let level;
      try {
        level = await generateLevel(allTopics(room), config);
      } catch (error) {
        console.error('[level] generation crashed, using the local generator:', error);
        level = fallbackLevel(allTopics(room), 'The AI generator failed, so the dungeon was built locally.');
      }
      if (room.createdAt !== campaign || room.phase !== 'generating') return;

      room.level = level;
      room.encounter = null;
      room.resolutions = [];
      room.attackCollected = 0;
      room.attackSpent = 0;
      for (const player of room.players.values()) player.lockedEnemyId = null;
      room.battleArt = { status: 'idle', image: null, prompt: null, message: null };
      clearReady(room);
      room.generation = { busy: false, message: level.note };
      room.phase = 'level';
      pushState(io, room);
      toast(io, room, level.source === 'ai' ? 'The dungeon has been generated.' : 'Dungeon built by the local generator.');
    });

    on('timer:set', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const minutes = Number((payload as { minutes?: unknown })?.minutes);
      if (minutes === 0) {
        found.room.timer = null;
      } else if (Number.isInteger(minutes) && minutes > 0 && minutes <= LIMITS.maxTimerMinutes) {
        found.room.timer = { endsAt: Date.now() + minutes * 60_000, minutes, phase: found.room.phase };
      } else {
        return fail(ack, `Pick between 1 and ${LIMITS.maxTimerMinutes} minutes, e.g. ${TIMER_PRESETS.join(', ')}.`);
      }
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    on('encounter:extend', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      if (!found.room.encounter) return fail(ack, 'There is no fight running.');
      found.room.encounter.ideasUntil = Math.max(found.room.encounter.ideasUntil, Date.now()) + 60_000;
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    on('game:end', async (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      found.room.encounter = null;
      found.room.phase = 'victory';
      reply(ack, { ok: true });
      pushState(io, found.room);
      // Paint once per raid; going back and ending again keeps the painting.
      if (found.room.battleArt.status === 'idle' && readOpenRouterImageConfig()) await paint(found.room);
    });

    on('art:paint', async (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      if (found.room.phase !== 'victory') return fail(ack, 'The battle is painted on the victory report.');
      reply(ack, await paint(found.room));
    });

    on('campaign:restart', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (!canRestartCampaign(found.player.name)) {
        return fail(ack, 'Only the player named Markus can start a new campaign.');
      }
      restartCampaign(found.room);
      reply(ack, { ok: true });
      pushState(io, found.room);
      toast(io, found.room, 'A new campaign begins. Back to the character forge.');
    });

    /* ------------------------------------------------------- the level -- */

    on('player:move', (payload: unknown) => {
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

    on('enemy:lock', async (payload: unknown, ack: Ack<ActionResult>) => {
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
      if (outcome.opened) await narrate(found.room);
    });

    on('encounter:start', async (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      if (found.room.phase !== 'level') return fail(ack, 'There is no dungeon to fight in.');
      const outcome = forceEncounter(found.room, found.player);
      if (!outcome.ok) return fail(ack, outcome.error);
      reply(ack, { ok: true });
      pushState(io, found.room);
      await narrate(found.room);
    });

    /* ------------------------------------------------------ idea board -- */

    /** Checks that a fight is running and hands back its enemy. */
    const inFight = (ack: Ack<ActionResult>): (Membership & { enemy: Enemy }) | null => {
      const found = membership();
      if (!found) {
        fail(ack, 'You are not in this room any more.');
        return null;
      }
      const enemy = found.room.encounter ? findEnemy(found.room, found.room.encounter.enemyId) : undefined;
      if (!found.room.encounter || !enemy) {
        fail(ack, 'There is no fight running.');
        return null;
      }
      return { ...found, enemy };
    };

    const newProposal = (text: string, source: Proposal['source']): Proposal => ({
      id: `idea-${randomUUID().slice(0, 12)}`,
      text,
      source,
      createdAt: Date.now(),
    });

    on('proposal:submit', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = inFight(ack);
      if (!found) return;
      if (limited('text', ack)) return;
      const encounter = found.room.encounter!;
      const text = sanitizeText((payload as { text?: unknown })?.text, LIMITS.proposalText).replace(/\s+/g, ' ');
      if (text.length < 5) return fail(ack, 'Write a few words for your idea.');

      // One idea per person: sending again edits it instead of adding another.
      const own = encounter.proposals.find((proposal) => found.room.proposalAuthors.get(proposal.id) === found.player.id);
      if (own) {
        own.text = text;
      } else {
        if (encounter.proposals.length >= LIMITS.maxProposals) return fail(ack, 'The idea board is full. Merge or kick some first.');
        const proposal = newProposal(text, 'player');
        encounter.proposals.push(proposal);
        found.room.proposalAuthors.set(proposal.id, found.player.id);
      }
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    on('proposal:remove', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = inFight(ack);
      if (!found) return;
      const proposalId = (payload as { proposalId?: unknown })?.proposalId;
      if (!isId(proposalId)) return fail(ack, 'Unknown idea.');
      const own = found.room.proposalAuthors.get(proposalId) === found.player.id;
      if (!own && !isFacilitator(found.room, found.player.id)) return fail(ack, 'Only the facilitator can kick ideas.');
      const encounter = found.room.encounter!;
      encounter.proposals = encounter.proposals.filter((proposal) => proposal.id !== proposalId);
      found.room.proposalAuthors.delete(proposalId);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    on('proposal:merge', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = inFight(ack);
      if (!found) return;
      if (!isFacilitator(found.room, found.player.id)) return fail(ack, 'Only the facilitator can merge ideas.');
      const data = (payload ?? {}) as { proposalIds?: unknown; text?: unknown };
      const ids = Array.isArray(data.proposalIds) ? data.proposalIds.filter(isId) : [];
      const encounter = found.room.encounter!;
      const picked = encounter.proposals.filter((proposal) => ids.includes(proposal.id));
      if (picked.length < 2) return fail(ack, 'Pick at least two ideas to merge.');
      const text = sanitizeText(data.text, LIMITS.proposalText).replace(/\s+/g, ' ');
      if (text.length < 5) return fail(ack, 'Write the merged idea first.');

      const merged = newProposal(text, 'merged');
      const at = encounter.proposals.indexOf(picked[0]!);
      encounter.proposals = encounter.proposals.filter((proposal) => !picked.includes(proposal));
      encounter.proposals.splice(Math.min(at, encounter.proposals.length), 0, merged);
      for (const proposal of picked) found.room.proposalAuthors.delete(proposal.id);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /** Runs one oracle call with the busy flag, the rate limit and the stale-fight check. */
    const consultOracle = async (
      found: Membership & { enemy: Enemy },
      ack: Ack<ActionResult>,
      work: (config: OpenRouterConfig | null) => Promise<Proposal[]>,
    ): Promise<void> => {
      const room = found.room;
      const encounter = room.encounter!;
      if (encounter.oracleBusy) return fail(ack, 'The oracle is already thinking.');
      if (encounter.proposals.length >= LIMITS.maxProposals) {
        return fail(ack, 'The idea board is full. Merge or kick some first.');
      }
      const rule = RATE_LIMITS.ideas;
      if (!rateLimit(`${room.code}:ideas`, rule.limit, rule.windowMs)) {
        return fail(ack, 'The oracle needs a breather. Try again in a few minutes.');
      }
      encounter.oracleBusy = true;
      pushState(io, room);
      try {
        const config = readOpenRouterConfig(process.env, room.aiTextModel).config ?? null;
        const before = encounter.proposals.length;
        const offered = await work(config);
        if (room.encounter !== encounter) return fail(ack, 'That fight is over.');
        const kept = encounter.proposals.length - before;
        return reply(ack, kept < offered.length ? { ok: true, message: 'The board filled up; some ideas were left out.' } : { ok: true });
      } finally {
        encounter.oracleBusy = false;
        pushState(io, room);
      }
    };

    on('proposal:generate', async (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = inFight(ack);
      if (!found) return;
      await consultOracle(found, ack, async (config) => {
        const encounter = found.room.encounter!;
        const { ideas } = await generateIdeas(found.enemy, encounter.proposals.map((proposal) => proposal.text), config);
        if (found.room.encounter !== encounter) return [];
        const added = ideas.map((idea) => newProposal(idea, 'oracle'));
        encounter.proposals.push(...added.slice(0, Math.max(0, LIMITS.maxProposals - encounter.proposals.length)));
        return added;
      });
    });

    on('proposal:refine', async (payload: unknown, ack: Ack<ActionResult>) => {
      const found = inFight(ack);
      if (!found) return;
      const proposalId = (payload as { proposalId?: unknown })?.proposalId;
      const original = found.room.encounter!.proposals.find((proposal) => proposal.id === proposalId);
      if (!original) return fail(ack, 'That idea is gone.');
      await consultOracle(found, ack, async (config) => {
        const encounter = found.room.encounter!;
        const text = await refineIdea(found.enemy, original.text, config);
        if (found.room.encounter !== encounter || encounter.proposals.length >= LIMITS.maxProposals) return [];
        const refined = newProposal(text, 'refined');
        const at = encounter.proposals.indexOf(original);
        encounter.proposals.splice(at < 0 ? encounter.proposals.length : at + 1, 0, refined);
        return [refined];
      });
    });

    on('enemy:unlock', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      clearLock(found.room, found.player);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    on('encounter:abandon', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (!found.room.encounter) return fail(ack, 'There is no fight running.');
      abandonEncounter(found.room);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    on('encounter:resolve', async (payload: unknown, ack: Ack<ActionResult>) => {
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
      resolution.story = await generateVictoryStory(resolution, readOpenRouterStoryConfig());
      reply(ack, { ok: true });
      pushState(io, room);
      toast(io, room, resolution.story);
    });

    /* ----------------------------------------------------------- save -- */

    on('save:github', async (_payload: unknown, ack: Ack<SaveResult>) => {
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

    on('save:download', (_payload: unknown, ack: Ack<DownloadResult>) => {
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

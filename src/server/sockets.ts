import { randomBytes } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { LIMITS } from '../shared/constants.js';
import type {
  ActionResult,
  Category,
  DownloadResult,
  JoinResult,
  SaveResult,
} from '../shared/types.js';
import {
  allVotesIn,
  allocateForge,
  autoSelectExperiments,
  enterPhase,
  findCard,
  gotoDiscussionCard,
  mergeCards,
  nextPhase,
  previousPhase,
  resetGame,
  resolveBoss,
  setTokens,
  tickDiscussion,
} from './game.js';
import { commitFile, readGithubConfig } from './github.js';
import { RATE_LIMITS, rateLimit } from './ratelimit.js';
import { buildCommitMessage, buildSavePath, buildSnapshot } from './snapshot.js';
import { isFacilitator, type PlayerRecord, type Room, type RoomStore } from './state.js';
import { SAVE_PLAYER_NAME, buildState } from './view.js';
import {
  isCardIndex,
  isCategory,
  isClassId,
  isEnergy,
  isForgePoints,
  isId,
  isTokenAmount,
  isValidPlayerName,
  normalizeRoomCode,
  sanitizeSingleLine,
  sanitizeText,
  validateProposal,
} from './validation.js';

type Ack<T> = ((result: T) => void) | undefined;

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

function pushTick(io: Server, room: Room): void {
  if (!room.discussion) return;
  io.to(room.code).emit('discuss:tick', {
    secondsLeft: room.discussion.secondsLeft,
    running: room.discussion.running,
    index: room.discussion.index,
  });
}

export function startDiscussionClock(io: Server, store: RoomStore): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const room of store.list()) {
      if (!tickDiscussion(room)) continue;
      if (room.discussion && (room.discussion.secondsLeft === 0 || !room.discussion.running)) {
        pushState(io, room);
      } else {
        pushTick(io, room);
      }
    }
  }, 1000);
  timer.unref?.();
  return timer;
}

interface Membership {
  room: Room;
  player: PlayerRecord;
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

    const limited = (
      bucket: keyof typeof RATE_LIMITS,
      ack: Ack<ActionResult>,
    ): boolean => {
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

    /* ------------------------------------------------------------ join -- */

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
        reply(ack, { ok: false, error: `No dungeon with the code ${code || '—'}. Check the letters and try again.` });
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
      if (!room) {
        reply(ack, { ok: false, error: 'That dungeon has closed. Create or join a new room.' });
        return;
      }
      const player = store.reattach(room, playerId, socket.id);
      if (!player) {
        reply(ack, { ok: false, error: 'Your seat in this room expired. Join again with your name.' });
        return;
      }
      attach(room, player);
      reply(ack, { ok: true, code: room.code, playerId: player.id });
      pushState(io, room);
    });

    /* --------------------------------------------------------- phase 1 -- */

    socket.on('player:setClass', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('action', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      const classId = (payload as { classId?: unknown })?.classId;
      if (!isClassId(classId)) return fail(ack, 'Unknown adventurer class.');
      found.player.classId = classId;
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('player:setEnergy', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('action', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      const energy = (payload as { energy?: unknown })?.energy;
      if (!isEnergy(energy)) return fail(ack, 'Energy runs from 1 to 5.');
      found.player.energy = energy;
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* --------------------------------------------------------- phase 2 -- */

    socket.on('draft:set', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('text', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (found.room.phase !== 'pack') return fail(ack, 'The packing phase is closed.');
      if (found.room.ready.has(found.player.id)) {
        return fail(ack, 'You are marked ready. Unready yourself to keep editing.');
      }
      const data = (payload ?? {}) as { category?: unknown; index?: unknown; text?: unknown };
      if (!isCategory(data.category)) return fail(ack, 'Unknown card type.');
      if (!isCardIndex(data.index)) return fail(ack, 'Unknown card slot.');
      const text = sanitizeText(data.text, LIMITS.cardText);
      const draft = found.room.drafts.get(found.player.id);
      if (!draft) return fail(ack, 'Your pack is missing. Reload the page.');
      draft[data.category as Category][data.index as number] = text;
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('ready:set', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('action', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      const ready = (payload as { ready?: unknown })?.ready;
      if (typeof ready !== 'boolean') return fail(ack, 'Invalid ready state.');
      if (ready) found.room.ready.add(found.player.id);
      else found.room.ready.delete(found.player.id);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* --------------------------------------------------------- phase 3 -- */

    socket.on('cards:merge', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('action', ack)) return;
      const found = facilitatorOnly(ack);
      if (!found) return;
      const ids = (payload as { cardIds?: unknown })?.cardIds;
      if (!Array.isArray(ids) || !ids.every(isId)) return fail(ack, 'Invalid rooms selected.');
      const result = mergeCards(found.room, ids as string[]);
      if (!result.ok) return fail(ack, result.error ?? 'Could not merge those rooms.');
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* --------------------------------------------------------- phase 4 -- */

    socket.on('tokens:set', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('action', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (found.room.phase !== 'explore') return fail(ack, 'Token spending is closed.');
      if (found.room.ready.has(found.player.id)) {
        return fail(ack, 'You are marked ready. Unready yourself to move tokens.');
      }
      const data = (payload ?? {}) as { cardId?: unknown; amount?: unknown };
      if (!isId(data.cardId)) return fail(ack, 'Unknown room.');
      if (!isTokenAmount(data.amount)) return fail(ack, 'Spend between 0 and 3 tokens.');
      const result = setTokens(found.room, found.player.id, data.cardId as string, data.amount as number);
      if (!result.ok) return fail(ack, result.error ?? 'Could not spend that token.');
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('tokens:reveal', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      found.room.tokensRevealed = true;
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('card:note', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('text', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      const data = (payload ?? {}) as { cardId?: unknown; text?: unknown };
      if (!isId(data.cardId)) return fail(ack, 'Unknown room.');
      const card = findCard(found.room, data.cardId as string);
      if (!card) return fail(ack, 'That room is not on the map.');
      card.notes = sanitizeText(data.text, LIMITS.noteText);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('discuss:control', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const room = found.room;
      if (!room.discussion) return fail(ack, 'There is nothing to discuss yet.');
      const action = (payload as { action?: unknown })?.action;
      switch (action) {
        case 'start':
          if (room.discussion.secondsLeft <= 0) room.discussion.secondsLeft = room.discussion.durationSec;
          room.discussion.running = true;
          break;
        case 'pause':
          room.discussion.running = false;
          break;
        case 'reset':
          room.discussion.secondsLeft = room.discussion.durationSec;
          room.discussion.running = false;
          break;
        case 'add60':
          room.discussion.secondsLeft = Math.min(room.discussion.secondsLeft + 60, LIMITS.discussionMaxSec);
          break;
        case 'skip':
          gotoDiscussionCard(room, room.discussion.index + 1);
          break;
        case 'previous':
          gotoDiscussionCard(room, room.discussion.index - 1);
          break;
        default:
          return fail(ack, 'Unknown timer control.');
      }
      reply(ack, { ok: true });
      pushState(io, room);
    });

    socket.on('discuss:setDuration', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const room = found.room;
      if (!room.discussion) return fail(ack, 'There is nothing to discuss yet.');
      const seconds = (payload as { seconds?: unknown })?.seconds;
      if (
        typeof seconds !== 'number' ||
        !Number.isInteger(seconds) ||
        seconds < LIMITS.discussionMinSec ||
        seconds > LIMITS.discussionMaxSec
      ) {
        return fail(ack, `Pick between ${LIMITS.discussionMinSec} and ${LIMITS.discussionMaxSec} seconds.`);
      }
      room.discussion.durationSec = seconds;
      room.discussion.secondsLeft = seconds;
      room.discussion.running = false;
      reply(ack, { ok: true });
      pushState(io, room);
    });

    /* --------------------------------------------------------- phase 5 -- */

    socket.on('boss:vote', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('action', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (found.room.phase !== 'boss') return fail(ack, 'The boss vote is closed.');
      if (found.room.boss.revealed) return fail(ack, 'The boss is already decided.');
      const cardId = (payload as { cardId?: unknown })?.cardId;
      if (!isId(cardId) || !found.room.boss.shortlist.includes(cardId as string)) {
        return fail(ack, 'That card is not on the shortlist.');
      }
      found.room.boss.votes.set(found.player.id, cardId as string);
      reply(ack, { ok: true });
      if (allVotesIn(found.room)) resolveBoss(found.room);
      pushState(io, found.room);
    });

    socket.on('boss:resolve', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const result = resolveBoss(found.room);
      if (result.kind === 'empty') return fail(ack, 'Nobody has voted yet.');
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* --------------------------------------------------------- phase 6 -- */

    socket.on('forge:propose', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('text', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (found.room.phase !== 'forge') return fail(ack, 'The forge is cold right now.');
      if (found.room.forge.revealed) return fail(ack, 'Forge points are already revealed.');
      const validation = validateProposal(payload);
      if (!validation.ok) {
        reply(ack, { ok: false, errors: validation.errors, error: validation.errors[0] });
        return;
      }
      const existing = found.room.forge.proposals.find((item) => item.authorId === found.player.id);
      if (existing) {
        Object.assign(existing, validation.value);
      } else {
        found.room.forge.proposals.push({
          id: `p-${randomBytes(6).toString('hex')}`,
          authorId: found.player.id,
          ...validation.value,
        });
      }
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('forge:allocate', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('action', ack)) return;
      const found = membership();
      if (!found) return fail(ack, 'You are not in this room any more.');
      if (found.room.phase !== 'forge') return fail(ack, 'The forge is cold right now.');
      if (found.room.forge.revealed) return fail(ack, 'Forge points are already revealed.');
      const data = (payload ?? {}) as { proposalId?: unknown; points?: unknown };
      if (!isId(data.proposalId)) return fail(ack, 'Unknown experiment.');
      if (!isForgePoints(data.points)) return fail(ack, `Spend between 0 and ${LIMITS.forgePoints} points.`);
      const result = allocateForge(
        found.room,
        found.player.id,
        data.proposalId as string,
        data.points as number,
      );
      if (!result.ok) return fail(ack, result.error ?? 'Could not spend those points.');
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('forge:reveal', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      found.room.forge.revealed = true;
      autoSelectExperiments(found.room);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('forge:toggleSelect', (payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const proposalId = (payload as { proposalId?: unknown })?.proposalId;
      if (!isId(proposalId)) return fail(ack, 'Unknown experiment.');
      const forge = found.room.forge;
      if (!forge.proposals.some((item) => item.id === proposalId)) {
        return fail(ack, 'Unknown experiment.');
      }
      if (forge.selected.includes(proposalId as string)) {
        forge.selected = forge.selected.filter((id) => id !== proposalId);
      } else {
        if (forge.selected.length >= LIMITS.maxSelectedExperiments) {
          return fail(ack, `Carry at most ${LIMITS.maxSelectedExperiments} weapons into the next sprint.`);
        }
        forge.selected.push(proposalId as string);
      }
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('forge:edit', (payload: unknown, ack: Ack<ActionResult>) => {
      if (limited('text', ack)) return;
      const found = facilitatorOnly(ack);
      if (!found) return;
      const data = (payload ?? {}) as { proposalId?: unknown };
      if (!isId(data.proposalId)) return fail(ack, 'Unknown experiment.');
      const proposal = found.room.forge.proposals.find((item) => item.id === data.proposalId);
      if (!proposal) return fail(ack, 'Unknown experiment.');
      const validation = validateProposal(payload);
      if (!validation.ok) {
        reply(ack, { ok: false, errors: validation.errors, error: validation.errors[0] });
        return;
      }
      Object.assign(proposal, validation.value);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* ------------------------------------------------------ facilitator -- */

    socket.on('phase:next', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const target = nextPhase(found.room.phase);
      if (!target) return fail(ack, 'The raid is already over.');
      enterPhase(found.room, target);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('phase:back', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      const target = previousPhase(found.room.phase);
      if (!target) return fail(ack, 'You are at the dungeon entrance already.');
      enterPhase(found.room, target);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('game:start', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      if (found.room.phase !== 'lobby') return fail(ack, 'The raid has already started.');
      enterPhase(found.room, 'adventurer');
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    socket.on('game:reset', (_payload: unknown, ack: Ack<ActionResult>) => {
      const found = facilitatorOnly(ack);
      if (!found) return;
      resetGame(found.room);
      reply(ack, { ok: true });
      pushState(io, found.room);
    });

    /* ----------------------------------------------------------- saving -- */

    socket.on('save:github', async (_payload: unknown, ack: Ack<SaveResult>) => {
      const found = membership();
      if (!found) {
        reply(ack, { ok: false, error: 'You are not in this room any more.' });
        return;
      }
      // Server-side permission check. Hiding the button is not the control.
      if (found.player.name !== SAVE_PLAYER_NAME) {
        reply(ack, { ok: false, error: 'Only the player named Markus can save this retro.' });
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
        found.room.save = { status: 'error', url: null, message: configResult.message ?? 'GitHub is not configured.' };
        pushState(io, found.room);
        reply(ack, { ok: false, error: found.room.save.message ?? 'GitHub is not configured.' });
        return;
      }

      found.room.save = { status: 'saving', url: null, message: 'Carving the tablet…' };
      pushState(io, found.room);

      const now = new Date();
      const snapshot = buildSnapshot(found.room, now);
      const path = buildSavePath(found.room.code, now);
      const result = await commitFile({
        config: configResult.config,
        path,
        message: buildCommitMessage(found.room.code, now),
        content: `${JSON.stringify(snapshot, null, 2)}\n`,
      });

      if (!result.ok || !result.url) {
        found.room.save = { status: 'error', url: null, message: result.error ?? 'GitHub did not confirm the commit.' };
        pushState(io, found.room);
        reply(ack, { ok: false, error: found.room.save.message ?? 'GitHub did not confirm the commit.' });
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
        reply(ack, { ok: false, error: 'Only the player named Markus can export this retro.' });
        return;
      }
      const rule = RATE_LIMITS.save;
      if (!rateLimit(`${found.room.code}:download`, rule.limit, rule.windowMs)) {
        reply(ack, { ok: false, error: 'Too many exports in a row. Wait a minute.' });
        return;
      }
      const now = new Date();
      const snapshot = buildSnapshot(found.room, now);
      reply(ack, {
        ok: true,
        filename: buildSavePath(found.room.code, now).split('/').pop(),
        json: `${JSON.stringify(snapshot, null, 2)}\n`,
      });
    });

    /* ----------------------------------------------------- disconnecting -- */

    socket.on('disconnect', () => {
      const code = socket.data.roomCode as string | undefined;
      const playerId = socket.data.playerId as string | undefined;
      if (!code || !playerId) return;
      const room = store.get(code);
      if (!room) return;
      const player = room.players.get(playerId);
      if (!player || player.socketId !== socket.id) return;
      store.markDisconnected(room, playerId);
      pushState(io, room);
    });
  });
}

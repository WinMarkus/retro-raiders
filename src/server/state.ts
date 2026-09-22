import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CATEGORIES,
  EMPTY_ROOM_TTL_MS,
  LIMITS,
  STALE_ROOM_TTL_MS,
} from '../shared/constants.js';
import type { Category, ClassId, Phase } from '../shared/types.js';

export interface PlayerRecord {
  id: string;
  name: string;
  socketId: string | null;
  connected: boolean;
  classId: ClassId | null;
  energy: number | null;
  joinedAt: number;
  lastSeen: number;
}

export interface CardRecord {
  id: string;
  category: Category;
  /** Merging keeps every original sentence. */
  texts: string[];
  /** Author ids. Server-only. Never leaves this process. */
  authorIds: string[];
  /** Stable source ids so a reopened pack phase can rebuild without losing data. */
  sourceIds: string[];
  notes: string;
  discussed: boolean;
}

export interface ProposalRecord {
  id: string;
  authorId: string;
  title: string;
  description: string;
  signal: string;
  owner: string;
  reviewBy: string;
}

export interface DiscussionRecord {
  order: string[];
  index: number;
  secondsLeft: number;
  running: boolean;
  durationSec: number;
}

export interface BossRecord {
  shortlist: string[];
  votes: Map<string, string>;
  runoff: boolean;
  round: number;
  winnerCardId: string | null;
  title: string | null;
  revealed: boolean;
}

export interface ForgeRecord {
  proposals: ProposalRecord[];
  allocations: Map<string, Map<string, number>>;
  revealed: boolean;
  selected: string[];
}

export interface Room {
  code: string;
  /** Salt that keeps card ids from being traceable back to a player id. */
  secret: string;
  createdAt: number;
  lastActivity: number;
  completedAt: number | null;
  phase: Phase;
  facilitatorId: string | null;
  players: Map<string, PlayerRecord>;
  drafts: Map<string, Record<Category, string[]>>;
  ready: Set<string>;
  cards: CardRecord[];
  tokens: Map<string, Map<string, number>>;
  tokensRevealed: boolean;
  discussion: DiscussionRecord | null;
  boss: BossRecord;
  forge: ForgeRecord;
  save: { status: 'idle' | 'saving' | 'saved' | 'error'; url: string | null; message: string | null };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(exists: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const bytes = randomBytes(LIMITS.roomCode);
    let code = '';
    for (let i = 0; i < LIMITS.roomCode; i += 1) {
      code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    if (!exists(code)) return code;
  }
  throw new Error('Could not generate a free room code');
}

export function emptyDraft(): Record<Category, string[]> {
  const draft = {} as Record<Category, string[]>;
  for (const category of CATEGORIES) {
    draft[category] = new Array(LIMITS.cardsPerCategory).fill('');
  }
  return draft;
}

export function cardIdFor(room: Room, playerId: string, category: Category, index: number): string {
  return createHash('sha256')
    .update(`${room.secret}:${playerId}:${category}:${index}`)
    .digest('hex')
    .slice(0, 12);
}

function newRoom(code: string): Room {
  const now = Date.now();
  return {
    code,
    secret: randomBytes(24).toString('hex'),
    createdAt: now,
    lastActivity: now,
    completedAt: null,
    phase: 'lobby',
    facilitatorId: null,
    players: new Map(),
    drafts: new Map(),
    ready: new Set(),
    cards: [],
    tokens: new Map(),
    tokensRevealed: false,
    discussion: null,
    boss: {
      shortlist: [],
      votes: new Map(),
      runoff: false,
      round: 1,
      winnerCardId: null,
      title: null,
      revealed: false,
    },
    forge: { proposals: [], allocations: new Map(), revealed: false, selected: [] },
    save: { status: 'idle', url: null, message: null },
  };
}

export type JoinError =
  | 'room-not-found'
  | 'name-taken'
  | 'room-full'
  | 'invalid-name'
  | 'player-not-found';

export class RoomStore {
  private rooms = new Map<string, Room>();

  create(): Room {
    const code = generateRoomCode((candidate) => this.rooms.has(candidate));
    const room = newRoom(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  has(code: string): boolean {
    return this.rooms.has(code);
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  get size(): number {
    return this.rooms.size;
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  /** Adds a player. Duplicate names inside a room are rejected, case-insensitively. */
  addPlayer(room: Room, name: string, socketId: string): { ok: true; player: PlayerRecord } | { ok: false; error: JoinError } {
    if (room.players.size >= LIMITS.maxPlayers) return { ok: false, error: 'room-full' };
    const taken = [...room.players.values()].some(
      (player) => player.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) return { ok: false, error: 'name-taken' };

    const now = Date.now();
    const player: PlayerRecord = {
      id: randomUUID(),
      name,
      socketId,
      connected: true,
      classId: null,
      energy: null,
      joinedAt: now,
      lastSeen: now,
    };
    room.players.set(player.id, player);
    room.drafts.set(player.id, emptyDraft());
    room.tokens.set(player.id, new Map());
    room.forge.allocations.set(player.id, new Map());
    if (!room.facilitatorId) room.facilitatorId = player.id;
    room.lastActivity = now;
    return { ok: true, player };
  }

  reattach(room: Room, playerId: string, socketId: string): PlayerRecord | null {
    const player = room.players.get(playerId);
    if (!player) return null;
    player.socketId = socketId;
    player.connected = true;
    player.lastSeen = Date.now();
    room.lastActivity = Date.now();
    if (!room.facilitatorId || !room.players.has(room.facilitatorId)) {
      room.facilitatorId = player.id;
    }
    return player;
  }

  markDisconnected(room: Room, playerId: string): void {
    const player = room.players.get(playerId);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    player.lastSeen = Date.now();
    room.lastActivity = Date.now();
  }

  /** Rooms nobody came back to eventually stop costing memory. */
  sweep(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const room of this.rooms.values()) {
      const connected = [...room.players.values()].some((player) => player.connected);
      const idleFor = now - room.lastActivity;
      const isEmpty = room.players.size === 0 || !connected;
      if ((isEmpty && idleFor > EMPTY_ROOM_TTL_MS) || idleFor > STALE_ROOM_TTL_MS) {
        this.delete(room.code);
        removed.push(room.code);
      }
    }
    return removed;
  }
}

export function isFacilitator(room: Room, playerId: string): boolean {
  return room.facilitatorId === playerId;
}

export function connectedPlayers(room: Room): PlayerRecord[] {
  return [...room.players.values()].filter((player) => player.connected);
}

export function playerByName(room: Room, name: string): PlayerRecord | undefined {
  return [...room.players.values()].find((player) => player.name === name);
}

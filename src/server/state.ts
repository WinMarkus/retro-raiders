import { randomBytes, randomUUID } from 'node:crypto';
import { EMPTY_ROOM_TTL_MS, LIMITS, MAP, STALE_ROOM_TTL_MS } from '../shared/constants.js';
import type {
  CheckIn,
  Character,
  EncounterState,
  Level,
  Phase,
  Point,
  Resolution,
  SaveState,
  Topic,
} from '../shared/types.js';

export interface PlayerRecord {
  id: string;
  name: string;
  socketId: string | null;
  connected: boolean;
  ready: boolean;
  checkIn: CheckIn | null;
  character: Character | null;
  position: Point;
  lockedEnemyId: string | null;
  joinedAt: number;
  lastSeen: number;
}

export interface Room {
  code: string;
  createdAt: number;
  lastActivity: number;
  phase: Phase;
  facilitatorId: string | null;
  players: Map<string, PlayerRecord>;
  /** topicId -> topic. Authorship lives in `topicAuthors`, never in the view. */
  topics: Map<string, Topic>;
  topicAuthors: Map<string, string>;
  level: Level | null;
  encounter: EncounterState | null;
  resolutions: Resolution[];
  attackCollected: number;
  attackSpent: number;
  aiTextModel: string | null;
  generation: { busy: boolean; message: string | null };
  save: SaveState;
}

export type JoinError = 'name-taken' | 'room-full';

/** No O/0/I/1 — people read these out loud over a video call. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(): string {
  const bytes = randomBytes(LIMITS.roomCode);
  let code = '';
  for (let i = 0; i < LIMITS.roomCode; i += 1) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/** Players enter near the bottom of the map, spread out so they do not stack. */
export function spawnPoint(index: number): Point {
  const perRow = 6;
  const column = index % perRow;
  const row = Math.floor(index / perRow);
  return {
    x: MAP.margin + 60 + column * 90,
    y: MAP.height - MAP.margin - row * 60,
  };
}

function emptyRoom(code: string): Room {
  const now = Date.now();
  return {
    code,
    createdAt: now,
    lastActivity: now,
    phase: 'forge',
    facilitatorId: null,
    players: new Map(),
    topics: new Map(),
    topicAuthors: new Map(),
    level: null,
    encounter: null,
    resolutions: [],
    attackCollected: 0,
    attackSpent: 0,
    aiTextModel: null,
    generation: { busy: false, message: null },
    save: { status: 'idle', url: null, message: null },
  };
}

export class RoomStore {
  private rooms = new Map<string, Room>();

  get size(): number {
    return this.rooms.size;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  create(): Room {
    let code = generateRoomCode();
    while (this.rooms.has(code)) code = generateRoomCode();
    const room = emptyRoom(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  addPlayer(
    room: Room,
    name: string,
    socketId: string,
  ): { ok: true; player: PlayerRecord } | { ok: false; error: JoinError } {
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
      ready: false,
      checkIn: null,
      character: null,
      position: spawnPoint(room.players.size),
      lockedEnemyId: null,
      joinedAt: now,
      lastSeen: now,
    };
    room.players.set(player.id, player);
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
    if (!room.facilitatorId) room.facilitatorId = player.id;
    return player;
  }

  markDisconnected(socketId: string): Room | null {
    for (const room of this.rooms.values()) {
      for (const player of room.players.values()) {
        if (player.socketId !== socketId) continue;
        player.connected = false;
        player.socketId = null;
        player.lastSeen = Date.now();
        room.lastActivity = Date.now();
        return room;
      }
    }
    return null;
  }

  /** Drops rooms nobody is coming back to, so memory does not creep. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      const anyConnected = [...room.players.values()].some((player) => player.connected);
      const idleFor = now - room.lastActivity;
      const expired = anyConnected
        ? false
        : room.players.size === 0
          ? idleFor > EMPTY_ROOM_TTL_MS
          : idleFor > STALE_ROOM_TTL_MS;
      if (expired) {
        this.rooms.delete(code);
        removed += 1;
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

export function topicsOf(room: Room, playerId: string): Topic[] {
  return [...room.topics.values()].filter((topic) => room.topicAuthors.get(topic.id) === playerId);
}

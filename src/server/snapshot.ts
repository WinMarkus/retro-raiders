import { APP_NAME, SCHEMA_VERSION } from '../shared/constants.js';
import type {
  Character,
  Enemy,
  Level,
  PowerUp,
  Resolution,
  Summary,
  Topic,
} from '../shared/types.js';
import { buildSummary } from './game.js';
import type { Room } from './state.js';

export interface SnapshotPlayer {
  name: string;
  character: Character | null;
  checkIn: {
    energy: number;
    pressure: number;
    satisfaction: number;
    mood: string;
    keywords: string[];
  } | null;
}

export interface RetroSnapshot {
  app: string;
  schemaVersion: number;
  roomCode: string;
  createdAt: string;
  savedAt: string;
  generatedBy: { characters: string; level: string; model: string | null };
  players: SnapshotPlayer[];
  topics: Topic[];
  level: Level | null;
  enemies: Enemy[];
  powerUps: PowerUp[];
  resolutions: Resolution[];
  attackPoints: { collected: number; spent: number; remaining: number };
  summary: Summary;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * UTC on purpose: a distributed team saving from three timezones should still
 * get files that sort correctly next to each other.
 */
export function buildSavePath(roomCode: string, now: Date): string {
  const code = (roomCode || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'UNKNOWN';
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(
    now.getUTCHours(),
  )}-${pad(now.getUTCMinutes())}`;
  return `retro-saves/retro-raiders/${stamp}_room-${code}.json`;
}

export function buildCommitMessage(roomCode: string, now: Date): string {
  return `Retro Raiders: room ${roomCode} — ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Nothing internal leaves the server: no socket ids, no player ids, and no
 * mapping from a person to a topic. Names appear because everyone in the room
 * already saw who was there; the post-its stay anonymous.
 */
export function buildSnapshot(room: Room, now: Date, model: string | null = null): RetroSnapshot {
  const players: SnapshotPlayer[] = [...room.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => ({
      name: player.name,
      character: player.character,
      checkIn: player.checkIn
        ? {
            energy: player.checkIn.energy,
            pressure: player.checkIn.pressure,
            satisfaction: player.checkIn.satisfaction,
            mood: player.checkIn.mood,
            keywords: [...player.checkIn.keywords],
          }
        : null,
    }));

  return {
    app: APP_NAME,
    schemaVersion: SCHEMA_VERSION,
    roomCode: room.code,
    createdAt: new Date(room.createdAt).toISOString(),
    savedAt: now.toISOString(),
    generatedBy: {
      characters: players.some((player) => player.character?.source === 'ai') ? 'ai' : 'fallback',
      level: room.level?.source ?? 'none',
      model,
    },
    players,
    topics: [...room.topics.values()],
    level: room.level,
    enemies: room.level?.enemies ?? [],
    powerUps: room.level?.powerUps ?? [],
    resolutions: room.resolutions,
    attackPoints: {
      collected: room.attackCollected,
      spent: room.attackSpent,
      remaining: Math.max(0, room.attackCollected - room.attackSpent),
    },
    summary: buildSummary(room),
  };
}

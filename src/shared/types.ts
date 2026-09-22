/** Types shared by the server and the browser build. */

export type Phase = 'forge' | 'topics' | 'generating' | 'level' | 'victory';

export type TopicType = 'good' | 'bad' | 'sad';

export type EnemyStatus = 'active' | 'locked' | 'frozen' | 'resolved';

export type EnemyKind = 'minion' | 'trap' | 'curse' | 'miniboss' | 'boss';

export interface Point {
  x: number;
  y: number;
}

/** What a player says about the last two weeks, before any AI is involved. */
export interface CheckIn {
  energy: number;
  pressure: number;
  satisfaction: number;
  mood: string;
  keywords: string[];
}

export interface Character {
  playerName: string;
  characterName: string;
  className: string;
  description: string;
  skill: string;
  weakness: string;
  attack: number;
  support: number;
  avatarPrompt: string;
  /** Emoji portrait, chosen deterministically so no image API is needed. */
  emoji: string;
  /** Hue used for the CSS avatar card, 0-359. */
  hue: number;
  source: 'ai' | 'fallback';
}

export interface Topic {
  id: string;
  type: TopicType;
  title: string;
  description: string;
  intensity: number;
}

export interface Enemy {
  id: string;
  name: string;
  kind: EnemyKind;
  description: string;
  sourceTopics: string[];
  strength: number;
  position: Point;
  status: EnemyStatus;
  lockedBy: string[];
}

export interface PowerUp {
  id: string;
  name: string;
  description: string;
  sourceTopics: string[];
  attackPoints: number;
  position: Point;
  collectedBy: string | null;
}

export interface Level {
  title: string;
  intro: string;
  enemies: Enemy[];
  powerUps: PowerUp[];
  source: 'ai' | 'fallback';
  generatedAt: number;
  note: string | null;
}

export interface Resolution {
  enemyId: string;
  enemyName: string;
  treatment: string;
  owner: string | null;
  reviewBy: string;
  attackSpent: number;
  party: string[];
  resolvedAt: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  isFacilitator: boolean;
  ready: boolean;
  topicCount: number;
  character: Character | null;
  position: Point;
  lockedEnemyId: string | null;
}

export interface EncounterState {
  enemyId: string;
  openedAt: number;
  party: string[];
}

export interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error';
  url: string | null;
  message: string | null;
}

export interface SummaryEntry {
  title: string;
  value: string;
}

export interface Summary {
  headline: string;
  stats: SummaryEntry[];
  resolved: Resolution[];
  unresolved: Enemy[];
  actionItems: string[];
}

/** The per-player view of a room. Never contains authorship of a topic. */
export interface GameState {
  code: string;
  phase: Phase;
  you: {
    id: string;
    name: string;
    isFacilitator: boolean;
    ready: boolean;
    checkIn: CheckIn | null;
    character: Character | null;
    topics: Topic[];
    lockedEnemyId: string | null;
  };
  players: PublicPlayer[];
  topicCount: number;
  level: Level | null;
  attack: {
    available: number;
    spent: number;
    collected: number;
  };
  encounter: EncounterState | null;
  resolutions: Resolution[];
  summary: Summary | null;
  save: SaveState;
  generation: {
    busy: boolean;
    message: string | null;
    aiConfigured: boolean;
  };
  githubConfigured: boolean;
  canSave: boolean;
}

export type JoinResult =
  | { ok: true; code: string; playerId: string }
  | { ok: false; error: string };

export type ActionResult = { ok: true } | { ok: false; error: string };

export type SaveResult =
  | { ok: true; url: string; path: string }
  | { ok: false; error: string };

export type DownloadResult =
  | { ok: true; filename: string; json: string }
  | { ok: false; error: string };

/** Lightweight movement broadcast, sent instead of a full state push. */
export interface MoveBroadcast {
  playerId: string;
  position: Point;
}

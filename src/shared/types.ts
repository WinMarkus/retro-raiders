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
  avatarImage: {
    dataUrl: string;
    mediaType: string;
    model: string;
    cost: number | null;
  } | null;
  /** Emoji portrait, chosen deterministically so no image API is needed. */
  emoji: string;
  /** Hue used for the CSS avatar card, 0-359. */
  hue: number;
  source: 'ai' | 'fallback';
}

/**
 * What travels to browsers: the portrait is a URL served over plain HTTP (and
 * cached), never the multi-megabyte data URL that used to ride on every push.
 */
export type PublicCharacter = Omit<Character, 'avatarImage'> & { avatarUrl: string | null };

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
  story: string;
  treatment: string;
  owner: string | null;
  reviewBy: string;
  attackSpent: number;
  party: string[];
  /** The other ideas the party put on the table for this enemy. */
  alternatives?: string[];
  resolvedAt: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  isFacilitator: boolean;
  ready: boolean;
  topicCount: number;
  character: PublicCharacter | null;
  /** True while this player's hero is being generated. */
  forging: boolean;
  position: Point;
  lockedEnemyId: string | null;
}

export type ProposalSource = 'player' | 'oracle' | 'merged' | 'refined';

/** One idea for beating the enemy. Who wrote it stays on the server. */
export interface Proposal {
  id: string;
  text: string;
  source: ProposalSource;
  createdAt: number;
}

export interface EncounterState {
  enemyId: string;
  openedAt: number;
  party: string[];
  story: string;
  proposals: Proposal[];
  /** Soft deadline for collecting ideas; nothing is blocked when it passes. */
  ideasUntil: number;
  /** True while the AI oracle is thinking up or refining ideas. */
  oracleBusy: boolean;
}

/**
 * The victory painting: one generated battle scene of the whole party. The
 * image itself is served over HTTP; only its URL travels in the state.
 */
export interface BattleArt {
  status: 'idle' | 'painting' | 'done' | 'error' | 'unavailable';
  url: string | null;
  message: string | null;
}

/** Facilitator-set soft timer for the current phase. Never enforced. */
export interface PhaseTimer {
  endsAt: number;
  minutes: number;
  phase: Phase;
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

export interface AiModelOption {
  id: string;
  label: string;
}

/** The per-player view of a room. Never contains authorship of a topic. */
export interface GameState {
  code: string;
  /** Changes on every campaign restart, so clients know to drop their drafts. */
  campaignId: number;
  /** Monotonic per room; lets a restarted server pick the freshest client copy. */
  version: number;
  phase: Phase;
  you: {
    id: string;
    name: string;
    isFacilitator: boolean;
    ready: boolean;
    checkIn: CheckIn | null;
    character: PublicCharacter | null;
    forging: boolean;
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
  encounter: (EncounterState & { mine: string | null }) | null;
  resolutions: Resolution[];
  /** Every topic on the board, without authors. Only during the topic forge. */
  board: Topic[];
  timer: PhaseTimer | null;
  /** Server clock at send time, so countdowns ignore a skewed laptop clock. */
  serverTime: number;
  summary: Summary | null;
  save: SaveState;
  generation: {
    busy: boolean;
    message: string | null;
    aiConfigured: boolean;
    textModel: string;
    textModelLabel: string;
    textModelOptions: AiModelOption[];
    avatarImages: 'local-css' | 'openrouter-image';
    imageModel: string | null;
  };
  battleArt: BattleArt;
  githubConfigured: boolean;
  canSave: boolean;
  canRestartCampaign: boolean;
  canStartNewRoom: boolean;
}

export type JoinResult =
  | { ok: true; code: string; playerId: string }
  | { ok: false; error: string; reason?: 'room-missing' | 'player-missing' };

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/**
 * Everything one browser knows about its room. After a server restart the
 * clients send this back and the room is rebuilt from their combined copies.
 */
export interface RestorePayload {
  code: string;
  playerId: string;
  state: GameState;
}

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

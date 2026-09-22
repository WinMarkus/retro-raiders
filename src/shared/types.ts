/**
 * Types shared by the server and the browser client.
 * Nothing in here ever carries the author of a card.
 */

export type Category = 'loot' | 'trap' | 'monster';

export type Phase =
  | 'lobby'
  | 'adventurer'
  | 'pack'
  | 'reveal'
  | 'explore'
  | 'discuss'
  | 'boss'
  | 'forge'
  | 'victory';

export type ClassId =
  | 'debugger'
  | 'architect'
  | 'test-mage'
  | 'deployment-ranger'
  | 'product-bard'
  | 'refactor-paladin';

export interface AdventurerClass {
  id: ClassId;
  name: string;
  emoji: string;
  tagline: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  isFacilitator: boolean;
  classId: ClassId | null;
  energy: number | null;
  ready: boolean;
}

export interface PublicCard {
  id: string;
  category: Category;
  texts: string[];
  merged: boolean;
  notes: string;
  /** Total tokens spent by the whole party, or null while totals are hidden. */
  tokens: number | null;
  /** Tokens the receiving player spent on this card. */
  myTokens: number;
  discussed: boolean;
}

export interface PublicProposal {
  id: string;
  authorName: string;
  title: string;
  description: string;
  signal: string;
  owner: string;
  reviewBy: string;
  /** Total forge points, or null while totals are hidden. */
  points: number | null;
  myPoints: number;
  selected: boolean;
}

export interface DiscussionState {
  order: string[];
  index: number;
  secondsLeft: number;
  running: boolean;
  durationSec: number;
}

export interface BossState {
  shortlist: string[];
  myVote: string | null;
  votedPlayerIds: string[];
  runoff: boolean;
  round: number;
  winnerCardId: string | null;
  title: string | null;
  revealed: boolean;
}

export interface ForgeState {
  pointsPerPlayer: number;
  revealed: boolean;
  myProposalId: string | null;
  proposedPlayerIds: string[];
  allocatedPlayerIds: string[];
  proposals: PublicProposal[];
  selected: string[];
}

export interface TokenState {
  perPlayer: number;
  revealed: boolean;
  spentByPlayer: Record<string, number>;
  myRemaining: number;
}

export interface SummaryExperiment {
  title: string;
  description: string;
  signal: string;
  owner: string;
  reviewBy: string;
  points: number;
  selected: boolean;
}

export interface SummaryCard {
  id: string;
  category: Category;
  texts: string[];
  merged: boolean;
  tokens: number;
  notes: string;
  discussed: boolean;
}

export interface Summary {
  participants: string[];
  averageEnergy: number | null;
  energyResponses: number;
  loot: SummaryCard[];
  traps: SummaryCard[];
  monsters: SummaryCard[];
  discussed: SummaryCard[];
  boss: { title: string; category: Category; texts: string[]; votes: number } | null;
  experiments: SummaryExperiment[];
}

export interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error';
  url: string | null;
  message: string | null;
}

export interface GameState {
  code: string;
  phase: Phase;
  you: { id: string; name: string; isFacilitator: boolean };
  players: PublicPlayer[];
  readyPlayerIds: string[];
  myReady: boolean;
  myDraft: Record<Category, string[]>;
  cards: PublicCard[];
  tokens: TokenState;
  discussion: DiscussionState | null;
  boss: BossState;
  forge: ForgeState;
  summary: Summary | null;
  canSaveToGithub: boolean;
  githubConfigured: boolean;
  save: SaveState;
  createdAt: number;
  completedAt: number | null;
}

export interface JoinResult {
  ok: boolean;
  code?: string;
  playerId?: string;
  error?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  errors?: string[];
}

export interface SaveResult {
  ok: boolean;
  url?: string;
  path?: string;
  error?: string;
}

export interface DownloadResult {
  ok: boolean;
  filename?: string;
  json?: string;
  error?: string;
}

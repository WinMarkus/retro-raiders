import type { AdventurerClass, Category, Phase } from './types.js';

export const APP_NAME = 'Retro Raiders: The Blocker Dungeon';
export const SCHEMA_VERSION = 1;

export const ADVENTURER_CLASSES: AdventurerClass[] = [
  { id: 'debugger', name: 'Debugger', emoji: '🔦', tagline: 'Walks into the stack trace, not away from it.' },
  { id: 'architect', name: 'Architect', emoji: '📐', tagline: 'Draws the map three sprints before anyone needs it.' },
  { id: 'test-mage', name: 'Test Mage', emoji: '🧪', tagline: 'Banishes flaky specs with a single incantation.' },
  { id: 'deployment-ranger', name: 'Deployment Ranger', emoji: '🏹', tagline: 'Ships on Friday and lives to tell it.' },
  { id: 'product-bard', name: 'Product Bard', emoji: '🎻', tagline: 'Turns scope creep into a song everyone hums.' },
  { id: 'refactor-paladin', name: 'Refactor Paladin', emoji: '🛡️', tagline: 'Smites duplicated code wherever it hides.' },
];

export const CATEGORIES: Category[] = ['loot', 'trap', 'monster'];

export const CATEGORY_META: Record<Category, { label: string; plural: string; emoji: string; prompt: string; room: string }> = {
  loot: {
    label: 'Loot',
    plural: 'Loot',
    emoji: '💰',
    prompt: 'Something that helped or went well',
    room: 'Treasure room',
  },
  trap: {
    label: 'Trap',
    plural: 'Traps',
    emoji: '🕳️',
    prompt: 'Something that slowed the team down',
    room: 'Hazard room',
  },
  monster: {
    label: 'Monster',
    plural: 'Monsters',
    emoji: '🐉',
    prompt: 'A recurring or substantial problem',
    room: 'Enemy room',
  },
};

export const PHASES: Phase[] = [
  'lobby',
  'adventurer',
  'pack',
  'reveal',
  'explore',
  'discuss',
  'boss',
  'forge',
  'victory',
];

export const PHASE_META: Record<Phase, { title: string; step: string; blurb: string }> = {
  lobby: { title: 'Gather the party', step: 'Lobby', blurb: 'Share the room code and wait for the raiders.' },
  adventurer: { title: 'Choose an adventurer', step: 'Phase 1', blurb: 'Pick a class and tell the party how much energy you brought.' },
  pack: { title: 'Pack the dungeon', step: 'Phase 2', blurb: 'Write your loot, traps and monsters. Nobody sees them yet.' },
  reveal: { title: 'Reveal the dungeon', step: 'Phase 3', blurb: 'The rooms are shuffled and anonymous. Merge the duplicates.' },
  explore: { title: 'Explore', step: 'Phase 4', blurb: 'Spend three energy tokens on the rooms that mattered.' },
  discuss: { title: 'Explore: the deep rooms', step: 'Phase 4', blurb: 'One room at a time, on the clock, with shared notes.' },
  boss: { title: 'Final boss', step: 'Phase 5', blurb: 'Vote for the one thing worth fighting next.' },
  forge: { title: 'Forge the weapons', step: 'Phase 6', blurb: 'One small experiment each, then spend your forge points.' },
  victory: { title: 'Victory', step: 'Phase 7', blurb: 'What the raid found, decided and promised.' },
};

export const LIMITS = {
  playerName: 24,
  roomCode: 6,
  cardText: 220,
  noteText: 600,
  proposalTitle: 80,
  proposalDescription: 300,
  proposalSignal: 200,
  proposalOwner: 40,
  proposalReview: 40,
  cardsPerCategory: 2,
  maxPlayers: 16,
  tokensPerPlayer: 3,
  maxTokensPerCard: 3,
  forgePoints: 10,
  discussionDefaultSec: 180,
  discussionMinSec: 30,
  discussionMaxSec: 900,
  shortlistSize: 5,
  maxSelectedExperiments: 2,
  discussTopCards: 6,
} as const;

/** Titles that say nothing. The forge rejects them. */
export const VAGUE_TITLE_PATTERNS: string[] = [
  'communicate better',
  'better communication',
  'improve communication',
  'more communication',
  'work harder',
  'try harder',
  'do better',
  'be better',
  'more focus',
  'focus more',
  'be more agile',
  'improve quality',
  'more quality',
  'less bugs',
  'fewer bugs',
  'improve process',
  'better process',
  'more teamwork',
  'collaborate more',
];

export const RECONNECT_GRACE_MS = 1000 * 60 * 30;
export const EMPTY_ROOM_TTL_MS = 1000 * 60 * 15;
export const STALE_ROOM_TTL_MS = 1000 * 60 * 60 * 8;

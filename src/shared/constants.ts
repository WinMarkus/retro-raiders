import type { Phase, TopicType } from './types.js';

export const APP_NAME = 'Retro Raiders: The Blocker Dungeon';
export const SCHEMA_VERSION = 2;

export const PHASES: Phase[] = ['forge', 'topics', 'generating', 'level', 'victory'];

export const PHASE_LABEL: Record<Phase, string> = {
  forge: 'Character Forge',
  topics: 'Topic Forge',
  generating: 'Summoning the dungeon',
  level: 'The Dungeon',
  victory: 'Victory Report',
};

export const TOPIC_TYPES: TopicType[] = ['good', 'bad', 'sad'];

export const TOPIC_META: Record<TopicType, { label: string; hint: string; icon: string }> = {
  good: {
    label: 'Good',
    hint: 'Helped us, gave energy, should stay',
    icon: '✨',
  },
  bad: {
    label: 'Bad',
    hint: 'Blockers, friction, repeated pain',
    icon: '🔥',
  },
  sad: {
    label: 'Sad',
    hint: 'Draining, unclear, demotivating',
    icon: '🌫️',
  },
};

/** Map coordinate space. The client scales this to whatever it has room for. */
export const MAP = {
  width: 1000,
  height: 640,
  margin: 60,
  playerRadius: 18,
  interactRadius: 70,
} as const;

export const LIMITS = {
  playerName: 24,
  roomCode: 6,
  maxPlayers: 12,
  moodText: 280,
  keyword: 24,
  maxKeywords: 5,
  topicTitle: 90,
  topicDescription: 240,
  maxTopicsPerPlayer: 6,
  minTopicsToGenerate: 3,
  treatmentText: 500,
  ownerText: 60,
  reviewByText: 40,
  minEnemies: 3,
  maxEnemies: 8,
  maxPowerUps: 8,
  maxAttackPerEnemy: 12,
  scaleMin: 1,
  scaleMax: 5,
} as const;

export const EMPTY_ROOM_TTL_MS = 1000 * 60 * 15;
export const STALE_ROOM_TTL_MS = 1000 * 60 * 60 * 8;

/** Titles that say nothing. Rejected on the treatment form. */
export const VAGUE_TREATMENTS = [
  /^communicate better\.?$/i,
  /^do better\.?$/i,
  /^try harder\.?$/i,
  /^more focus\.?$/i,
  /^improve\.?$/i,
];

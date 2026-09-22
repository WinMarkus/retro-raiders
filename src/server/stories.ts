import type { Enemy, Resolution } from '../shared/types.js';
import { complete, extractJson, type OpenRouterStoryConfig } from './openrouter.js';
import type { Room } from './state.js';
import { encounterStory, partyLine, victoryStory } from './game.js';
import { sanitizeText } from './validation.js';

const STORY_TIMEOUT_MS = 4_500;

const STORY_SYSTEM = [
  'You write very short D&D-style narration for a software team retrospective game.',
  'Answer with JSON only, no markdown.',
  'Shape: {"story":"..."}',
  'Write 1-2 sentences, max 55 words.',
  'Tone: playful, fantasy adventure, concrete, energizing.',
  'Never blame a person. Never invent actions, owners, or dates.',
  'No markdown, no bullet points, no quotes around names inside the story.',
].join(' ');

function cleanStory(value: unknown, fallback: string): string {
  const story = sanitizeText(value, 420)
    .replace(/\s+/g, ' ')
    .trim();
  if (!story) return fallback;
  return story.length > 360 ? `${story.slice(0, 357).trim()}...` : story;
}

export async function generateEncounterStory(
  room: Room,
  enemy: Enemy,
  config: OpenRouterStoryConfig | null,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const fallback = encounterStory(room, enemy);
  if (!config) return fallback;

  const user = JSON.stringify({
    moment: 'fight_start',
    enemy: {
      name: enemy.name,
      kind: enemy.kind,
      strength: enemy.strength,
      description: enemy.description,
      sourceTopics: enemy.sourceTopics,
    },
    fighters: enemy.lockedBy
      .map((id) => room.players.get(id))
      .filter(Boolean)
      .map((player) => ({
        playerName: player!.name,
        characterName: player!.character?.characterName,
        className: player!.character?.className,
        skill: player!.character?.skill,
      })),
    partyLine: partyLine(room, enemy.lockedBy),
  });

  const result = await complete({
    config,
    system: STORY_SYSTEM,
    user,
    maxTokens: 140,
    timeoutMs: STORY_TIMEOUT_MS,
    fetchImpl,
  });
  if (!result.ok) return fallback;

  const parsed = extractJson(result.content) as { story?: unknown } | null;
  return cleanStory(parsed?.story, fallback);
}

export async function generateVictoryStory(
  resolution: Resolution,
  config: OpenRouterStoryConfig | null,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const fallback = victoryStory(resolution);
  if (!config) return fallback;

  const user = JSON.stringify({
    moment: 'fight_resolved',
    enemyName: resolution.enemyName,
    treatment: resolution.treatment,
    owner: resolution.owner,
    reviewBy: resolution.reviewBy,
    attackSpent: resolution.attackSpent,
    fighters: resolution.party,
  });

  const result = await complete({
    config,
    system: STORY_SYSTEM,
    user,
    maxTokens: 140,
    timeoutMs: STORY_TIMEOUT_MS,
    fetchImpl,
  });
  if (!result.ok) return fallback;

  const parsed = extractJson(result.content) as { story?: unknown } | null;
  return cleanStory(parsed?.story, fallback);
}

import { describe, expect, it, vi } from 'vitest';
import { LIMITS, MAP } from '../src/shared/constants.js';
import type { Topic } from '../src/shared/types.js';
import {
  clusterTopics,
  fallbackCharacter,
  fallbackLevel,
  generateCharacters,
  generateLevel,
  sanitizeLevel,
} from '../src/server/generate.js';
import type { OpenRouterConfig } from '../src/server/openrouter.js';

let counter = 0;
function topic(partial: Partial<Topic> & { title: string }): Topic {
  counter += 1;
  return {
    id: `topic-${counter}`,
    type: 'bad',
    description: '',
    intensity: 3,
    ...partial,
  };
}

const config: OpenRouterConfig = {
  apiKey: 'sk-test-key',
  model: 'test/model',
  modelLabel: 'Test model',
  referer: 'https://example.test',
  title: 'test',
};

const imageConfig = {
  apiKey: 'sk-test-key',
  model: 'openai/gpt-image-2',
};

function aiResponse(payload: unknown): typeof fetch {
  return vi.fn(async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      text: async () => '',
    }) as unknown as Response,
  ) as unknown as typeof fetch;
}

function aiAndImageResponse(payload: unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/images')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }],
          usage: { cost: 0.006 },
        }),
        text: async () => '',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('topic clustering', () => {
  it('folds three reports of the same problem into one cluster', () => {
    const topics = [
      topic({ title: 'Review takes too long' }),
      topic({ title: 'PRs stuck in review for days' }),
      topic({ title: 'review bottleneck again' }),
      topic({ title: 'The staging database keeps dying' }),
    ];
    const clusters = clusterTopics(topics);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.topics).toHaveLength(3);
  });

  it('keeps unrelated topics apart', () => {
    const topics = [
      topic({ title: 'Flaky payment tests' }),
      topic({ title: 'Nobody knows who owns the billing service' }),
      topic({ title: 'Too many meetings on Tuesday' }),
    ];
    expect(clusterTopics(topics)).toHaveLength(3);
  });
});

describe('fallback level', () => {
  it('turns bad and sad topics into enemies and good ones into power-ups', () => {
    const topics = [
      topic({ title: 'Review takes too long', intensity: 5 }),
      topic({ title: 'PRs stuck in review', intensity: 4 }),
      topic({ title: 'Deploys fail on Friday', type: 'sad', intensity: 4 }),
      topic({ title: 'Pair programming helped a lot', type: 'good', intensity: 5 }),
    ];
    const level = fallbackLevel(topics);

    expect(level.source).toBe('fallback');
    expect(level.enemies.length).toBeGreaterThan(0);
    expect(level.enemies.length).toBeLessThanOrEqual(LIMITS.maxEnemies);
    expect(level.powerUps).toHaveLength(1);
    expect(level.powerUps[0]!.attackPoints).toBeGreaterThan(0);

    const enemyTopics = level.enemies.flatMap((enemy) => enemy.sourceTopics);
    expect(enemyTopics).not.toContain('Pair programming helped a lot');
  });

  it('makes a repeated problem stronger than a one-off', () => {
    const repeated = fallbackLevel([
      topic({ title: 'Review takes too long', intensity: 4 }),
      topic({ title: 'review is a bottleneck', intensity: 4 }),
      topic({ title: 'PR review waits overnight', intensity: 4 }),
    ]);
    const single = fallbackLevel([topic({ title: 'Coffee machine broke', intensity: 2 })]);
    expect(repeated.enemies[0]!.strength).toBeGreaterThan(single.enemies[0]!.strength);
  });

  it('keeps the original wording of every source topic', () => {
    const level = fallbackLevel([
      topic({ title: 'Review takes too long' }),
      topic({ title: 'PRs stuck in review' }),
    ]);
    expect(level.enemies[0]!.sourceTopics).toEqual(['Review takes too long', 'PRs stuck in review']);
  });

  it('places everything inside the map', () => {
    const level = fallbackLevel([
      topic({ title: 'Flaky tests' }),
      topic({ title: 'Unclear ownership' }),
      topic({ title: 'Pairing was great', type: 'good' }),
    ]);
    for (const thing of [...level.enemies, ...level.powerUps]) {
      expect(thing.position.x).toBeGreaterThanOrEqual(0);
      expect(thing.position.x).toBeLessThanOrEqual(MAP.width);
      expect(thing.position.y).toBeGreaterThanOrEqual(0);
      expect(thing.position.y).toBeLessThanOrEqual(MAP.height);
    }
  });

  it('survives a dungeon with nothing in it', () => {
    const level = fallbackLevel([]);
    expect(level.enemies).toEqual([]);
    expect(level.powerUps).toEqual([]);
    expect(level.intro.length).toBeGreaterThan(0);
  });
});

describe('AI output is never trusted', () => {
  const topics = [
    topic({ title: 'Review takes too long' }),
    topic({ title: 'Pairing helped', type: 'good' }),
  ];

  it('clamps numbers, strips markup and recomputes positions', () => {
    const level = sanitizeLevel(
      {
        title: '<b>Dungeon</b>',
        intro: 'Down we go',
        enemies: [
          {
            name: '<script>alert(1)</script>The Review Hydra',
            kind: 'dragon-god',
            description: 'Many heads',
            sourceTopics: ['Review takes too long'],
            strength: 99,
            position: { x: -5000, y: 99999 },
          },
        ],
        powerUps: [
          {
            name: 'Potion of Pairing',
            description: 'Nice',
            sourceTopics: ['Pairing helped'],
            attackPoints: 500,
          },
        ],
      },
      topics,
    );

    expect(level).not.toBeNull();
    const enemy = level!.enemies[0]!;
    expect(enemy.name).not.toContain('<');
    expect(enemy.strength).toBeLessThanOrEqual(5);
    expect(enemy.kind).not.toBe('dragon-god');
    expect(enemy.position.x).toBeLessThanOrEqual(MAP.width);
    expect(enemy.position.y).toBeLessThanOrEqual(MAP.height);
    expect(level!.powerUps[0]!.attackPoints).toBeLessThanOrEqual(6);
    expect(level!.title).not.toContain('<');
  });

  it('drops entries whose source topics were invented', () => {
    const level = sanitizeLevel(
      {
        enemies: [
          { name: 'Ghost Enemy', sourceTopics: ['something nobody said'], strength: 3 },
          { name: 'The Review Hydra', sourceTopics: ['Review takes too long'], strength: 3 },
        ],
        powerUps: [{ name: 'Fake Potion', sourceTopics: ['also invented'], attackPoints: 3 }],
      },
      topics,
    );
    expect(level!.enemies).toHaveLength(1);
    expect(level!.enemies[0]!.name).toBe('The Review Hydra');
    expect(level!.powerUps).toHaveLength(0);
  });

  it('refuses to turn a good topic into an enemy', () => {
    const level = sanitizeLevel(
      {
        enemies: [
          { name: 'Pairing Demon', sourceTopics: ['Pairing helped'], strength: 4 },
          { name: 'The Review Hydra', sourceTopics: ['Review takes too long'], strength: 4 },
        ],
        powerUps: [],
      },
      topics,
    );
    expect(level!.enemies.map((enemy) => enemy.name)).toEqual(['The Review Hydra']);
  });

  it('rejects a level with no usable enemy at all', () => {
    expect(sanitizeLevel({ enemies: [], powerUps: [] }, topics)).toBeNull();
    expect(sanitizeLevel('not an object', topics)).toBeNull();
    expect(sanitizeLevel(null, topics)).toBeNull();
  });

  it('caps the number of enemies even when the model gets carried away', () => {
    const many = Array.from({ length: 30 }, () => ({
      name: 'The Review Hydra',
      sourceTopics: ['Review takes too long'],
      strength: 3,
    }));
    const level = sanitizeLevel({ enemies: many, powerUps: [] }, topics);
    expect(level!.enemies.length).toBeLessThanOrEqual(LIMITS.maxEnemies);
  });
});

describe('generation with and without AI', () => {
  const topics = [
    topic({ title: 'Review takes too long' }),
    topic({ title: 'Deploys fail on Friday', type: 'sad' }),
    topic({ title: 'Pairing helped', type: 'good' }),
  ];

  it('uses the deterministic generator when no key is configured', async () => {
    const level = await generateLevel(topics, null);
    expect(level.source).toBe('fallback');
  });

  it('uses the AI level when the model answers usefully', async () => {
    const level = await generateLevel(
      topics,
      config,
      aiResponse({
        title: 'The Blocker Dungeon',
        intro: 'Down we go',
        enemies: [
          {
            name: 'The Review Hydra',
            kind: 'miniboss',
            description: 'Many heads',
            sourceTopics: ['Review takes too long'],
            strength: 4,
          },
        ],
        powerUps: [
          { name: 'Potion of Pairing', description: 'Nice', sourceTopics: ['Pairing helped'], attackPoints: 3 },
        ],
      }),
    );
    expect(level.source).toBe('ai');
    expect(level.enemies[0]!.name).toBe('The Review Hydra');
  });

  it('falls back when the model returns nonsense, and says why', async () => {
    const broken = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'sorry, I cannot do that' } }] }),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const level = await generateLevel(topics, config, broken);
    expect(level.source).toBe('fallback');
    expect(level.note).toBeTruthy();
  });

  it('falls back when OpenRouter itself fails, without leaking the key', async () => {
    const failing = vi.fn(async () =>
      ({ ok: false, status: 401, text: async () => 'bad key sk-test-key', json: async () => ({}) }) as unknown as Response,
    ) as unknown as typeof fetch;

    const level = await generateLevel(topics, config, failing);
    expect(level.source).toBe('fallback');
    expect(level.note).toContain('401');
    expect(level.note).not.toContain('sk-test-key');
  });
});

describe('characters', () => {
  const checkIn = {
    energy: 4,
    pressure: 5,
    satisfaction: 2,
    mood: 'Shipped a lot, reviewed even more.',
    keywords: ['coffee', 'hotfixes'],
  };

  it('derives the same hero from the same check-in', () => {
    const first = fallbackCharacter('Markus', checkIn);
    const second = fallbackCharacter('Markus', checkIn);
    expect(first).toEqual(second);
    expect(first.attack).toBeGreaterThanOrEqual(1);
    expect(first.attack).toBeLessThanOrEqual(5);
    expect(first.emoji.length).toBeGreaterThan(0);
  });

  it('gives different players different heroes', () => {
    expect(fallbackCharacter('Markus', checkIn).characterName).not.toBe(
      fallbackCharacter('Lena', checkIn).characterName,
    );
  });

  it('keeps the player name from the request even if the model renames people', async () => {
    const result = await generateCharacters(
      [{ playerName: 'Markus', checkIn }],
      config,
      aiResponse({
        characters: [
          {
            playerName: 'Markus',
            characterName: 'Carl Ironhand',
            className: 'Manual Crafting Barbarian',
            description: 'Fixes things with stubbornness.',
            skill: 'Overpowered Manual Crafting',
            weakness: 'Badly named Jira tickets.',
            attack: 42,
            support: -3,
          },
        ],
      }),
    );
    expect(result.source).toBe('ai');
    const character = result.characters[0]!;
    expect(character.playerName).toBe('Markus');
    expect(character.characterName).toBe('Carl Ironhand');
    expect(character.attack).toBeLessThanOrEqual(5);
    expect(character.support).toBeGreaterThanOrEqual(1);
  });

  it('falls back per player when the model skips someone', async () => {
    const result = await generateCharacters(
      [
        { playerName: 'Markus', checkIn },
        { playerName: 'Lena', checkIn },
      ],
      config,
      aiResponse({ characters: [{ playerName: 'Markus', characterName: 'Carl Ironhand' }] }),
    );
    expect(result.characters[0]!.source).toBe('ai');
    expect(result.characters[1]!.source).toBe('fallback');
    expect(result.characters[1]!.playerName).toBe('Lena');
  });

  it('adds a generated avatar image when an image model is configured', async () => {
    const result = await generateCharacters(
      [{ playerName: 'Markus', checkIn }],
      config,
      aiAndImageResponse({
        characters: [
          {
            playerName: 'Markus',
            characterName: 'Carl Ironhand',
            className: 'Manual Crafting Barbarian',
            description: 'Fixes things with stubbornness.',
            skill: 'Overpowered Manual Crafting',
            weakness: 'Badly named Jira tickets.',
            attack: 4,
            support: 3,
            avatarPrompt: 'tiny barbarian engineer with a hammer',
          },
        ],
      }),
      imageConfig,
    );

    expect(result.characters[0]!.avatarImage?.dataUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(result.characters[0]!.avatarImage?.model).toBe('openai/gpt-image-2');
    expect(result.characters[0]!.avatarImage?.cost).toBe(0.006);
  });
});

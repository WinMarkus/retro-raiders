import { createHash } from 'node:crypto';
import { LIMITS, MAP } from '../shared/constants.js';
import type {
  CheckIn,
  Character,
  Enemy,
  EnemyKind,
  Level,
  Point,
  PowerUp,
  Topic,
} from '../shared/types.js';
import {
  complete,
  extractJson,
  generateImage,
  type OpenRouterConfig,
  type OpenRouterImageConfig,
} from './openrouter.js';
import { clampInt, clampPoint, sanitizeSingleLine, sanitizeText } from './validation.js';

/* ------------------------------------------------------------ helpers -- */

function hash(text: string): number {
  const digest = createHash('sha256').update(text).digest();
  return digest.readUInt32BE(0);
}

function pick<T>(list: readonly T[], seed: string): T {
  return list[hash(seed) % list.length]!;
}

function slug(text: string, fallback: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || fallback;
}

/** Deterministic scatter using the golden angle, so nothing overlaps badly. */
function scatter(index: number, total: number, seed: string, band: 'inner' | 'outer'): Point {
  const golden = 2.399963;
  const angle = index * golden + (hash(seed) % 1000) / 1000;
  const spread = band === 'inner' ? 0.62 : 0.92;
  const radius = (0.32 + (index / Math.max(total, 1)) * 0.55) * spread;
  return clampPoint({
    x: MAP.width / 2 + Math.cos(angle) * radius * (MAP.width / 2 - MAP.margin),
    y: MAP.height / 2 + Math.sin(angle) * radius * (MAP.height / 2 - MAP.margin) * 0.85,
  });
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function openPosition(initial: Point, seed: string, placed: Point[]): Point {
  const minimum = MAP.interactRadius * 2.1;
  if (placed.every((point) => pointDistance(point, initial) >= minimum)) return initial;

  const golden = 2.399963;
  const seedAngle = (hash(seed) % 1000) / 1000;
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const radius = minimum * (1 + Math.floor(attempt / 8) * 0.45);
    const angle = seedAngle + attempt * golden;
    const candidate = clampPoint({
      x: initial.x + Math.cos(angle) * radius,
      y: initial.y + Math.sin(angle) * radius,
    });
    if (placed.every((point) => pointDistance(point, candidate) >= minimum)) return candidate;
  }

  return initial;
}

function spaceLevelObjects(enemies: Enemy[], powerUps: PowerUp[]): { enemies: Enemy[]; powerUps: PowerUp[] } {
  const placed: Point[] = [];
  const spacedEnemies = enemies.map((enemy) => {
    const position = openPosition(enemy.position, enemy.id, placed);
    placed.push(position);
    return { ...enemy, position };
  });
  const spacedPowerUps = powerUps.map((powerUp) => {
    const position = openPosition(powerUp.position, powerUp.id, placed);
    placed.push(position);
    return { ...powerUp, position };
  });
  return { enemies: spacedEnemies, powerUps: spacedPowerUps };
}

/* --------------------------------------------------------- characters -- */

const CLASS_BY_MOOD: Array<{ id: string; className: string; emoji: string; skill: string }> = [
  { id: 'barbarian', className: 'Manual Crafting Barbarian', emoji: '🪓', skill: 'Overpowered Manual Crafting' },
  { id: 'ranger', className: 'Deployment Ranger', emoji: '🏹', skill: 'Fires a release straight through the pipeline' },
  { id: 'mage', className: 'Test Mage', emoji: '🔮', skill: 'Summons a failing test before the bug reaches production' },
  { id: 'paladin', className: 'Refactor Paladin', emoji: '🛡️', skill: 'Heals legacy code by touching it gently' },
  { id: 'bard', className: 'Product Bard', emoji: '🎻', skill: 'Turns a vague ticket into a story people understand' },
  { id: 'druid', className: 'Root Cause Druid', emoji: '🌿', skill: 'Follows a stack trace down to the actual root' },
  { id: 'rogue', className: 'Hotfix Rogue', emoji: '🗡️', skill: 'Slips a fix into production without waking the on-call' },
  { id: 'architect', className: 'Architecture Oracle', emoji: '📐', skill: 'Sees the diagram three sprints ahead' },
];

const NAME_FIRST = ['Carl', 'Brynn', 'Odek', 'Mira', 'Tovald', 'Signy', 'Ragna', 'Eldric', 'Nessa', 'Bram'];
const NAME_LAST = [
  'Ironhand',
  'Quickpatch',
  'Deepstack',
  'Stormcache',
  'Nullbane',
  'Greybuild',
  'Redbranch',
  'Coldstart',
  'Hammerfall',
  'Longpoll',
];

const WEAKNESSES = [
  'Gets distracted by badly named Jira tickets.',
  'Cannot walk past a flaky test without poking it.',
  'Loses all courage when a meeting has no agenda.',
  'Refuses to fight before the coffee ritual is complete.',
  'Reads the changelog out loud, at length, to anyone nearby.',
  'Answers every question with "it depends".',
];

/**
 * Derived, not random: the same check-in always forges the same hero, which
 * keeps the fallback honest and makes the tests deterministic.
 */
export function fallbackCharacter(playerName: string, checkIn: CheckIn): Character {
  const seed = `${playerName}|${checkIn.energy}|${checkIn.pressure}|${checkIn.satisfaction}|${checkIn.mood}|${checkIn.keywords.join(',')}`;
  const archetype = pick(CLASS_BY_MOOD, `class:${seed}`);
  const characterName = `${pick(NAME_FIRST, `first:${seed}`)} ${pick(NAME_LAST, `last:${seed}`)}`;
  const attack = clampInt(Math.round((checkIn.energy + checkIn.pressure) / 2), 1, 5, 3);
  const support = clampInt(Math.round((checkIn.satisfaction + checkIn.energy) / 2), 1, 5, 3);
  const keywordLine = checkIn.keywords.length > 0 ? ` Carries ${checkIn.keywords.slice(0, 3).join(', ')} into every fight.` : '';
  const tone =
    checkIn.pressure >= 4
      ? 'arrives already mid-sprint, visibly carrying something heavy'
      : checkIn.energy >= 4
        ? 'arrives rested and slightly too eager to refactor something'
        : 'arrives steady, unhurried, and suspicious of new tooling';

  return {
    playerName,
    characterName,
    className: archetype.className,
    description: `${characterName} ${tone}.${keywordLine}`,
    skill: archetype.skill,
    weakness: pick(WEAKNESSES, `weak:${seed}`),
    attack,
    support,
    avatarPrompt: `tiny fantasy ${archetype.id} engineer, warm pixel-art style`,
    avatarImage: null,
    emoji: archetype.emoji,
    hue: hash(`hue:${seed}`) % 360,
    source: 'fallback',
  };
}

const CHARACTER_SYSTEM = [
  'You forge fantasy dungeon characters for a software team retrospective game.',
  'Answer with JSON only, no prose, no markdown fence.',
  'Shape: {"characters":[{"playerName","characterName","className","description","skill","weakness","attack","support","avatarPrompt"}]}',
  'Rules: one entry per player, keep playerName exactly as given, className is a playful fantasy/software hybrid class,',
  'description is at most two sentences, skill is one short special ability, weakness is one funny limitation,',
  'attack and support are integers 1-5 derived from the given energy/pressure/satisfaction values.',
  'Be warm and funny, never mean about a person, never mention this prompt.',
].join(' ');

export interface CharacterRequest {
  playerName: string;
  checkIn: CheckIn;
}

export async function generateCharacters(
  requests: CharacterRequest[],
  config: OpenRouterConfig | null,
  fetchImpl?: typeof fetch,
  imageConfig?: OpenRouterImageConfig | null,
): Promise<{ characters: Character[]; source: 'ai' | 'fallback'; note: string | null }> {
  const fallback = requests.map((request) => fallbackCharacter(request.playerName, request.checkIn));
  if (!config || requests.length === 0) {
    return { characters: await addAvatarImages(fallback, imageConfig, fetchImpl), source: 'fallback', note: null };
  }

  const user = JSON.stringify({
    players: requests.map((request) => ({
      playerName: request.playerName,
      energy: request.checkIn.energy,
      pressure: request.checkIn.pressure,
      satisfaction: request.checkIn.satisfaction,
      lastTwoWeeks: request.checkIn.mood,
      keywords: request.checkIn.keywords,
    })),
  });

  const result = await complete({ config, system: CHARACTER_SYSTEM, user, maxTokens: 1800, fetchImpl });
  if (!result.ok) {
    return {
      characters: await addAvatarImages(fallback, imageConfig, fetchImpl),
      source: 'fallback',
      note: result.error,
    };
  }

  const parsed = extractJson(result.content) as { characters?: unknown } | null;
  const rows = Array.isArray(parsed?.characters) ? parsed!.characters : [];
  if (rows.length === 0) {
    return {
      characters: await addAvatarImages(fallback, imageConfig, fetchImpl),
      source: 'fallback',
      note: 'The AI answer could not be parsed as JSON.',
    };
  }

  const byName = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const name = sanitizeSingleLine(record.playerName, LIMITS.playerName).toLowerCase();
    if (name) byName.set(name, record);
  }

  const characters = requests.map((request, index) => {
    const raw = byName.get(request.playerName.toLowerCase());
    if (!raw) return fallback[index]!;
    return sanitizeCharacter(raw, request, fallback[index]!);
  });

  return { characters: await addAvatarImages(characters, imageConfig, fetchImpl), source: 'ai', note: null };
}

async function addAvatarImages(
  characters: Character[],
  imageConfig: OpenRouterImageConfig | null | undefined,
  fetchImpl?: typeof fetch,
): Promise<Character[]> {
  if (!imageConfig) return characters;
  const withImages: Character[] = [];
  for (const character of characters) {
    const image = await generateImage({
      config: imageConfig,
      prompt: [
        character.avatarPrompt,
        `Character name: ${character.characterName}.`,
        `Class: ${character.className}.`,
        'Single square fantasy RPG avatar portrait, warm pixel-art illustration, centered bust, expressive face, no text, no letters, no UI.',
      ].join(' '),
      fetchImpl,
    });
    withImages.push(
      image.ok
        ? {
            ...character,
            avatarImage: {
              dataUrl: image.dataUrl,
              mediaType: image.mediaType,
              model: image.model,
              cost: image.cost,
            },
          }
        : character,
    );
  }
  return withImages;
}

/** The model's answer is treated exactly like player input: clamped and cleaned. */
export function sanitizeCharacter(
  raw: Record<string, unknown>,
  request: CharacterRequest,
  fallback: Character,
): Character {
  const characterName = sanitizeSingleLine(raw.characterName, 48) || fallback.characterName;
  const seed = `${request.playerName}|${characterName}`;
  return {
    playerName: request.playerName,
    characterName,
    className: sanitizeSingleLine(raw.className, 48) || fallback.className,
    description: sanitizeText(raw.description, 280) || fallback.description,
    skill: sanitizeSingleLine(raw.skill, 120) || fallback.skill,
    weakness: sanitizeSingleLine(raw.weakness, 160) || fallback.weakness,
    attack: clampInt(raw.attack, 1, 5, fallback.attack),
    support: clampInt(raw.support, 1, 5, fallback.support),
    avatarPrompt: sanitizeSingleLine(raw.avatarPrompt, 160) || fallback.avatarPrompt,
    avatarImage: null,
    emoji: pick(CLASS_BY_MOOD, `class:${seed}`).emoji,
    hue: hash(`hue:${seed}`) % 360,
    source: 'ai',
  };
}

/* ------------------------------------------------------- clustering -- */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'with', 'it', 'its', 'we', 'our', 'us', 'i', 'my', 'they', 'them', 'that', 'this',
  'too', 'very', 'so', 'not', 'no', 'at', 'as', 'by', 'from', 'do', 'does', 'did', 'have', 'has',
  'had', 'get', 'gets', 'got', 'take', 'takes', 'took', 'more', 'less', 'much', 'many', 'lot',
  'really', 'always', 'often', 'sometimes', 'again', 'still', 'just', 'than', 'then', 'there',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß ]+/g, ' ')
    .split(/\s+/)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export interface TopicCluster {
  topics: Topic[];
  words: string[];
}

/**
 * Three people saying "review takes too long" should become one strong enemy,
 * not three weak ones. Greedy single-link clustering on shared words.
 */
export function clusterTopics(topics: Topic[], threshold = 0.34): TopicCluster[] {
  const entries = topics.map((topic) => ({
    topic,
    words: new Set(tokenize(`${topic.title} ${topic.description}`)),
  }));
  const clusters: Array<{ topics: Topic[]; words: Set<string> }> = [];

  for (const entry of entries) {
    let best: { cluster: (typeof clusters)[number]; score: number } | null = null;
    for (const cluster of clusters) {
      const score = similarity(entry.words, cluster.words);
      if (score >= threshold && (!best || score > best.score)) best = { cluster, score };
    }
    if (best) {
      best.cluster.topics.push(entry.topic);
      for (const word of entry.words) best.cluster.words.add(word);
    } else {
      clusters.push({ topics: [entry.topic], words: new Set(entry.words) });
    }
  }

  return clusters
    .sort((a, b) => b.topics.length - a.topics.length)
    .map((cluster) => ({ topics: cluster.topics, words: [...cluster.words] }));
}

/* ------------------------------------------------- fallback bestiary -- */

const BESTIARY: Array<{ match: RegExp; name: string; kind: EnemyKind; flavour: string }> = [
  { match: /review|pr\b|pull request|approval/, name: 'The Review Hydra', kind: 'miniboss', flavour: 'Grows another head every time a pull request waits overnight.' },
  { match: /deploy|release|pipeline|ci\b|build/, name: 'The Pipeline Wyrm', kind: 'miniboss', flavour: 'Sleeps across the deployment path and wakes on Fridays.' },
  { match: /meeting|call|standup|jour fixe|termin/, name: 'The Meeting Swarm', kind: 'minion', flavour: 'Individually harmless, collectively eats an entire afternoon.' },
  { match: /scope|requirement|unclear|vague|spec/, name: 'The Scope Creep Ooze', kind: 'curse', flavour: 'Expands quietly until it fills whatever container you put it in.' },
  { match: /context|switch|interrupt|ticket hopping/, name: 'The Context Switch Wraith', kind: 'curse', flavour: 'Taps you on the shoulder the moment you finally understand something.' },
  { match: /flaky|test|qa|bug|regression/, name: 'The Flaky Test Poltergeist', kind: 'trap', flavour: 'Fails once, passes twice, and is never reproducible while you watch.' },
  { match: /legacy|tech debt|refactor|old code/, name: 'The Legacy Golem', kind: 'boss', flavour: 'Built by people who have long since left the guild. Still load-bearing.' },
  { match: /ownership|responsib|unclear owner|wer macht/, name: 'The Ownership Fog', kind: 'curse', flavour: 'Everyone can see the task. Nobody can see whose it is.' },
  { match: /wait|block|depend|handover|warten/, name: 'The Waiting Gate', kind: 'trap', flavour: 'Opens only when a person in another timezone happens to look at it.' },
  { match: /communicat|info|unklar|abstimm|align/, name: 'The Whisper Labyrinth', kind: 'minion', flavour: 'Carries half a message to exactly the wrong corridor.' },
];

const GENERIC_ENEMIES = [
  'The Grumbling Shade',
  'The Backlog Basilisk',
  'The Sprint Gremlin',
  'The Estimation Imp',
  'The Silent Blocker',
  'The Midnight Alert Banshee',
];

const POWERUP_NAMES = [
  'Potion of Pairing',
  'Shield of Clear Ownership',
  'Torch of Better Refinement',
  'Twin Focus Blade',
  'Banner of Fast Feedback',
  'Charm of the Quiet Morning',
  'Elixir of Shipped Things',
  'Lantern of Honest Estimates',
];

function kindForSize(size: number, intensity: number): EnemyKind {
  const weight = size * 2 + intensity;
  if (weight >= 9) return 'boss';
  if (weight >= 6) return 'miniboss';
  if (weight >= 4) return 'curse';
  return 'minion';
}

export function fallbackLevel(topics: Topic[], note: string | null = null): Level {
  const problems = topics.filter((topic) => topic.type !== 'good');
  const goods = topics.filter((topic) => topic.type === 'good');

  const clusters = clusterTopics(problems).slice(0, LIMITS.maxEnemies);
  const enemies: Enemy[] = clusters.map((cluster, index) => {
    const text = cluster.topics.map((topic) => `${topic.title} ${topic.description}`).join(' ').toLowerCase();
    const entry = BESTIARY.find((candidate) => candidate.match.test(text));
    const intensity = Math.max(...cluster.topics.map((topic) => topic.intensity));
    const size = cluster.topics.length;
    const seed = cluster.topics.map((topic) => topic.id).join('|');
    const name = entry?.name ?? pick(GENERIC_ENEMIES, `enemy:${seed}`);
    const sadness = cluster.topics.filter((topic) => topic.type === 'sad').length;
    return {
      id: `enemy-${slug(name, 'foe')}-${index}`,
      name,
      kind: entry?.kind ?? kindForSize(size, intensity),
      description:
        entry?.flavour ??
        `Formed from ${size} report${size === 1 ? '' : 's'} the party kept running into${sadness > 0 ? ', and it drains morale on contact' : ''}.`,
      sourceTopics: cluster.topics.map((topic) => topic.title),
      strength: clampInt(Math.min(5, Math.round((size * 2 + intensity) / 2)), 1, 5, 2),
      position: scatter(index, Math.max(clusters.length, 1), `pos:${seed}`, 'inner'),
      status: 'active',
      lockedBy: [],
    };
  });

  const goodClusters = clusterTopics(goods).slice(0, LIMITS.maxPowerUps);
  const powerUps: PowerUp[] = goodClusters.map((cluster, index) => {
    const seed = cluster.topics.map((topic) => topic.id).join('|');
    const intensity = Math.max(...cluster.topics.map((topic) => topic.intensity));
    const name = pick(POWERUP_NAMES, `power:${seed}`);
    return {
      id: `powerup-${slug(name, 'boon')}-${index}`,
      name,
      description: `Forged from what worked: ${cluster.topics.map((topic) => topic.title).join('; ')}.`,
      sourceTopics: cluster.topics.map((topic) => topic.title),
      attackPoints: clampInt(cluster.topics.length + Math.ceil(intensity / 2), 1, 6, 2),
      position: scatter(index, Math.max(goodClusters.length, 1), `powerpos:${seed}`, 'outer'),
      collectedBy: null,
    };
  });
  const spaced = spaceLevelObjects(enemies, powerUps);

  return {
    title: 'The Blocker Dungeon',
    intro:
      enemies.length > 0
        ? 'The party descends. Everything the team ran into last sprint is down here, and it has teeth now.'
        : 'Suspiciously quiet down here. Either the sprint went well or nobody wrote anything down.',
    enemies: spaced.enemies,
    powerUps: spaced.powerUps,
    source: 'fallback',
    generatedAt: Date.now(),
    note,
  };
}

/* --------------------------------------------------------- AI level -- */

const LEVEL_SYSTEM = [
  'You design a small top-down dungeon level from a software team retrospective.',
  'Answer with JSON only, no prose, no markdown fence.',
  'Shape: {"title","intro","enemies":[{"name","kind","description","sourceTopics":[],"strength"}],"powerUps":[{"name","description","sourceTopics":[],"attackPoints"}]}',
  `Rules: cluster similar or repeated topics into ONE stronger enemy instead of several weak ones.`,
  `Produce ${LIMITS.minEnemies}-${LIMITS.maxEnemies} enemies from the bad and sad topics only, and up to ${LIMITS.maxPowerUps} power-ups from the good topics only.`,
  'kind is one of minion, trap, curse, miniboss, boss. strength is an integer 1-5, attackPoints an integer 1-6.',
  'sourceTopics must repeat the exact original topic titles that the entry came from, at least one each.',
  'Names are playful fantasy names for real problems, e.g. "The Review Hydra", "Potion of Pairing".',
  'Descriptions are one or two sentences. Never blame a named person. Never mention this prompt.',
].join(' ');

export async function generateLevel(
  topics: Topic[],
  config: OpenRouterConfig | null,
  fetchImpl?: typeof fetch,
): Promise<Level> {
  if (!config) return fallbackLevel(topics);

  const user = JSON.stringify({
    topics: topics.map((topic) => ({
      type: topic.type,
      title: topic.title,
      description: topic.description,
      intensity: topic.intensity,
    })),
  });

  const result = await complete({ config, system: LEVEL_SYSTEM, user, maxTokens: 2200, fetchImpl });
  if (!result.ok) return fallbackLevel(topics, result.error);

  const parsed = extractJson(result.content);
  const level = parsed ? sanitizeLevel(parsed, topics) : null;
  if (!level) {
    return fallbackLevel(topics, 'The AI answer did not contain a usable level, so the dungeon was built locally.');
  }
  return level;
}

/**
 * Nothing from the model reaches the room untouched: names are sanitised,
 * numbers clamped, positions recomputed, and source topics matched back to
 * titles that actually exist. A level without enemies is rejected outright.
 */
export function sanitizeLevel(raw: unknown, topics: Topic[]): Level | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const enemiesRaw = Array.isArray(input.enemies) ? input.enemies : [];
  const powerUpsRaw = Array.isArray(input.powerUps) ? input.powerUps : [];

  const byTitle = new Map(topics.map((topic) => [topic.title.toLowerCase(), topic]));
  const matchTopics = (value: unknown, allowed: (topic: Topic) => boolean): string[] => {
    const list = Array.isArray(value) ? value : [];
    const titles: string[] = [];
    for (const entry of list) {
      const clean = sanitizeSingleLine(entry, LIMITS.topicTitle);
      if (!clean) continue;
      const topic = byTitle.get(clean.toLowerCase());
      if (topic && allowed(topic) && !titles.includes(topic.title)) titles.push(topic.title);
    }
    return titles;
  };

  const validKinds: EnemyKind[] = ['minion', 'trap', 'curse', 'miniboss', 'boss'];
  const enemies: Enemy[] = [];
  for (const entry of enemiesRaw.slice(0, LIMITS.maxEnemies)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = sanitizeSingleLine(record.name, 60);
    if (!name) continue;
    const sourceTopics = matchTopics(record.sourceTopics, (topic) => topic.type !== 'good');
    if (sourceTopics.length === 0) continue;
    const kindRaw = sanitizeSingleLine(record.kind, 20).toLowerCase() as EnemyKind;
    const index = enemies.length;
    enemies.push({
      id: `enemy-${slug(name, 'foe')}-${index}`,
      name,
      kind: validKinds.includes(kindRaw) ? kindRaw : kindForSize(sourceTopics.length, 3),
      description: sanitizeText(record.description, 300) || 'Something the team kept walking into.',
      sourceTopics,
      strength: clampInt(record.strength, 1, 5, Math.min(5, sourceTopics.length + 1)),
      position: scatter(index, Math.max(enemiesRaw.length, 1), `ai:${name}`, 'inner'),
      status: 'active',
      lockedBy: [],
    });
  }

  if (enemies.length === 0) return null;

  const powerUps: PowerUp[] = [];
  for (const entry of powerUpsRaw.slice(0, LIMITS.maxPowerUps)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = sanitizeSingleLine(record.name, 60);
    if (!name) continue;
    const sourceTopics = matchTopics(record.sourceTopics, (topic) => topic.type === 'good');
    if (sourceTopics.length === 0) continue;
    const index = powerUps.length;
    powerUps.push({
      id: `powerup-${slug(name, 'boon')}-${index}`,
      name,
      description: sanitizeText(record.description, 300) || 'Something that actually helped.',
      sourceTopics,
      attackPoints: clampInt(record.attackPoints, 1, 6, 2),
      position: scatter(index, Math.max(powerUpsRaw.length, 1), `aipower:${name}`, 'outer'),
      collectedBy: null,
    });
  }

  const spaced = spaceLevelObjects(enemies, powerUps);

  return {
    title: sanitizeSingleLine(input.title, 80) || 'The Blocker Dungeon',
    intro: sanitizeText(input.intro, 300) || 'The party descends.',
    enemies: spaced.enemies,
    powerUps: spaced.powerUps,
    source: 'ai',
    generatedAt: Date.now(),
    note: null,
  };
}

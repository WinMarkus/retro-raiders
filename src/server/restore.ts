import { LIMITS } from '../shared/constants.js';
import type { Character, Enemy, EnemyKind, Level, Phase, PowerUp, Resolution, Topic } from '../shared/types.js';
import { spawnPoint, type PlayerRecord, type Room } from './state.js';
import {
  clampInt,
  clampPoint,
  isId,
  isTopicType,
  sanitizeSingleLine,
  sanitizeText,
  validateCheckIn,
} from './validation.js';

/*
 * Render's free tier restarts the process now and then, and rooms live only in
 * memory. Every browser still holds its last copy of the room, so after a
 * restart they send it back and the room is stitched together again: public
 * parts (phase, level, results) from the freshest copy, private parts (your
 * check-in, your topics) from their owner. Client data is treated exactly like
 * any other socket input.
 */

type Raw = Record<string, unknown>;

const PHASES: Phase[] = ['forge', 'topics', 'level', 'victory'];
const KINDS: EnemyKind[] = ['minion', 'trap', 'curse', 'miniboss', 'boss'];

function obj(value: unknown): Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : {};
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function strings(value: unknown, max: number, length: number): string[] {
  return list(value, max)
    .map((entry) => sanitizeSingleLine(entry, length))
    .filter(Boolean);
}

export function restoreCharacter(raw: unknown, playerName: string): Character | null {
  const input = obj(raw);
  const characterName = sanitizeSingleLine(input.characterName, 48);
  if (!characterName) return null;
  return {
    playerName,
    characterName,
    className: sanitizeSingleLine(input.className, 48) || 'Wandering Adventurer',
    description: sanitizeText(input.description, 280),
    skill: sanitizeSingleLine(input.skill, 120),
    weakness: sanitizeSingleLine(input.weakness, 160),
    attack: clampInt(input.attack, 1, 5, 3),
    support: clampInt(input.support, 1, 5, 3),
    avatarPrompt: sanitizeSingleLine(input.avatarPrompt, 160),
    // Portraits lived in server memory only; the emoji card takes over.
    avatarImage: null,
    emoji: sanitizeSingleLine(input.emoji, 8) || '🎲',
    hue: clampInt(input.hue, 0, 359, 210),
    source: input.source === 'ai' ? 'ai' : 'fallback',
  };
}

function restoreEnemy(raw: unknown): Enemy | null {
  const input = obj(raw);
  const id = input.id;
  const name = sanitizeSingleLine(input.name, 60);
  if (!isId(id) || !name) return null;
  const kind = KINDS.includes(input.kind as EnemyKind) ? (input.kind as EnemyKind) : 'minion';
  return {
    id,
    name,
    kind,
    description: sanitizeText(input.description, 300),
    sourceTopics: strings(input.sourceTopics, 20, LIMITS.topicTitle),
    strength: clampInt(input.strength, 1, 5, 2),
    position: clampPoint(input.position),
    // Locks and open fights are not worth restoring; people just click again.
    status: input.status === 'resolved' ? 'resolved' : 'active',
    lockedBy: [],
  };
}

function restorePowerUp(raw: unknown): PowerUp | null {
  const input = obj(raw);
  const id = input.id;
  const name = sanitizeSingleLine(input.name, 60);
  if (!isId(id) || !name) return null;
  const collectedBy = sanitizeSingleLine(input.collectedBy, LIMITS.playerName);
  return {
    id,
    name,
    description: sanitizeText(input.description, 300),
    sourceTopics: strings(input.sourceTopics, 20, LIMITS.topicTitle),
    attackPoints: clampInt(input.attackPoints, 1, 6, 2),
    position: clampPoint(input.position),
    collectedBy: collectedBy || null,
  };
}

export function restoreLevel(raw: unknown): Level | null {
  const input = obj(raw);
  const enemies = list(input.enemies, LIMITS.maxEnemies)
    .map(restoreEnemy)
    .filter((enemy): enemy is Enemy => Boolean(enemy));
  if (enemies.length === 0) return null;
  return {
    title: sanitizeSingleLine(input.title, 80) || 'The Blocker Dungeon',
    intro: sanitizeText(input.intro, 300),
    enemies,
    powerUps: list(input.powerUps, LIMITS.maxPowerUps)
      .map(restorePowerUp)
      .filter((powerUp): powerUp is PowerUp => Boolean(powerUp)),
    source: input.source === 'ai' ? 'ai' : 'fallback',
    generatedAt: clampInt(input.generatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    note: null,
  };
}

function restoreResolution(raw: unknown): Resolution | null {
  const input = obj(raw);
  const enemyId = input.enemyId;
  const treatment = sanitizeText(input.treatment, LIMITS.treatmentText);
  if (!isId(enemyId) || !treatment) return null;
  return {
    enemyId,
    enemyName: sanitizeSingleLine(input.enemyName, 60),
    story: sanitizeText(input.story, 420),
    treatment,
    owner: sanitizeSingleLine(input.owner, LIMITS.ownerText) || null,
    reviewBy: sanitizeSingleLine(input.reviewBy, LIMITS.reviewByText) || 'next retro',
    attackSpent: clampInt(input.attackSpent, 0, LIMITS.maxAttackPerEnemy, 0),
    party: strings(input.party, LIMITS.maxPlayers, LIMITS.playerName),
    alternatives: list(input.alternatives, LIMITS.maxProposals)
      .map((idea) => sanitizeText(idea, LIMITS.proposalText))
      .filter(Boolean),
    resolvedAt: clampInt(input.resolvedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
}

function restoreTopic(raw: unknown): Topic | null {
  const input = obj(raw);
  const id = input.id;
  const title = sanitizeSingleLine(input.title, LIMITS.topicTitle);
  if (!isId(id) || title.length < 3 || !isTopicType(input.type)) return null;
  return {
    id,
    type: input.type,
    title,
    description: sanitizeText(input.description, LIMITS.topicDescription),
    intensity: clampInt(input.intensity, 1, 5, 3),
  };
}

function blankPlayer(id: string, name: string, index: number): PlayerRecord {
  const now = Date.now();
  return {
    id,
    name,
    socketId: null,
    connected: false,
    ready: false,
    forging: false,
    checkIn: null,
    character: null,
    position: spawnPoint(index),
    lockedEnemyId: null,
    joinedAt: now + index,
    lastSeen: now,
  };
}

/** Overwrites the public half of the room with this client's copy. */
export function applyPublicState(room: Room, rawState: unknown): void {
  const state = obj(rawState);
  const phase = PHASES.includes(state.phase as Phase) ? (state.phase as Phase) : state.phase === 'generating' ? 'topics' : 'forge';
  const level = restoreLevel(state.level);

  room.phase = (phase === 'level' || phase === 'victory') && !level ? 'topics' : phase;
  room.level = level;
  room.encounter = null;
  room.resolutions = list(state.resolutions, LIMITS.maxEnemies)
    .map(restoreResolution)
    .filter((resolution): resolution is Resolution => Boolean(resolution));
  const attack = obj(state.attack);
  room.attackCollected = clampInt(attack.collected, 0, 999, 0);
  room.attackSpent = clampInt(attack.spent, 0, room.attackCollected, 0);
  room.createdAt = clampInt(state.campaignId, 0, Number.MAX_SAFE_INTEGER, room.createdAt);
  room.version = clampInt(state.version, 0, Number.MAX_SAFE_INTEGER, room.version);
  room.generation = { busy: false, message: null };

  list(state.players, LIMITS.maxPlayers).forEach((entry, index) => {
    const raw = obj(entry);
    const id = raw.id;
    const name = sanitizeSingleLine(raw.name, LIMITS.playerName);
    if (!isId(id) || !name) return;
    let player = room.players.get(id);
    if (!player) {
      if ([...room.players.values()].some((other) => other.name.toLowerCase() === name.toLowerCase())) return;
      if (room.players.size >= LIMITS.maxPlayers) return;
      player = blankPlayer(id, name, index);
      room.players.set(id, player);
    }
    // A portrait the server still holds beats the image-less client copy.
    if (!player.character?.avatarImage) player.character = restoreCharacter(raw.character, name);
    player.position = raw.position ? clampPoint(raw.position) : player.position;
    player.ready = raw.ready === true;
    if (raw.isFacilitator === true) room.facilitatorId = id;
  });
}

/** Adds what only this player knew: their check-in and their own topics. */
export function applyPrivateState(room: Room, player: PlayerRecord, rawState: unknown): void {
  const you = obj(obj(rawState).you);
  if (you.checkIn && !player.checkIn) {
    const checkIn = validateCheckIn(you.checkIn);
    if (checkIn.ok) player.checkIn = checkIn.value;
  }
  if (!player.character) player.character = restoreCharacter(you.character, player.name);

  for (const entry of list(you.topics, LIMITS.maxTopicsPerPlayer)) {
    const topic = restoreTopic(entry);
    if (!topic || room.topics.has(topic.id)) continue;
    room.topics.set(topic.id, topic);
    room.topicAuthors.set(topic.id, player.id);
  }
}

export function restoredVersion(rawState: unknown): number {
  return clampInt(obj(rawState).version, 0, Number.MAX_SAFE_INTEGER, 0);
}

import { LIMITS, MAP, TOPIC_TYPES, VAGUE_TREATMENTS } from '../shared/constants.js';
import type { CheckIn, Point, TopicType } from '../shared/types.js';

/**
 * Text arriving from a socket — or from the AI — is never trusted.
 * Control characters are dropped and angle brackets are neutralised so that no
 * payload can become markup anywhere downstream (the client renders with
 * textContent as well; this is the second lock on the same door).
 */
export function sanitizeText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return cleaned.trim().slice(0, maxLength);
}

export function sanitizeSingleLine(input: unknown, maxLength: number): string {
  return sanitizeText(input, maxLength).replace(/[\r\n]+/g, ' ').trim();
}

export function isValidPlayerName(name: string): boolean {
  return name.length >= 1 && name.length <= LIMITS.playerName;
}

export function normalizeRoomCode(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LIMITS.roomCode);
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function isTopicType(value: unknown): value is TopicType {
  return typeof value === 'string' && (TOPIC_TYPES as string[]).includes(value);
}

/** Every 1-5 slider in the app goes through here. */
export function clampScale(value: unknown, fallback = 3): number {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(LIMITS.scaleMax, Math.max(LIMITS.scaleMin, Math.round(number)));
}

export function clampInt(value: unknown, min: number, max: number, fallback = min): number {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function clampPoint(value: unknown): Point {
  const raw = (value ?? {}) as { x?: unknown; y?: unknown };
  const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : MAP.width / 2;
  const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : MAP.height / 2;
  return {
    x: Math.round(Math.min(MAP.width - MAP.margin / 2, Math.max(MAP.margin / 2, x))),
    y: Math.round(Math.min(MAP.height - MAP.margin / 2, Math.max(MAP.margin / 2, y))),
  };
}

export function validateCheckIn(raw: unknown): { ok: boolean; errors: string[]; value: CheckIn } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const keywordsRaw = Array.isArray(input.keywords) ? input.keywords : [];
  const value: CheckIn = {
    energy: clampScale(input.energy),
    pressure: clampScale(input.pressure),
    satisfaction: clampScale(input.satisfaction),
    mood: sanitizeText(input.mood, LIMITS.moodText),
    keywords: keywordsRaw
      .slice(0, LIMITS.maxKeywords)
      .map((word) => sanitizeSingleLine(word, LIMITS.keyword))
      .filter((word) => word.length > 0),
  };
  const errors: string[] = [];
  if (value.mood.length < 3) {
    errors.push('Say a few words about how the last two weeks felt (at least 3 characters).');
  }
  return { ok: errors.length === 0, errors, value };
}

export interface TopicInput {
  type: TopicType;
  title: string;
  description: string;
  intensity: number;
}

export function validateTopic(raw: unknown): { ok: boolean; errors: string[]; value: TopicInput } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const value: TopicInput = {
    type: isTopicType(input.type) ? input.type : 'bad',
    title: sanitizeSingleLine(input.title, LIMITS.topicTitle),
    description: sanitizeText(input.description, LIMITS.topicDescription),
    intensity: clampScale(input.intensity),
  };
  const errors: string[] = [];
  if (!isTopicType(input.type)) errors.push('Pick good, bad or sad.');
  if (value.title.length < 3) errors.push('Give the topic a short title (at least 3 characters).');
  return { ok: errors.length === 0, errors, value };
}

export interface TreatmentInput {
  treatment: string;
  owner: string;
  reviewBy: string;
  attackPoints: number;
}

/**
 * A treatment is the real retro output, so it has to survive the next retro:
 * something concrete, and a moment where the team looks at it again.
 */
export function validateTreatment(
  raw: unknown,
  availableAttack: number,
): { ok: boolean; errors: string[]; value: TreatmentInput } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const maxSpend = Math.min(LIMITS.maxAttackPerEnemy, Math.max(0, availableAttack));
  const value: TreatmentInput = {
    treatment: sanitizeText(input.treatment, LIMITS.treatmentText),
    owner: sanitizeSingleLine(input.owner, LIMITS.ownerText),
    reviewBy: sanitizeSingleLine(input.reviewBy, LIMITS.reviewByText) || 'next retro',
    attackPoints: clampInt(input.attackPoints, 0, maxSpend, 0),
  };
  const errors: string[] = [];

  if (value.treatment.length < 10) {
    errors.push('Write how the team wants to handle this (at least 10 characters).');
  }
  const flat = value.treatment.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (VAGUE_TREATMENTS.some((pattern) => pattern.test(flat))) {
    errors.push(
      'That is too vague to hit anything. Name the concrete change, for example "Pair on the flaky payment specs every Tuesday".',
    );
  }
  if (typeof input.attackPoints === 'number' && input.attackPoints > maxSpend) {
    errors.push(`The party only has ${maxSpend} attack point${maxSpend === 1 ? '' : 's'} to spend.`);
  }
  if (maxSpend < 1) {
    errors.push('Collect a power-up first. Every fight must spend at least one attack point.');
  } else if (value.attackPoints < 1) {
    errors.push('Spend at least one attack point on this fight.');
  }

  return { ok: errors.length === 0, errors, value };
}

import { LIMITS, VAGUE_TITLE_PATTERNS } from '../shared/constants.js';
import type { Category, ClassId } from '../shared/types.js';
import { ADVENTURER_CLASSES, CATEGORIES } from '../shared/constants.js';

/**
 * Text arriving from a socket is never trusted.
 * Control characters are dropped, angle brackets are neutralised so that no
 * payload can become markup anywhere downstream (the client renders with
 * textContent as well — this is the second lock on the same door).
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

export function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

export function isClassId(value: unknown): value is ClassId {
  return typeof value === 'string' && ADVENTURER_CLASSES.some((c) => c.id === value);
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as string[]).includes(value);
}

export function isEnergy(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

export function isCardIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < LIMITS.cardsPerCategory
  );
}

export function isTokenAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= LIMITS.maxTokensPerCard
  );
}

export function isForgePoints(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= LIMITS.forgePoints
  );
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export interface ProposalInput {
  title: string;
  description: string;
  signal: string;
  owner: string;
  reviewBy: string;
}

export interface ProposalValidation {
  ok: boolean;
  errors: string[];
  value: ProposalInput;
}

/** A weapon needs an edge: a real title and an observable sign that it worked. */
export function validateProposal(raw: unknown): ProposalValidation {
  const input = (raw ?? {}) as Record<string, unknown>;
  const value: ProposalInput = {
    title: sanitizeSingleLine(input.title, LIMITS.proposalTitle),
    description: sanitizeText(input.description, LIMITS.proposalDescription),
    signal: sanitizeText(input.signal, LIMITS.proposalSignal),
    owner: sanitizeSingleLine(input.owner, LIMITS.proposalOwner),
    reviewBy: sanitizeSingleLine(input.reviewBy, LIMITS.proposalReview),
  };
  const errors: string[] = [];

  if (value.title.length < 4) {
    errors.push('Give the experiment a title of at least 4 characters.');
  }
  if (value.signal.length < 8) {
    errors.push('Describe the observable sign that it helped (at least 8 characters).');
  }
  if (!value.reviewBy) {
    errors.push('Add a review date or review period, for example "in 2 sprints".');
  }

  const flatTitle = value.title.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (VAGUE_TITLE_PATTERNS.some((pattern) => flatTitle === pattern || flatTitle.startsWith(pattern))) {
    errors.push(
      `"${value.title}" is too vague to fight a boss with. Name the concrete change, for example "Pair on the flaky payment specs every Tuesday".`,
    );
  }

  return { ok: errors.length === 0, errors, value };
}

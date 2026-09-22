import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/shared/constants.js';
import {
  isCardIndex,
  isCategory,
  isClassId,
  isEnergy,
  isForgePoints,
  isId,
  isTokenAmount,
  isValidPlayerName,
  normalizeRoomCode,
  sanitizeSingleLine,
  sanitizeText,
  validateProposal,
} from '../src/server/validation.js';

describe('text sanitising', () => {
  it('defuses HTML and script payloads', () => {
    const dirty = '<script>alert("pwned")</script><img src=x onerror=alert(1)>';
    const clean = sanitizeText(dirty, LIMITS.cardText);
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).toContain('script');
  });

  it('cuts text at the limit and trims the edges', () => {
    const long = `   ${'a'.repeat(500)}   `;
    expect(sanitizeText(long, LIMITS.cardText)).toHaveLength(LIMITS.cardText);
  });

  it('drops control characters and collapses runaway whitespace', () => {
    expect(sanitizeText('a\u0000b\u0007c', 50)).toBe('abc');
    expect(sanitizeText('a     b', 50)).toBe('a b');
    expect(sanitizeText('a\n\n\n\n\nb', 50)).toBe('a\n\nb');
  });

  it('keeps single-line fields on one line', () => {
    expect(sanitizeSingleLine('Lena\nWagner', 40)).toBe('Lena Wagner');
  });

  it('returns an empty string for anything that is not a string', () => {
    for (const input of [null, undefined, 42, {}, [], true]) {
      expect(sanitizeText(input, 20)).toBe('');
    }
  });
});

describe('field guards', () => {
  it('validates player names', () => {
    expect(isValidPlayerName('Markus')).toBe(true);
    expect(isValidPlayerName('')).toBe(false);
    expect(isValidPlayerName('x'.repeat(LIMITS.playerName + 1))).toBe(false);
  });

  it('normalises room codes typed by humans', () => {
    expect(normalizeRoomCode(' gh7k2m ')).toBe('GH7K2M');
    expect(normalizeRoomCode('gh-7k 2m!!')).toBe('GH7K2M');
    expect(normalizeRoomCode(12345)).toBe('');
  });

  it('rejects out-of-range values', () => {
    expect(isEnergy(3)).toBe(true);
    expect(isEnergy(0)).toBe(false);
    expect(isEnergy(6)).toBe(false);
    expect(isEnergy(2.5)).toBe(false);
    expect(isTokenAmount(3)).toBe(true);
    expect(isTokenAmount(4)).toBe(false);
    expect(isTokenAmount(-1)).toBe(false);
    expect(isForgePoints(LIMITS.forgePoints)).toBe(true);
    expect(isForgePoints(LIMITS.forgePoints + 1)).toBe(false);
    expect(isCardIndex(LIMITS.cardsPerCategory)).toBe(false);
    expect(isCardIndex(0)).toBe(true);
    expect(isCategory('loot')).toBe(true);
    expect(isCategory('boss')).toBe(false);
    expect(isClassId('test-mage')).toBe(true);
    expect(isClassId('necromancer')).toBe(false);
    expect(isId('m-1a2b3c')).toBe(true);
    expect(isId('../../etc/passwd')).toBe(false);
    expect(isId('')).toBe(false);
  });
});

describe('experiment validation', () => {
  it('accepts a concrete experiment', () => {
    const result = validateProposal({
      title: 'Pair on the flaky payment specs every Tuesday',
      description: 'Two people, one hour.',
      signal: 'No red build caused by payment specs for two weeks',
      owner: 'Lena',
      reviewBy: 'in 2 sprints',
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('needs a title, an observable sign and a review date', () => {
    const result = validateProposal({ title: 'Do', description: '', signal: 'ok', owner: '', reviewBy: '' });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  it('rejects vague actions such as "communicate better"', () => {
    for (const title of ['Communicate better', 'communicate better in standup', 'Improve communication']) {
      const result = validateProposal({
        title,
        description: '',
        signal: 'People feel better about it',
        reviewBy: 'next month',
        owner: '',
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('too vague');
    }
  });

  it('sanitises the fields it accepts', () => {
    const result = validateProposal({
      title: '<b>Pair on the payment specs</b>',
      description: 'x'.repeat(1000),
      signal: 'No red build for two weeks',
      owner: 'Lena',
      reviewBy: '2026-10-15',
    });
    expect(result.ok).toBe(true);
    expect(result.value.title).not.toContain('<');
    expect(result.value.description).toHaveLength(LIMITS.proposalDescription);
  });
});

import { describe, expect, it } from 'vitest';
import { LIMITS, MAP } from '../src/shared/constants.js';
import {
  clampInt,
  clampPoint,
  clampScale,
  isId,
  isTopicType,
  isValidPlayerName,
  normalizeRoomCode,
  sanitizeSingleLine,
  sanitizeText,
  validateCheckIn,
  validateTopic,
  validateTreatment,
} from '../src/server/validation.js';

describe('text sanitising', () => {
  it('defuses HTML and script payloads', () => {
    const clean = sanitizeText('<script>alert("pwned")</script><img src=x onerror=alert(1)>', 220);
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).toContain('script');
  });

  it('cuts text at the limit and trims the edges', () => {
    expect(sanitizeText(`   ${'a'.repeat(500)}   `, 220)).toHaveLength(220);
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

  it('rejects ids that try to be paths', () => {
    expect(isId('enemy-review-hydra-0')).toBe(true);
    expect(isId('../../etc/passwd')).toBe(false);
    expect(isId('')).toBe(false);
  });

  it('clamps numbers into their range', () => {
    expect(clampScale(3)).toBe(3);
    expect(clampScale(99)).toBe(5);
    expect(clampScale(-4)).toBe(1);
    expect(clampScale('nonsense')).toBe(3);
    expect(clampInt(7, 0, 5, 0)).toBe(5);
    expect(isTopicType('good')).toBe(true);
    expect(isTopicType('terrible')).toBe(false);
  });

  it('keeps every position inside the map', () => {
    const far = clampPoint({ x: 99999, y: -99999 });
    expect(far.x).toBeLessThanOrEqual(MAP.width);
    expect(far.y).toBeGreaterThanOrEqual(0);
    const nonsense = clampPoint('over there');
    expect(Number.isFinite(nonsense.x)).toBe(true);
  });
});

describe('check-in validation', () => {
  it('accepts a filled-in check-in and trims the keyword list', () => {
    const result = validateCheckIn({
      energy: 9,
      pressure: 2,
      satisfaction: 4,
      mood: 'Busy but fine',
      keywords: ['coffee', '', 'a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(result.ok).toBe(true);
    expect(result.value.energy).toBe(5);
    expect(result.value.keywords.length).toBeLessThanOrEqual(LIMITS.maxKeywords);
  });

  it('needs a few words about the sprint', () => {
    expect(validateCheckIn({ mood: '' }).ok).toBe(false);
  });
});

describe('topic validation', () => {
  it('accepts a good topic and sanitises it', () => {
    const result = validateTopic({
      type: 'good',
      title: '<b>Pairing helped</b>',
      description: 'x'.repeat(500),
      intensity: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.value.title).not.toContain('<');
    expect(result.value.description).toHaveLength(LIMITS.topicDescription);
  });

  it('needs a real title and a real type', () => {
    expect(validateTopic({ type: 'good', title: 'ab' }).ok).toBe(false);
    expect(validateTopic({ type: 'chaotic', title: 'Review takes too long' }).ok).toBe(false);
  });
});

describe('treatment validation', () => {
  it('accepts a concrete treatment', () => {
    const result = validateTreatment(
      {
        treatment: 'Reviewers pick up PRs in the morning slot before new work.',
        owner: 'Lena',
        reviewBy: 'in 2 sprints',
        attackPoints: 3,
      },
      5,
    );
    expect(result.ok).toBe(true);
    expect(result.value.attackPoints).toBe(3);
  });

  it('rejects a treatment that says nothing', () => {
    expect(validateTreatment({ treatment: 'fix it' }, 5).ok).toBe(false);
    const vague = validateTreatment({ treatment: 'communicate better' }, 5);
    expect(vague.ok).toBe(false);
    expect(vague.errors.join(' ')).toContain('too vague');
  });

  it('defaults the review moment to the next retro', () => {
    const result = validateTreatment(
      { treatment: 'Split the billing service into two clear owners.' },
      5,
    );
    expect(result.value.reviewBy).toBe('next retro');
  });
});

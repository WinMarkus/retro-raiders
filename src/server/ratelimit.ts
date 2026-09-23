interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window counter. Small, in-memory and good enough for a room of eight
 * people: it stops accidental loops and impatient clicking, not a botnet.
 */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export function resetRateLimits(): void {
  buckets.clear();
}

export function sweepRateLimits(now = Date.now()): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export const RATE_LIMITS = {
  join: { limit: 20, windowMs: 60_000 },
  text: { limit: 240, windowMs: 60_000 },
  action: { limit: 300, windowMs: 60_000 },
  save: { limit: 5, windowMs: 60_000 },
  /** Dungeon generation costs money and takes seconds — per room. */
  ai: { limit: 6, windowMs: 10 * 60_000 },
  /** Character forging — per player, so a full party can forge at once. */
  forge: { limit: 5, windowMs: 10 * 60_000 },
  /** Oracle ideas during fights — per room; a retro has maybe eight fights. */
  ideas: { limit: 20, windowMs: 10 * 60_000 },
  /** The victory painting is the priciest call in the game — per room. */
  art: { limit: 4, windowMs: 30 * 60_000 },
} as const;

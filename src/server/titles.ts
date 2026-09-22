import { createHash } from 'node:crypto';
import type { Category } from '../shared/types.js';

/**
 * Boss titles are generated locally from word lists. No external service is
 * called: the "AI" here is a hash of the card text picking from three arrays.
 */
const PREFIX: Record<Category, string[]> = {
  loot: ['The Gilded', 'The Generous', 'The Shining', 'The Well-Documented'],
  trap: ['The Creeping', 'The Silent', 'The Recurring', 'The Unlogged', 'The Untested'],
  monster: ['The Eternal', 'The Ravenous', 'The Undying', 'The Many-Headed', 'The Legacy'],
};

const NOUN: Record<Category, string[]> = {
  loot: ['Hoard', 'Relic', 'Blessing', 'Windfall'],
  trap: ['Pitfall', 'Snare', 'Tripwire', 'Sinkhole', 'Quicksand'],
  monster: ['Dependency Dragon', 'Merge Hydra', 'Scope Wyrm', 'Incident Wraith', 'Backlog Basilisk'],
};

const EPITHET: Record<Category, string[]> = {
  loot: ['Keeper of Green Builds', 'Patron of Fast Reviews', 'Warden of Working Fridays'],
  trap: [
    'Devourer of Sprints',
    'Eater of Focus Time',
    'Swallower of Estimates',
    'Chewer of Calendars',
  ],
  monster: [
    'Boss of the Blocker Dungeon',
    'Terror of the Staging Realm',
    'Lord of the Reopened Ticket',
    'Keeper of the Flaky Suite',
    'Herald of the 2am Page',
  ],
};

function pick<T>(list: T[], seed: string, salt: string): T {
  const digest = createHash('sha256').update(`${salt}:${seed}`).digest();
  return list[digest[0]! % list.length]!;
}

export function generateBossTitle(category: Category, text: string): string {
  const seed = text.toLowerCase().trim() || category;
  const prefix = pick(PREFIX[category], seed, 'prefix');
  const noun = pick(NOUN[category], seed, 'noun');
  const epithet = pick(EPITHET[category], seed, 'epithet');
  return `${prefix} ${noun}, ${epithet}`;
}

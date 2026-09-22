import { beforeEach, describe, expect, it } from 'vitest';
import type { Topic } from '../src/shared/types.js';
import {
  abandonEncounter,
  attackAvailable,
  buildSummary,
  clearLock,
  collectNearbyPowerUps,
  encounterThreshold,
  findEnemy,
  lockOn,
  resolveEnemy,
} from '../src/server/game.js';
import { fallbackLevel } from '../src/server/generate.js';
import { RoomStore, type PlayerRecord, type Room } from '../src/server/state.js';
import { validateTreatment } from '../src/server/validation.js';

let counter = 0;
function topic(title: string, type: Topic['type'] = 'bad', intensity = 3): Topic {
  counter += 1;
  return { id: `topic-${counter}`, type, title, description: '', intensity };
}

let store: RoomStore;
let room: Room;
let players: PlayerRecord[];

function addPlayers(names: string[]): PlayerRecord[] {
  return names.map((name, index) => {
    const result = store.addPlayer(room, name, `socket-${index}`);
    if (!result.ok) throw new Error('could not add player');
    return result.player;
  });
}

beforeEach(() => {
  store = new RoomStore();
  room = store.create();
  players = addPlayers(['Ada', 'Grace', 'Linus', 'Markus']);
  room.phase = 'level';
  room.level = fallbackLevel([
    topic('Review takes too long', 'bad', 5),
    topic('PRs stuck in review', 'bad', 4),
    topic('Deploys fail on Friday', 'sad', 4),
    topic('Pair programming helped', 'good', 5),
  ]);
});

describe('locking on', () => {
  it('needs three players before the fight opens', () => {
    const enemy = room.level!.enemies[0]!;
    expect(encounterThreshold(room)).toBe(3);

    expect(lockOn(room, players[0]!, enemy.id)).toEqual({ ok: true, opened: false });
    expect(lockOn(room, players[1]!, enemy.id)).toEqual({ ok: true, opened: false });
    expect(room.encounter).toBeNull();

    expect(lockOn(room, players[2]!, enemy.id)).toEqual({ ok: true, opened: true });
    expect(room.encounter?.enemyId).toBe(enemy.id);
    expect(findEnemy(room, enemy.id)?.status).toBe('locked');
    expect(room.encounter?.party).toEqual(['Ada', 'Grace', 'Linus']);
  });

  it('lowers the threshold when fewer players are connected', () => {
    for (const player of players.slice(1)) player.connected = false;
    expect(encounterThreshold(room)).toBe(1);
    const enemy = room.level!.enemies[0]!;
    expect(lockOn(room, players[0]!, enemy.id)).toEqual({ ok: true, opened: true });
  });

  it('moves a player from one enemy to another', () => {
    const [first, second] = room.level!.enemies;
    if (!second) return;
    lockOn(room, players[0]!, first!.id);
    lockOn(room, players[0]!, second.id);
    expect(first!.lockedBy).toHaveLength(0);
    expect(second.lockedBy).toEqual([players[0]!.id]);
  });

  it('refuses a second fight while one is running', () => {
    const [first, second] = room.level!.enemies;
    if (!second) return;
    for (const player of players.slice(0, 3)) lockOn(room, player, first!.id);
    const blocked = lockOn(room, players[3]!, second.id);
    expect(blocked.ok).toBe(false);
  });

  it('closes the fight again when someone releases the lock', () => {
    const enemy = room.level!.enemies[0]!;
    for (const player of players.slice(0, 3)) lockOn(room, player, enemy.id);
    clearLock(room, players[0]!);
    expect(room.encounter).toBeNull();
    expect(enemy.status).toBe('active');
  });

  it('refuses an unknown or already frozen enemy', () => {
    const enemy = room.level!.enemies[0]!;
    expect(lockOn(room, players[0]!, 'enemy-nope').ok).toBe(false);
    enemy.status = 'resolved';
    expect(lockOn(room, players[1]!, enemy.id).ok).toBe(false);
  });
});

describe('attack points', () => {
  it('collects a power-up when a player walks onto it', () => {
    const powerUp = room.level!.powerUps[0]!;
    players[0]!.position = { ...powerUp.position };
    const collected = collectNearbyPowerUps(room, players[0]!);
    expect(collected).toHaveLength(1);
    expect(room.attackCollected).toBe(powerUp.attackPoints);
    expect(powerUp.collectedBy).toBe('Ada');

    // Nobody can pick it up twice.
    players[1]!.position = { ...powerUp.position };
    expect(collectNearbyPowerUps(room, players[1]!)).toHaveLength(0);
  });

  it('ignores power-ups that are out of reach', () => {
    const powerUp = room.level!.powerUps[0]!;
    players[0]!.position = { x: powerUp.position.x + 400, y: powerUp.position.y + 300 };
    expect(collectNearbyPowerUps(room, players[0]!)).toHaveLength(0);
    expect(room.attackCollected).toBe(0);
  });

  it('never lets the party spend more than it collected', () => {
    room.attackCollected = 4;
    const validation = validateTreatment(
      { treatment: 'Reviewers take PRs before new work', attackPoints: 40 },
      attackAvailable(room),
    );
    expect(validation.ok).toBe(false);
    expect(validation.value.attackPoints).toBeLessThanOrEqual(4);
  });
});

describe('resolving an enemy', () => {
  it('freezes the enemy, spends the points and clears the locks', () => {
    room.attackCollected = 6;
    const enemy = room.level!.enemies[0]!;
    for (const player of players.slice(0, 3)) lockOn(room, player, enemy.id);

    const validation = validateTreatment(
      {
        treatment: 'Reviewers pick up PRs in the morning slot before starting new work.',
        owner: 'Lena',
        reviewBy: 'next retro',
        attackPoints: 4,
      },
      attackAvailable(room),
    );
    expect(validation.ok).toBe(true);

    const resolution = resolveEnemy(room, enemy, validation.value);
    expect(enemy.status).toBe('resolved');
    expect(enemy.lockedBy).toEqual([]);
    expect(room.encounter).toBeNull();
    expect(room.attackSpent).toBe(4);
    expect(attackAvailable(room)).toBe(2);
    expect(resolution.party).toEqual(['Ada', 'Grace', 'Linus']);
    expect(players[0]!.lockedEnemyId).toBeNull();
  });

  it('puts an abandoned enemy back on the map', () => {
    const enemy = room.level!.enemies[0]!;
    for (const player of players.slice(0, 3)) lockOn(room, player, enemy.id);
    abandonEncounter(room);
    expect(enemy.status).toBe('active');
    expect(enemy.lockedBy).toEqual([]);
    expect(room.encounter).toBeNull();
  });
});

describe('the victory report', () => {
  it('lists frozen enemies, leftovers and action items', () => {
    room.attackCollected = 8;
    const enemy = room.level!.enemies[0]!;
    for (const player of players.slice(0, 3)) lockOn(room, player, enemy.id);
    resolveEnemy(room, enemy, {
      treatment: 'Reviewers pick up PRs in the morning slot.',
      owner: 'Lena',
      reviewBy: 'next retro',
      attackPoints: 3,
    });
    const summary = buildSummary(room);
    expect(summary.resolved).toHaveLength(1);
    expect(summary.unresolved.length).toBe(room.level!.enemies.length - 1);
    expect(summary.actionItems[0]).toContain('Lena');
    expect(summary.actionItems[0]).toContain('next retro');
    expect(summary.stats.some((stat) => stat.value.includes('3 spent'))).toBe(true);
  });

  it('says so when nothing was resolved', () => {
    const summary = buildSummary(room);
    expect(summary.resolved).toHaveLength(0);
    expect(summary.headline.toLowerCase()).toContain('nothing');
  });
});

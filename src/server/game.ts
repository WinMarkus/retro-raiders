import { IDEA_WINDOW_MS, MAP } from '../shared/constants.js';
import type { Enemy, PowerUp, Resolution, Summary, Topic } from '../shared/types.js';
import { connectedPlayers, type PlayerRecord, type Room } from './state.js';
import type { TreatmentInput } from './validation.js';

export function findEnemy(room: Room, enemyId: string): Enemy | undefined {
  return room.level?.enemies.find((enemy) => enemy.id === enemyId);
}

export function findPowerUp(room: Room, powerUpId: string): PowerUp | undefined {
  return room.level?.powerUps.find((powerUp) => powerUp.id === powerUpId);
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function attackAvailable(room: Room): number {
  return Math.max(0, room.attackCollected - room.attackSpent);
}

/**
 * Walking onto a power-up collects it for the whole party — the points are a
 * shared pool, because the good things were shared too.
 */
export function collectNearbyPowerUps(room: Room, player: PlayerRecord): PowerUp[] {
  if (!room.level) return [];
  const collected: PowerUp[] = [];
  for (const powerUp of room.level.powerUps) {
    if (powerUp.collectedBy) continue;
    if (distance(powerUp.position, player.position) > MAP.interactRadius) continue;
    powerUp.collectedBy = player.name;
    room.attackCollected += powerUp.attackPoints;
    collected.push(powerUp);
  }
  return collected;
}

/** How many players must lock on before the fight starts. */
export function encounterThreshold(room: Room): number {
  const connected = connectedPlayers(room).length;
  return Math.max(1, Math.floor(connected / 2) + 1);
}

export function partyLine(room: Room, ids: string[]): string {
  const fighters = ids
    .map((id) => room.players.get(id))
    .filter((player): player is PlayerRecord => Boolean(player))
    .map((player) => {
      const character = player.character;
      return character ? `${character.characterName}, ${character.className}` : player.name;
    });
  if (fighters.length === 0) return 'The party';
  if (fighters.length === 1) return fighters[0]!;
  return `${fighters.slice(0, -1).join(', ')} and ${fighters[fighters.length - 1]}`;
}

export function encounterStory(room: Room, enemy: Enemy): string {
  const fighters = partyLine(room, enemy.lockedBy);
  const source = enemy.sourceTopics.slice(0, 2).join(' and ') || 'the sprint backlog';
  return `${fighters} step into the torchlight as ${enemy.name} rises from ${source}. Strength ${enemy.strength}/5 - name the real problem, spend the points, and freeze it in place.`;
}

export function victoryStory(resolution: Resolution): string {
  const cost = `${resolution.attackSpent} attack point${resolution.attackSpent === 1 ? '' : 's'}`;
  const owner = resolution.owner ? ` ${resolution.owner} carries the next move.` : '';
  return `${resolution.enemyName} cracks under a clear treatment and ${cost}. The room has a way forward before the ice settles.${owner}`;
}

export function clearLock(room: Room, player: PlayerRecord): void {
  if (!player.lockedEnemyId) return;
  const enemy = findEnemy(room, player.lockedEnemyId);
  player.lockedEnemyId = null;
  if (!enemy) return;
  enemy.lockedBy = enemy.lockedBy.filter((id) => id !== player.id);
  if (enemy.status === 'locked' && enemy.lockedBy.length < encounterThreshold(room)) {
    enemy.status = 'active';
    if (room.encounter?.enemyId === enemy.id) room.encounter = null;
  }
}

export type LockOutcome =
  | { ok: true; opened: boolean }
  | { ok: false; error: string };

export function lockOn(room: Room, player: PlayerRecord, enemyId: string): LockOutcome {
  const enemy = findEnemy(room, enemyId);
  if (!enemy) return { ok: false, error: 'That enemy is not on the map.' };
  if (enemy.status === 'resolved' || enemy.status === 'frozen') {
    return { ok: false, error: `${enemy.name} is already frozen.` };
  }
  if (room.encounter && room.encounter.enemyId !== enemy.id) {
    return { ok: false, error: 'The party is already in a fight. Finish that one first.' };
  }
  if (player.lockedEnemyId === enemy.id) return { ok: true, opened: false };

  clearLock(room, player);
  enemy.lockedBy.push(player.id);
  player.lockedEnemyId = enemy.id;

  if (enemy.lockedBy.length >= encounterThreshold(room) && !room.encounter) {
    openEncounter(room, enemy);
    return { ok: true, opened: true };
  }

  return { ok: true, opened: false };
}

export function openEncounter(room: Room, enemy: Enemy, now = Date.now()): void {
  enemy.status = 'locked';
  room.proposalAuthors.clear();
  room.encounter = {
    enemyId: enemy.id,
    openedAt: now,
    party: enemy.lockedBy
      .map((id) => room.players.get(id)?.name)
      .filter((name): name is string => Boolean(name)),
    story: encounterStory(room, enemy),
    proposals: [],
    ideasUntil: now + IDEA_WINDOW_MS,
    oracleBusy: false,
  };
}

/**
 * The facilitator can skip the majority vote, but only for the enemy they are
 * locked onto themselves, so the choice is still visible on the map.
 */
export function forceEncounter(room: Room, player: PlayerRecord): LockOutcome {
  if (room.encounter) return { ok: false, error: 'The party is already in a fight.' };
  const enemy = player.lockedEnemyId ? findEnemy(room, player.lockedEnemyId) : undefined;
  if (!enemy || enemy.status === 'resolved') return { ok: false, error: 'Lock onto an enemy first.' };
  openEncounter(room, enemy);
  return { ok: true, opened: true };
}

export function resolveEnemy(
  room: Room,
  enemy: Enemy,
  input: TreatmentInput,
): Resolution {
  const party = enemy.lockedBy
    .map((id) => room.players.get(id)?.name)
    .filter((name): name is string => Boolean(name));

  const resolution: Resolution = {
    enemyId: enemy.id,
    enemyName: enemy.name,
    story: '',
    treatment: input.treatment,
    owner: input.owner || null,
    reviewBy: input.reviewBy,
    attackSpent: input.attackPoints,
    party: party.length > 0 ? party : ['the party'],
    alternatives: (room.encounter?.enemyId === enemy.id ? room.encounter.proposals : [])
      .map((proposal) => proposal.text)
      .filter((text) => text.trim() !== input.treatment.trim()),
    resolvedAt: Date.now(),
  };
  resolution.story = victoryStory(resolution);

  room.resolutions.push(resolution);
  room.attackSpent += input.attackPoints;
  enemy.status = 'resolved';

  for (const id of enemy.lockedBy) {
    const player = room.players.get(id);
    if (player) player.lockedEnemyId = null;
  }
  enemy.lockedBy = [];
  if (room.encounter?.enemyId === enemy.id) room.encounter = null;
  room.proposalAuthors.clear();

  return resolution;
}

export function abandonEncounter(room: Room): void {
  if (!room.encounter) return;
  const enemy = findEnemy(room, room.encounter.enemyId);
  if (enemy) {
    enemy.status = 'active';
    for (const id of enemy.lockedBy) {
      const player = room.players.get(id);
      if (player) player.lockedEnemyId = null;
    }
    enemy.lockedBy = [];
  }
  room.encounter = null;
}

export function allTopics(room: Room): Topic[] {
  return [...room.topics.values()];
}

export function everyoneReady(room: Room): boolean {
  const players = connectedPlayers(room);
  return players.length > 0 && players.every((player) => player.ready);
}

export function clearReady(room: Room): void {
  for (const player of room.players.values()) player.ready = false;
}

/** The victory report: a game screen that a team can still paste into a wiki. */
export function buildSummary(room: Room): Summary {
  const enemies = room.level?.enemies ?? [];
  const resolved = room.resolutions;
  const unresolved = enemies.filter((enemy) => enemy.status !== 'resolved');
  const topics = allTopics(room);
  const good = topics.filter((topic) => topic.type === 'good').length;

  const headline =
    unresolved.length === 0 && enemies.length > 0
      ? 'Dungeon cleared. Every blocker in this level has a treatment.'
      : resolved.length === 0
        ? 'The party made it out, but nothing was pinned down yet.'
        : `${resolved.length} of ${enemies.length} enemies frozen. The rest are still down there.`;

  const stats = [
    { title: 'Party', value: String(room.players.size) },
    { title: 'Topics raised', value: `${topics.length} (${good} good)` },
    { title: 'Enemies', value: `${resolved.length} resolved / ${enemies.length} total` },
    { title: 'Attack points', value: `${room.attackSpent} spent of ${room.attackCollected} collected` },
  ];

  const actionItems = resolved.map((resolution) => {
    const owner = resolution.owner ? `${resolution.owner}` : 'unowned';
    return `${resolution.treatment} — ${owner}, review ${resolution.reviewBy} (beat ${resolution.enemyName})`;
  });
  if (unresolved.length > 0) {
    actionItems.push(
      `Still standing: ${unresolved.map((enemy) => enemy.name).join(', ')}. Carry these into the next retro.`,
    );
  }

  return { headline, stats, resolved, unresolved, actionItems };
}

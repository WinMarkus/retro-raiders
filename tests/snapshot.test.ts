import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/shared/constants.js';
import { enterPhase, mergeCards, resolveBoss, setTokens } from '../src/server/game.js';
import { buildCommitMessage, buildSavePath, buildSnapshot } from '../src/server/snapshot.js';
import { RoomStore, type PlayerRecord, type Room } from '../src/server/state.js';

function playedRoom(): { room: Room; players: PlayerRecord[] } {
  const store = new RoomStore();
  const room = store.create();
  const players = ['Markus', 'Lena', 'Ada'].map((name, index) => {
    const result = store.addPlayer(room, name, `socket-${index}`);
    if (!result.ok) throw new Error('setup failed');
    return result.player;
  });

  players[0]!.energy = 4;
  players[1]!.energy = 2;
  players[2]!.energy = 3;

  const drafts = [
    { id: players[0]!.id, loot: 'Preview environments saved a day', trap: 'Reviews take three days', monster: 'Flaky payment tests' },
    { id: players[1]!.id, loot: 'Docs for the release steps', trap: 'Reviews are slow', monster: 'Scope arrives late' },
    { id: players[2]!.id, loot: 'Pairing on Fridays', trap: 'Staging drifted', monster: 'Dependency upgrades' },
  ];
  for (const entry of drafts) {
    const draft = room.drafts.get(entry.id)!;
    draft.loot[0] = entry.loot;
    draft.trap[0] = entry.trap;
    draft.monster[0] = entry.monster;
  }

  enterPhase(room, 'reveal');

  const slow = room.cards.find((card) => card.texts[0] === 'Reviews take three days')!;
  const alsoSlow = room.cards.find((card) => card.texts[0] === 'Reviews are slow')!;
  mergeCards(room, [slow.id, alsoSlow.id]);

  const flaky = room.cards.find((card) => card.texts[0] === 'Flaky payment tests')!;
  setTokens(room, players[0]!.id, flaky.id, 3);
  setTokens(room, players[1]!.id, flaky.id, 2);
  setTokens(room, players[2]!.id, flaky.id, 1);

  enterPhase(room, 'discuss');
  flaky.notes = 'Nobody owns the payment suite since the split.';

  enterPhase(room, 'boss');
  for (const player of players) room.boss.votes.set(player.id, flaky.id);
  resolveBoss(room);

  room.forge.proposals.push({
    id: 'p-1',
    authorId: players[0]!.id,
    title: 'Pair on the flaky payment specs every Tuesday',
    description: 'Two people, one hour.',
    signal: 'No red build caused by payment specs for two weeks',
    owner: 'Lena',
    reviewBy: 'in 2 sprints',
  });
  room.forge.allocations.get(players[1]!.id)!.set('p-1', 7);
  room.forge.revealed = true;
  room.forge.selected = ['p-1'];

  enterPhase(room, 'forge');
  enterPhase(room, 'victory');

  return { room, players };
}

describe('snapshot contents', () => {
  it('contains every field the team needs later', () => {
    const { room } = playedRoom();
    const snapshot = buildSnapshot(room, new Date('2026-03-04T09:05:00Z'));

    expect(snapshot.app).toBe('Retro Raiders: The Blocker Dungeon');
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snapshot.roomCode).toBe(room.code);
    expect(snapshot.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.participants).toEqual(['Markus', 'Lena', 'Ada']);
    expect(snapshot.energy.average).toBe(3);
    expect(snapshot.energy.responses).toBe(3);
    expect(snapshot.loot).toHaveLength(3);
    expect(snapshot.traps).toHaveLength(2);
    expect(snapshot.monsters).toHaveLength(3);
    expect(snapshot.merges).toHaveLength(1);
    expect(snapshot.merges[0]!.texts).toEqual(
      expect.arrayContaining(['Reviews take three days', 'Reviews are slow']),
    );
    expect(Object.values(snapshot.allocations).reduce((sum, value) => sum + value, 0)).toBe(6);
    expect(snapshot.discussionNotes.some((note) => note.notes.includes('Nobody owns'))).toBe(true);
    expect(snapshot.finalBoss?.title).toBeTruthy();
    expect(snapshot.finalBoss?.votes).toBe(3);
    expect(snapshot.experiments[0]!.points).toBe(7);
    expect(snapshot.experiments[0]!.selected).toBe(true);
    expect(snapshot.owners).toEqual(['Lena']);
    expect(snapshot.reviewDates).toEqual(['in 2 sprints']);
  });

  it('never carries a player id, socket id or card authorship', () => {
    const { room, players } = playedRoom();
    const serialised = JSON.stringify(buildSnapshot(room));

    for (const player of players) {
      expect(serialised).not.toContain(player.id);
      if (player.socketId) expect(serialised).not.toContain(player.socketId);
    }
    expect(serialised).not.toContain('authorId');
    expect(serialised).not.toContain('socketId');
    expect(serialised).not.toContain(room.secret);

    const parsed = JSON.parse(serialised) as Record<string, unknown>;
    for (const card of [...(parsed.loot as unknown[]), ...(parsed.traps as unknown[]), ...(parsed.monsters as unknown[])]) {
      expect(Object.keys(card as object)).not.toContain('authorIds');
      expect(Object.keys(card as object)).not.toContain('sourceIds');
    }
  });
});

describe('save path', () => {
  it('uses the documented folder, timestamp and room code', () => {
    const path = buildSavePath('GH7K2M', new Date('2026-03-04T09:05:31Z'));
    expect(path).toBe('retro-saves/retro-raiders/2026-03-04_09-05_room-GH7K2M.json');
  });

  it('gives different files to saves in different minutes and different rooms', () => {
    const first = buildSavePath('AAA111', new Date('2026-03-04T09:05:00Z'));
    const second = buildSavePath('AAA111', new Date('2026-03-04T09:06:00Z'));
    const third = buildSavePath('BBB222', new Date('2026-03-04T09:05:00Z'));
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('strips anything that is not part of a room code', () => {
    expect(buildSavePath('../../etc/passwd')).toContain('room-ETCPASSWD.json');
    expect(buildSavePath('')).toContain('room-UNKNOWN.json');
  });

  it('writes a commit message a human can read in the log', () => {
    expect(buildCommitMessage('GH7K2M', new Date('2026-03-04T09:05:00Z'))).toBe(
      'Retro Raiders: save retrospective for room GH7K2M (2026-03-04)',
    );
  });
});

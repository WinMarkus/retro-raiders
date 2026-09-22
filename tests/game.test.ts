import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, PHASES } from '../src/shared/constants.js';
import {
  allocateForge,
  autoSelectExperiments,
  bossVoteCounts,
  computeShortlist,
  enterPhase,
  forgeTotals,
  mergeCards,
  nextPhase,
  previousPhase,
  resetGame,
  resolveBoss,
  setTokens,
  tickDiscussion,
  tokenTotals,
} from '../src/server/game.js';
import { RoomStore, type PlayerRecord, type Room } from '../src/server/state.js';

function seed(names: string[]): { store: RoomStore; room: Room; players: PlayerRecord[] } {
  const store = new RoomStore();
  const room = store.create();
  const players = names.map((name, index) => {
    const result = store.addPlayer(room, name, `socket-${index}`);
    if (!result.ok) throw new Error(`could not add ${name}`);
    return result.player;
  });
  return { store, room, players };
}

function pack(room: Room, playerId: string, texts: { loot?: string[]; trap?: string[]; monster?: string[] }): void {
  const draft = room.drafts.get(playerId);
  if (!draft) throw new Error('no draft');
  for (const [category, values] of Object.entries(texts)) {
    (values ?? []).forEach((text, index) => {
      draft[category as 'loot' | 'trap' | 'monster'][index] = text;
    });
  }
}

describe('phase order', () => {
  it('walks forwards and backwards through every phase', () => {
    expect(PHASES[0]).toBe('lobby');
    expect(nextPhase('lobby')).toBe('adventurer');
    expect(nextPhase('victory')).toBeNull();
    expect(previousPhase('lobby')).toBeNull();
    expect(previousPhase('explore')).toBe('reveal');

    let phase = PHASES[0]!;
    const visited = [phase];
    for (;;) {
      const next = nextPhase(phase);
      if (!next) break;
      phase = next;
      visited.push(phase);
    }
    expect(visited).toEqual(PHASES);
  });

  it('clears the ready set on every transition', () => {
    const { room, players } = seed(['Markus', 'Lena']);
    room.ready.add(players[0]!.id);
    enterPhase(room, 'pack');
    expect(room.ready.size).toBe(0);
  });
});

describe('building the dungeon', () => {
  let room: Room;
  let players: PlayerRecord[];

  beforeEach(() => {
    const seeded = seed(['Markus', 'Lena', 'Ada']);
    room = seeded.room;
    players = seeded.players;
    pack(room, players[0]!.id, { loot: ['Preview environments'], trap: ['Slow reviews'], monster: ['Flaky tests'] });
    pack(room, players[1]!.id, { loot: ['Pairing on Fridays'], trap: ['Slow reviews'] });
    pack(room, players[2]!.id, { monster: ['Flaky tests', '   '] });
  });

  it('turns filled drafts into cards and drops blank ones', () => {
    enterPhase(room, 'reveal');
    expect(room.cards).toHaveLength(6);
    expect(room.cards.every((card) => card.texts[0]!.trim().length > 0)).toBe(true);
  });

  it('never exposes a card id that contains the author id', () => {
    enterPhase(room, 'reveal');
    for (const card of room.cards) {
      for (const player of players) {
        expect(card.id).not.toContain(player.id);
      }
    }
  });

  it('keeps tokens and notes when the packing phase is reopened', () => {
    enterPhase(room, 'reveal');
    const card = room.cards[0]!;
    card.notes = 'Root cause: nobody owns the queue';
    setTokens(room, players[0]!.id, card.id, 2);

    enterPhase(room, 'pack');
    enterPhase(room, 'reveal');

    const again = room.cards.find((item) => item.id === card.id);
    expect(again?.notes).toBe('Root cause: nobody owns the queue');
    expect(tokenTotals(room).get(card.id)).toBe(2);
  });

  it('forgets tokens for cards that were deleted in the meantime', () => {
    enterPhase(room, 'reveal');
    const card = room.cards.find((item) => item.texts[0] === 'Pairing on Fridays')!;
    setTokens(room, players[0]!.id, card.id, 3);
    pack(room, players[1]!.id, { loot: [''] });

    enterPhase(room, 'pack');
    enterPhase(room, 'reveal');

    expect(room.cards.some((item) => item.id === card.id)).toBe(false);
    expect(room.tokens.get(players[0]!.id)?.get(card.id)).toBeUndefined();
  });
});

describe('merging duplicates', () => {
  it('keeps both original texts and sums the tokens', () => {
    const { room, players } = seed(['Markus', 'Lena']);
    pack(room, players[0]!.id, { trap: ['Slow reviews'] });
    pack(room, players[1]!.id, { trap: ['Reviews take days'] });
    enterPhase(room, 'reveal');

    const [first, second] = room.cards;
    setTokens(room, players[0]!.id, first!.id, 1);
    setTokens(room, players[1]!.id, second!.id, 1);

    const result = mergeCards(room, [first!.id, second!.id]);
    expect(result.ok).toBe(true);
    expect(room.cards).toHaveLength(1);
    const merged = room.cards[0]!;
    expect(merged.texts).toEqual(expect.arrayContaining(['Slow reviews', 'Reviews take days']));
    expect(tokenTotals(room).get(merged.id)).toBe(2);
  });

  it('refuses to merge across categories or with a single card', () => {
    const { room, players } = seed(['Markus']);
    pack(room, players[0]!.id, { trap: ['Slow reviews'], monster: ['Flaky tests'] });
    enterPhase(room, 'reveal');
    const trap = room.cards.find((card) => card.category === 'trap')!;
    const monster = room.cards.find((card) => card.category === 'monster')!;

    expect(mergeCards(room, [trap.id]).ok).toBe(false);
    expect(mergeCards(room, [trap.id, monster.id]).ok).toBe(false);
    expect(room.cards).toHaveLength(2);
  });
});

describe('energy tokens', () => {
  it('lets a player spend at most three tokens in total', () => {
    const { room, players } = seed(['Markus', 'Lena']);
    pack(room, players[0]!.id, { trap: ['A', 'B'], monster: ['C'] });
    enterPhase(room, 'reveal');
    const [a, b, c] = room.cards;

    expect(setTokens(room, players[1]!.id, a!.id, 2).ok).toBe(true);
    expect(setTokens(room, players[1]!.id, b!.id, 1).ok).toBe(true);
    const overspend = setTokens(room, players[1]!.id, c!.id, 1);
    expect(overspend.ok).toBe(false);
    expect(overspend.error).toContain('3 energy tokens');

    expect(setTokens(room, players[1]!.id, a!.id, 0).ok).toBe(true);
    expect(setTokens(room, players[1]!.id, c!.id, 2).ok).toBe(true);
  });

  it('caps a single card at three tokens per player', () => {
    const { room, players } = seed(['Markus']);
    pack(room, players[0]!.id, { trap: ['A'] });
    enterPhase(room, 'reveal');
    expect(setTokens(room, players[0]!.id, room.cards[0]!.id, LIMITS.maxTokensPerCard).ok).toBe(true);
    expect(tokenTotals(room).get(room.cards[0]!.id)).toBe(LIMITS.maxTokensPerCard);
  });
});

describe('discussion', () => {
  it('queues the highest rated cards first and ticks the clock', () => {
    const { room, players } = seed(['Markus', 'Lena']);
    pack(room, players[0]!.id, { trap: ['Low'], monster: ['High'] });
    enterPhase(room, 'reveal');
    const high = room.cards.find((card) => card.texts[0] === 'High')!;
    const low = room.cards.find((card) => card.texts[0] === 'Low')!;
    setTokens(room, players[0]!.id, high.id, 3);
    setTokens(room, players[1]!.id, low.id, 1);

    enterPhase(room, 'discuss');
    expect(room.discussion?.order[0]).toBe(high.id);
    expect(room.tokensRevealed).toBe(true);

    room.discussion!.running = true;
    const before = room.discussion!.secondsLeft;
    expect(tickDiscussion(room)).toBe(true);
    expect(room.discussion!.secondsLeft).toBe(before - 1);

    room.discussion!.secondsLeft = 1;
    tickDiscussion(room);
    expect(room.discussion!.secondsLeft).toBe(0);
    expect(room.discussion!.running).toBe(false);
  });
});

describe('final boss', () => {
  it('shortlists traps and monsters only', () => {
    const { room, players } = seed(['Markus']);
    pack(room, players[0]!.id, { loot: ['Nice loot'], trap: ['Bad trap'], monster: ['Big monster'] });
    enterPhase(room, 'reveal');
    const shortlist = computeShortlist(room);
    const categories = shortlist.map((id) => room.cards.find((card) => card.id === id)?.category);
    expect(categories).not.toContain('loot');
    expect(categories.length).toBe(2);
  });

  it('runs a runoff on a tie and then crowns a winner with a title', () => {
    const { room, players } = seed(['Markus', 'Lena', 'Ada', 'Sam']);
    pack(room, players[0]!.id, { trap: ['Slow reviews'], monster: ['Flaky tests'] });
    enterPhase(room, 'reveal');
    enterPhase(room, 'boss');

    const [first, second] = room.boss.shortlist;
    room.boss.votes.set(players[0]!.id, first!);
    room.boss.votes.set(players[1]!.id, first!);
    room.boss.votes.set(players[2]!.id, second!);
    room.boss.votes.set(players[3]!.id, second!);

    const tied = resolveBoss(room);
    expect(tied.kind).toBe('runoff');
    expect(room.boss.runoff).toBe(true);
    expect(room.boss.round).toBe(2);
    expect(room.boss.votes.size).toBe(0);
    expect(room.boss.shortlist).toHaveLength(2);

    room.boss.votes.set(players[0]!.id, first!);
    room.boss.votes.set(players[1]!.id, first!);
    room.boss.votes.set(players[2]!.id, second!);
    const decided = resolveBoss(room);
    expect(decided.kind).toBe('winner');
    expect(room.boss.winnerCardId).toBe(first);
    expect(room.boss.title).toBeTruthy();
    expect(bossVoteCounts(room).get(first!)).toBe(2);
  });

  it('reports an empty vote instead of inventing a boss', () => {
    const { room, players } = seed(['Markus']);
    pack(room, players[0]!.id, { trap: ['Slow reviews'] });
    enterPhase(room, 'reveal');
    enterPhase(room, 'boss');
    expect(resolveBoss(room).kind).toBe('empty');
    expect(room.boss.winnerCardId).toBeNull();
  });
});

describe('the forge', () => {
  it('limits a player to ten points and totals them per experiment', () => {
    const { room, players } = seed(['Markus', 'Lena']);
    room.forge.proposals.push(
      { id: 'p-1', authorId: players[0]!.id, title: 'Pair on flaky specs', description: '', signal: 'Green suite', owner: '', reviewBy: 'in 2 sprints' },
      { id: 'p-2', authorId: players[1]!.id, title: 'Review rota', description: '', signal: 'Reviews under a day', owner: '', reviewBy: 'in 2 sprints' },
    );

    expect(allocateForge(room, players[0]!.id, 'p-1', 6).ok).toBe(true);
    const overspend = allocateForge(room, players[0]!.id, 'p-2', 6);
    expect(overspend.ok).toBe(false);
    expect(allocateForge(room, players[0]!.id, 'p-2', 4).ok).toBe(true);
    expect(allocateForge(room, players[1]!.id, 'p-2', LIMITS.forgePoints).ok).toBe(true);

    const totals = forgeTotals(room);
    expect(totals.get('p-1')).toBe(6);
    expect(totals.get('p-2')).toBe(14);

    autoSelectExperiments(room);
    expect(room.forge.selected).toEqual(['p-2', 'p-1']);
    expect(room.forge.selected.length).toBeLessThanOrEqual(LIMITS.maxSelectedExperiments);
  });
});

describe('reset', () => {
  it('wipes the raid but keeps the party', () => {
    const { room, players } = seed(['Markus', 'Lena']);
    pack(room, players[0]!.id, { trap: ['Slow reviews'] });
    enterPhase(room, 'reveal');
    setTokens(room, players[0]!.id, room.cards[0]!.id, 2);
    room.forge.proposals.push({ id: 'p-1', authorId: players[0]!.id, title: 'x', description: '', signal: '', owner: '', reviewBy: '' });

    resetGame(room);

    expect(room.phase).toBe('lobby');
    expect(room.cards).toHaveLength(0);
    expect(room.forge.proposals).toHaveLength(0);
    expect(room.players.size).toBe(2);
    expect(room.drafts.get(players[0]!.id)?.trap.every((text) => text === '')).toBe(true);
  });
});

import { randomBytes, randomInt } from 'node:crypto';
import { CATEGORIES, LIMITS, PHASES } from '../shared/constants.js';
import type { Category, Phase, Summary, SummaryCard, SummaryExperiment } from '../shared/types.js';
import { cardIdFor, connectedPlayers, type CardRecord, type Room } from './state.js';
import { generateBossTitle } from './titles.js';

export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/* ---------------------------------------------------------------- cards -- */

interface SourceCard {
  id: string;
  category: Category;
  text: string;
  authorId: string;
}

function collectSources(room: Room): Map<string, SourceCard> {
  const sources = new Map<string, SourceCard>();
  for (const [playerId, draft] of room.drafts) {
    if (!room.players.has(playerId)) continue;
    for (const category of CATEGORIES) {
      draft[category].forEach((text, index) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const id = cardIdFor(room, playerId, category, index);
        sources.set(id, { id, category, text: trimmed, authorId: playerId });
      });
    }
  }
  return sources;
}

/**
 * Turns the private drafts into dungeon rooms. Safe to run again after the
 * facilitator reopens the packing phase: surviving cards keep their id, their
 * tokens, their notes and their place in the shuffled order.
 */
export function rebuildCards(room: Room): void {
  const sources = collectSources(room);
  const consumed = new Set<string>();
  const kept: CardRecord[] = [];

  for (const card of room.cards) {
    const alive = card.sourceIds.filter((id) => sources.has(id));
    if (alive.length === 0) continue;
    card.sourceIds = alive;
    card.texts = alive.map((id) => sources.get(id)!.text);
    card.authorIds = alive.map((id) => sources.get(id)!.authorId);
    card.category = sources.get(alive[0]!)!.category;
    alive.forEach((id) => consumed.add(id));
    kept.push(card);
  }

  const fresh: CardRecord[] = [];
  for (const source of sources.values()) {
    if (consumed.has(source.id)) continue;
    fresh.push({
      id: source.id,
      category: source.category,
      texts: [source.text],
      authorIds: [source.authorId],
      sourceIds: [source.id],
      notes: '',
      discussed: false,
    });
  }
  shuffle(fresh);

  room.cards = [...kept, ...fresh];
  const liveIds = new Set(room.cards.map((card) => card.id));
  for (const allocation of room.tokens.values()) {
    for (const cardId of [...allocation.keys()]) {
      if (!liveIds.has(cardId)) allocation.delete(cardId);
    }
  }
  if (room.discussion) {
    room.discussion.order = room.discussion.order.filter((id) => liveIds.has(id));
    room.discussion.index = Math.min(room.discussion.index, Math.max(0, room.discussion.order.length - 1));
  }
  room.boss.shortlist = room.boss.shortlist.filter((id) => liveIds.has(id));
}

export function findCard(room: Room, cardId: string): CardRecord | undefined {
  return room.cards.find((card) => card.id === cardId);
}

export function mergeCards(room: Room, cardIds: string[]): { ok: boolean; error?: string } {
  const unique = [...new Set(cardIds)];
  if (unique.length < 2) return { ok: false, error: 'Pick at least two rooms to merge.' };
  const cards = unique.map((id) => findCard(room, id)).filter((card): card is CardRecord => !!card);
  if (cards.length !== unique.length) return { ok: false, error: 'One of those rooms no longer exists.' };
  const category = cards[0]!.category;
  if (cards.some((card) => card.category !== category)) {
    return { ok: false, error: 'Only rooms of the same kind can be merged.' };
  }

  const mergedId = `m-${randomBytes(6).toString('hex')}`;
  const merged: CardRecord = {
    id: mergedId,
    category,
    texts: cards.flatMap((card) => card.texts),
    authorIds: cards.flatMap((card) => card.authorIds),
    sourceIds: cards.flatMap((card) => card.sourceIds),
    notes: cards.map((card) => card.notes).filter(Boolean).join('\n'),
    discussed: cards.some((card) => card.discussed),
  };

  const firstIndex = room.cards.findIndex((card) => card.id === cards[0]!.id);
  room.cards = room.cards.filter((card) => !unique.includes(card.id));
  room.cards.splice(Math.max(0, firstIndex), 0, merged);

  for (const allocation of room.tokens.values()) {
    let sum = 0;
    for (const id of unique) {
      sum += allocation.get(id) ?? 0;
      allocation.delete(id);
    }
    if (sum > 0) allocation.set(mergedId, Math.min(sum, LIMITS.maxTokensPerCard));
  }

  if (room.discussion) {
    const replaced: string[] = [];
    for (const id of room.discussion.order) {
      if (unique.includes(id)) {
        if (!replaced.includes(mergedId)) replaced.push(mergedId);
      } else {
        replaced.push(id);
      }
    }
    room.discussion.order = replaced;
    room.discussion.index = Math.min(room.discussion.index, Math.max(0, replaced.length - 1));
  }
  room.boss.shortlist = [...new Set(room.boss.shortlist.map((id) => (unique.includes(id) ? mergedId : id)))];
  return { ok: true };
}

/* --------------------------------------------------------------- tokens -- */

export function tokensSpentBy(room: Room, playerId: string): number {
  const allocation = room.tokens.get(playerId);
  if (!allocation) return 0;
  let total = 0;
  for (const value of allocation.values()) total += value;
  return total;
}

export function tokenTotals(room: Room): Map<string, number> {
  const totals = new Map<string, number>();
  for (const card of room.cards) totals.set(card.id, 0);
  for (const allocation of room.tokens.values()) {
    for (const [cardId, value] of allocation) {
      if (!totals.has(cardId)) continue;
      totals.set(cardId, (totals.get(cardId) ?? 0) + value);
    }
  }
  return totals;
}

export function spentByPlayer(room: Room): Record<string, number> {
  const result: Record<string, number> = {};
  for (const player of room.players.values()) {
    result[player.id] = tokensSpentBy(room, player.id);
  }
  return result;
}

export function setTokens(
  room: Room,
  playerId: string,
  cardId: string,
  amount: number,
): { ok: boolean; error?: string } {
  if (!findCard(room, cardId)) return { ok: false, error: 'That room is not on the map.' };
  const allocation = room.tokens.get(playerId) ?? new Map<string, number>();
  room.tokens.set(playerId, allocation);
  const current = allocation.get(cardId) ?? 0;
  const spentElsewhere = tokensSpentBy(room, playerId) - current;
  if (spentElsewhere + amount > LIMITS.tokensPerPlayer) {
    return { ok: false, error: `You only carry ${LIMITS.tokensPerPlayer} energy tokens.` };
  }
  if (amount <= 0) allocation.delete(cardId);
  else allocation.set(cardId, amount);
  return { ok: true };
}

export function rankedCards(room: Room, categories?: Category[]): CardRecord[] {
  const totals = tokenTotals(room);
  return room.cards
    .filter((card) => !categories || categories.includes(card.category))
    .slice()
    .sort((a, b) => {
      const diff = (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    });
}

export function computeDiscussionOrder(room: Room): string[] {
  const totals = tokenTotals(room);
  const ranked = rankedCards(room).filter((card) => (totals.get(card.id) ?? 0) > 0);
  const pool = ranked.length > 0 ? ranked : rankedCards(room);
  return pool.slice(0, LIMITS.discussTopCards).map((card) => card.id);
}

/* ----------------------------------------------------------------- boss -- */

export function computeShortlist(room: Room): string[] {
  const totals = tokenTotals(room);
  const candidates = rankedCards(room, ['trap', 'monster']);
  const withTokens = candidates.filter((card) => (totals.get(card.id) ?? 0) > 0);
  const pool = withTokens.length > 0 ? withTokens : candidates;
  return pool.slice(0, LIMITS.shortlistSize).map((card) => card.id);
}

export function bossVoteCounts(room: Room): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cardId of room.boss.shortlist) counts.set(cardId, 0);
  for (const cardId of room.boss.votes.values()) {
    if (!counts.has(cardId)) continue;
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }
  return counts;
}

export function allVotesIn(room: Room): boolean {
  const voters = connectedPlayers(room);
  if (voters.length === 0) return false;
  return voters.every((player) => room.boss.votes.has(player.id));
}

export interface BossResolution {
  kind: 'winner' | 'runoff' | 'empty';
  leaders: string[];
}

export function resolveBoss(room: Room): BossResolution {
  const counts = bossVoteCounts(room);
  if (room.boss.votes.size === 0 || counts.size === 0) {
    return { kind: 'empty', leaders: [] };
  }
  let best = -1;
  let leaders: string[] = [];
  for (const [cardId, count] of counts) {
    if (count > best) {
      best = count;
      leaders = [cardId];
    } else if (count === best) {
      leaders.push(cardId);
    }
  }
  if (best <= 0) return { kind: 'empty', leaders: [] };

  if (leaders.length > 1 && room.boss.round < 3) {
    room.boss.shortlist = leaders;
    room.boss.votes.clear();
    room.boss.runoff = true;
    room.boss.round += 1;
    room.boss.revealed = false;
    room.boss.winnerCardId = null;
    room.boss.title = null;
    return { kind: 'runoff', leaders };
  }

  // Third round still tied: the dungeon decides by token weight, then by id.
  const totals = tokenTotals(room);
  const winnerId = leaders
    .slice()
    .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b))[0]!;
  const card = findCard(room, winnerId);
  room.boss.winnerCardId = winnerId;
  room.boss.title = card ? generateBossTitle(card.category, card.texts.join(' ')) : null;
  room.boss.revealed = true;
  return { kind: 'winner', leaders: [winnerId] };
}

/* ---------------------------------------------------------------- forge -- */

export function forgeTotals(room: Room): Map<string, number> {
  const totals = new Map<string, number>();
  for (const proposal of room.forge.proposals) totals.set(proposal.id, 0);
  for (const allocation of room.forge.allocations.values()) {
    for (const [proposalId, points] of allocation) {
      if (!totals.has(proposalId)) continue;
      totals.set(proposalId, (totals.get(proposalId) ?? 0) + points);
    }
  }
  return totals;
}

export function forgeSpentBy(room: Room, playerId: string): number {
  const allocation = room.forge.allocations.get(playerId);
  if (!allocation) return 0;
  let total = 0;
  for (const value of allocation.values()) total += value;
  return total;
}

export function allocateForge(
  room: Room,
  playerId: string,
  proposalId: string,
  points: number,
): { ok: boolean; error?: string } {
  const proposal = room.forge.proposals.find((item) => item.id === proposalId);
  if (!proposal) return { ok: false, error: 'That experiment is not on the anvil.' };
  const allocation = room.forge.allocations.get(playerId) ?? new Map<string, number>();
  room.forge.allocations.set(playerId, allocation);
  const current = allocation.get(proposalId) ?? 0;
  const spentElsewhere = forgeSpentBy(room, playerId) - current;
  if (spentElsewhere + points > LIMITS.forgePoints) {
    return { ok: false, error: `You only hold ${LIMITS.forgePoints} forge points.` };
  }
  if (points <= 0) allocation.delete(proposalId);
  else allocation.set(proposalId, points);
  return { ok: true };
}

export function autoSelectExperiments(room: Room): void {
  const totals = forgeTotals(room);
  const ranked = room.forge.proposals
    .slice()
    .sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) || a.title.localeCompare(b.title));
  const withPoints = ranked.filter((proposal) => (totals.get(proposal.id) ?? 0) > 0);
  const pool = withPoints.length > 0 ? withPoints : ranked;
  room.forge.selected = pool.slice(0, LIMITS.maxSelectedExperiments).map((proposal) => proposal.id);
}

/* --------------------------------------------------------------- phases -- */

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

export function nextPhase(phase: Phase): Phase | null {
  const index = phaseIndex(phase);
  return index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1]! : null;
}

export function previousPhase(phase: Phase): Phase | null {
  const index = phaseIndex(phase);
  return index > 0 ? PHASES[index - 1]! : null;
}

export function enterPhase(room: Room, phase: Phase): void {
  room.phase = phase;
  room.ready.clear();
  room.lastActivity = Date.now();

  switch (phase) {
    case 'reveal': {
      rebuildCards(room);
      break;
    }
    case 'discuss': {
      room.tokensRevealed = true;
      const order = computeDiscussionOrder(room);
      const previous = room.discussion;
      room.discussion = {
        order,
        index: previous && previous.order.length === order.length ? Math.min(previous.index, Math.max(0, order.length - 1)) : 0,
        secondsLeft: previous?.durationSec ?? LIMITS.discussionDefaultSec,
        running: false,
        durationSec: previous?.durationSec ?? LIMITS.discussionDefaultSec,
      };
      const current = order[room.discussion.index];
      if (current) {
        const card = findCard(room, current);
        if (card) card.discussed = true;
      }
      break;
    }
    case 'boss': {
      room.tokensRevealed = true;
      if (!room.boss.winnerCardId) {
        room.boss.shortlist = computeShortlist(room);
        room.boss.round = 1;
        room.boss.runoff = false;
        room.boss.votes.clear();
        room.boss.revealed = false;
      }
      break;
    }
    case 'victory': {
      if (room.forge.revealed && room.forge.selected.length === 0) autoSelectExperiments(room);
      room.completedAt = Date.now();
      break;
    }
    default:
      break;
  }
  if (phase !== 'victory') room.completedAt = null;
  if (room.discussion && phase !== 'discuss') room.discussion.running = false;
}

export function resetGame(room: Room): void {
  room.phase = 'lobby';
  room.ready.clear();
  room.cards = [];
  room.tokens = new Map([...room.players.keys()].map((id) => [id, new Map<string, number>()]));
  room.tokensRevealed = false;
  room.discussion = null;
  room.boss = {
    shortlist: [],
    votes: new Map(),
    runoff: false,
    round: 1,
    winnerCardId: null,
    title: null,
    revealed: false,
  };
  room.forge = {
    proposals: [],
    allocations: new Map([...room.players.keys()].map((id) => [id, new Map<string, number>()])),
    revealed: false,
    selected: [],
  };
  room.save = { status: 'idle', url: null, message: null };
  room.completedAt = null;
  for (const player of room.players.values()) {
    player.classId = null;
    player.energy = null;
  }
  for (const playerId of room.drafts.keys()) {
    room.drafts.set(playerId, {
      loot: new Array(LIMITS.cardsPerCategory).fill(''),
      trap: new Array(LIMITS.cardsPerCategory).fill(''),
      monster: new Array(LIMITS.cardsPerCategory).fill(''),
    });
  }
  room.lastActivity = Date.now();
}

/** Advances the discussion clock for one room. Returns true if anything changed. */
export function tickDiscussion(room: Room): boolean {
  if (room.phase !== 'discuss' || !room.discussion || !room.discussion.running) return false;
  if (room.discussion.secondsLeft <= 0) {
    room.discussion.running = false;
    return true;
  }
  room.discussion.secondsLeft -= 1;
  if (room.discussion.secondsLeft <= 0) {
    room.discussion.secondsLeft = 0;
    room.discussion.running = false;
  }
  return true;
}

export function gotoDiscussionCard(room: Room, index: number): void {
  if (!room.discussion) return;
  const bounded = Math.max(0, Math.min(index, room.discussion.order.length - 1));
  room.discussion.index = bounded;
  room.discussion.secondsLeft = room.discussion.durationSec;
  room.discussion.running = false;
  const cardId = room.discussion.order[bounded];
  if (cardId) {
    const card = findCard(room, cardId);
    if (card) card.discussed = true;
  }
}

/* -------------------------------------------------------------- summary -- */

function toSummaryCard(room: Room, card: CardRecord, totals: Map<string, number>): SummaryCard {
  return {
    id: card.id,
    category: card.category,
    texts: [...card.texts],
    merged: card.sourceIds.length > 1,
    tokens: totals.get(card.id) ?? 0,
    notes: card.notes,
    discussed: card.discussed,
  };
}

export function buildSummary(room: Room): Summary {
  const totals = tokenTotals(room);
  const energies = [...room.players.values()]
    .map((player) => player.energy)
    .filter((energy): energy is number => typeof energy === 'number');
  const averageEnergy = energies.length
    ? Math.round((energies.reduce((sum, value) => sum + value, 0) / energies.length) * 10) / 10
    : null;

  const byCategory = (category: Category): SummaryCard[] =>
    rankedCards(room, [category]).map((card) => toSummaryCard(room, card, totals));

  const discussedIds = new Set(room.discussion?.order ?? []);
  const discussed = room.cards
    .filter((card) => card.discussed || discussedIds.has(card.id) || card.notes.trim().length > 0)
    .map((card) => toSummaryCard(room, card, totals))
    .sort((a, b) => b.tokens - a.tokens);

  const bossCard = room.boss.winnerCardId ? findCard(room, room.boss.winnerCardId) : undefined;
  const bossVotes = bossCard ? (bossVoteCounts(room).get(bossCard.id) ?? 0) : 0;

  const forge = forgeTotals(room);
  const experiments: SummaryExperiment[] = room.forge.proposals
    .map((proposal) => ({
      title: proposal.title,
      description: proposal.description,
      signal: proposal.signal,
      owner: proposal.owner,
      reviewBy: proposal.reviewBy,
      points: forge.get(proposal.id) ?? 0,
      selected: room.forge.selected.includes(proposal.id),
    }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.points - a.points);

  return {
    participants: [...room.players.values()].map((player) => player.name),
    averageEnergy,
    energyResponses: energies.length,
    loot: byCategory('loot'),
    traps: byCategory('trap'),
    monsters: byCategory('monster'),
    discussed,
    boss:
      bossCard && room.boss.title
        ? {
            title: room.boss.title,
            category: bossCard.category,
            texts: [...bossCard.texts],
            votes: bossVotes,
          }
        : null,
    experiments,
  };
}

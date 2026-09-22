import { APP_NAME, SCHEMA_VERSION } from '../shared/constants.js';
import type { Category } from '../shared/types.js';
import {
  bossVoteCounts,
  buildSummary,
  forgeTotals,
  rankedCards,
  tokenTotals,
} from './game.js';
import type { Room } from './state.js';

export interface SnapshotCard {
  id: string;
  category: Category;
  texts: string[];
  merged: boolean;
  mergedTextCount: number;
  tokens: number;
  notes: string;
  discussed: boolean;
}

export interface RetroSnapshot {
  app: string;
  schemaVersion: number;
  roomCode: string;
  createdAt: string;
  completedAt: string;
  participants: string[];
  energy: {
    average: number | null;
    responses: number;
    distribution: Record<string, number>;
  };
  loot: SnapshotCard[];
  traps: SnapshotCard[];
  monsters: SnapshotCard[];
  merges: Array<{ cardId: string; category: Category; mergedTextCount: number; texts: string[] }>;
  allocations: Record<string, number>;
  discussionNotes: Array<{ cardId: string; category: Category; texts: string[]; notes: string }>;
  finalBoss: {
    cardId: string;
    category: Category;
    title: string;
    texts: string[];
    votes: number;
  } | null;
  experiments: Array<{
    title: string;
    description: string;
    signal: string;
    owner: string | null;
    reviewBy: string;
    points: number;
    selected: boolean;
  }>;
  owners: string[];
  reviewDates: string[];
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * retro-saves/retro-raiders/YYYY-MM-DD_HH-mm_room-CODE.json (UTC).
 * Timestamp plus room code, so a second save never overwrites the first.
 */
export function buildSavePath(roomCode: string, when: Date = new Date()): string {
  const stamp = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}_${pad(
    when.getUTCHours(),
  )}-${pad(when.getUTCMinutes())}`;
  const safeCode = roomCode.replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'UNKNOWN';
  return `retro-saves/retro-raiders/${stamp}_room-${safeCode}.json`;
}

export function buildCommitMessage(roomCode: string, when: Date = new Date()): string {
  const day = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`;
  return `Retro Raiders: save retrospective for room ${roomCode} (${day})`;
}

function toSnapshotCard(
  room: Room,
  cardId: string,
  totals: Map<string, number>,
): SnapshotCard | null {
  const card = room.cards.find((item) => item.id === cardId);
  if (!card) return null;
  return {
    id: card.id,
    category: card.category,
    texts: [...card.texts],
    merged: card.sourceIds.length > 1,
    mergedTextCount: card.texts.length,
    tokens: totals.get(card.id) ?? 0,
    notes: card.notes,
    discussed: card.discussed,
  };
}

/**
 * The saved file carries no socket ids, no player ids and no link between a
 * card and the person who wrote it.
 */
export function buildSnapshot(room: Room, when: Date = new Date()): RetroSnapshot {
  const totals = tokenTotals(room);
  const summary = buildSummary(room);

  const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const player of room.players.values()) {
    if (typeof player.energy === 'number') {
      distribution[String(player.energy)] = (distribution[String(player.energy)] ?? 0) + 1;
    }
  }

  const cardsOf = (category: Category): SnapshotCard[] =>
    rankedCards(room, [category])
      .map((card) => toSnapshotCard(room, card.id, totals))
      .filter((card): card is SnapshotCard => card !== null);

  const allocations: Record<string, number> = {};
  for (const card of room.cards) allocations[card.id] = totals.get(card.id) ?? 0;

  const bossCard = room.boss.winnerCardId
    ? room.cards.find((card) => card.id === room.boss.winnerCardId)
    : undefined;

  const forge = forgeTotals(room);
  const experiments = room.forge.proposals
    .map((proposal) => ({
      title: proposal.title,
      description: proposal.description,
      signal: proposal.signal,
      owner: proposal.owner ? proposal.owner : null,
      reviewBy: proposal.reviewBy,
      points: forge.get(proposal.id) ?? 0,
      selected: room.forge.selected.includes(proposal.id),
    }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.points - a.points);

  return {
    app: APP_NAME,
    schemaVersion: SCHEMA_VERSION,
    roomCode: room.code,
    createdAt: new Date(room.createdAt).toISOString(),
    completedAt: new Date(room.completedAt ?? when.getTime()).toISOString(),
    participants: [...room.players.values()].map((player) => player.name),
    energy: {
      average: summary.averageEnergy,
      responses: summary.energyResponses,
      distribution,
    },
    loot: cardsOf('loot'),
    traps: cardsOf('trap'),
    monsters: cardsOf('monster'),
    merges: room.cards
      .filter((card) => card.sourceIds.length > 1)
      .map((card) => ({
        cardId: card.id,
        category: card.category,
        mergedTextCount: card.texts.length,
        texts: [...card.texts],
      })),
    allocations,
    discussionNotes: room.cards
      .filter((card) => card.discussed || card.notes.trim().length > 0)
      .map((card) => ({
        cardId: card.id,
        category: card.category,
        texts: [...card.texts],
        notes: card.notes,
      })),
    finalBoss:
      bossCard && room.boss.title
        ? {
            cardId: bossCard.id,
            category: bossCard.category,
            title: room.boss.title,
            texts: [...bossCard.texts],
            votes: bossVoteCounts(room).get(bossCard.id) ?? 0,
          }
        : null,
    experiments,
    owners: [
      ...new Set(
        room.forge.proposals
          .map((proposal) => proposal.owner)
          .filter((owner): owner is string => owner.length > 0),
      ),
    ],
    reviewDates: [
      ...new Set(
        room.forge.proposals
          .map((proposal) => proposal.reviewBy)
          .filter((reviewBy): reviewBy is string => reviewBy.length > 0),
      ),
    ],
  };
}

import { LIMITS } from '../shared/constants.js';
import type { GameState, PublicCard, PublicPlayer, PublicProposal } from '../shared/types.js';
import {
  buildSummary,
  forgeTotals,
  spentByPlayer,
  tokenTotals,
  tokensSpentBy,
} from './game.js';
import type { Room } from './state.js';
import { isGithubConfigured } from './github.js';

export const SAVE_PLAYER_NAME = 'Markus';

/**
 * Everything a single browser is allowed to know. Card authorship exists only
 * in server memory and is never copied into this object.
 */
export function buildState(room: Room, playerId: string): GameState {
  const me = room.players.get(playerId);
  const totals = tokenTotals(room);
  const showTotals = room.tokensRevealed;
  const myTokens = room.tokens.get(playerId) ?? new Map<string, number>();
  const myForge = room.forge.allocations.get(playerId) ?? new Map<string, number>();
  const forge = forgeTotals(room);

  const players: PublicPlayer[] = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    connected: player.connected,
    isFacilitator: room.facilitatorId === player.id,
    classId: player.classId,
    energy: player.energy,
    ready: room.ready.has(player.id),
  }));

  const showCards = room.phase !== 'lobby' && room.phase !== 'adventurer' && room.phase !== 'pack';
  const cards: PublicCard[] = showCards
    ? room.cards.map((card) => ({
        id: card.id,
        category: card.category,
        texts: [...card.texts],
        merged: card.sourceIds.length > 1,
        notes: card.notes,
        tokens: showTotals ? (totals.get(card.id) ?? 0) : null,
        myTokens: myTokens.get(card.id) ?? 0,
        discussed: card.discussed,
      }))
    : [];

  const proposals: PublicProposal[] = room.forge.proposals.map((proposal) => ({
    id: proposal.id,
    authorName: room.players.get(proposal.authorId)?.name ?? 'Unknown raider',
    title: proposal.title,
    description: proposal.description,
    signal: proposal.signal,
    owner: proposal.owner,
    reviewBy: proposal.reviewBy,
    points: room.forge.revealed ? (forge.get(proposal.id) ?? 0) : null,
    myPoints: myForge.get(proposal.id) ?? 0,
    selected: room.forge.selected.includes(proposal.id),
  }));

  const draft = room.drafts.get(playerId);

  return {
    code: room.code,
    phase: room.phase,
    you: {
      id: playerId,
      name: me?.name ?? '',
      isFacilitator: room.facilitatorId === playerId,
    },
    players,
    readyPlayerIds: [...room.ready],
    myReady: room.ready.has(playerId),
    myDraft: {
      loot: [...(draft?.loot ?? [])],
      trap: [...(draft?.trap ?? [])],
      monster: [...(draft?.monster ?? [])],
    },
    cards,
    tokens: {
      perPlayer: LIMITS.tokensPerPlayer,
      revealed: showTotals,
      spentByPlayer: spentByPlayer(room),
      myRemaining: LIMITS.tokensPerPlayer - tokensSpentBy(room, playerId),
    },
    discussion: room.discussion
      ? {
          order: [...room.discussion.order],
          index: room.discussion.index,
          secondsLeft: room.discussion.secondsLeft,
          running: room.discussion.running,
          durationSec: room.discussion.durationSec,
        }
      : null,
    boss: {
      shortlist: [...room.boss.shortlist],
      myVote: room.boss.votes.get(playerId) ?? null,
      votedPlayerIds: [...room.boss.votes.keys()],
      runoff: room.boss.runoff,
      round: room.boss.round,
      winnerCardId: room.boss.winnerCardId,
      title: room.boss.title,
      revealed: room.boss.revealed,
    },
    forge: {
      pointsPerPlayer: LIMITS.forgePoints,
      revealed: room.forge.revealed,
      myProposalId: room.forge.proposals.find((proposal) => proposal.authorId === playerId)?.id ?? null,
      proposedPlayerIds: room.forge.proposals.map((proposal) => proposal.authorId),
      allocatedPlayerIds: [...room.forge.allocations.entries()]
        .filter(([, allocation]) => allocation.size > 0)
        .map(([id]) => id),
      proposals,
      selected: [...room.forge.selected],
    },
    summary: room.phase === 'victory' ? buildSummary(room) : null,
    canSaveToGithub: me?.name === SAVE_PLAYER_NAME,
    githubConfigured: isGithubConfigured(),
    save: { ...room.save },
    createdAt: room.createdAt,
    completedAt: room.completedAt,
  };
}

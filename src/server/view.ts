import type { GameState, PublicPlayer } from '../shared/types.js';
import { attackAvailable, buildSummary } from './game.js';
import { isGithubConfigured } from './github.js';
import { isOpenRouterConfigured, readOpenRouterModelOptions, selectOpenRouterModel } from './openrouter.js';
import { isFacilitator, topicsOf, type Room } from './state.js';

/** The one name allowed to write the retro into the repository. */
export const SAVE_PLAYER_NAME = 'Markus';

export function canSave(playerName: string): boolean {
  return playerName === SAVE_PLAYER_NAME;
}

export function buildState(room: Room, playerId: string): GameState {
  const me = room.players.get(playerId);
  const selectedModel = selectOpenRouterModel(room.aiTextModel);
  const players: PublicPlayer[] = [...room.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      isFacilitator: isFacilitator(room, player.id),
      ready: player.ready,
      topicCount: topicsOf(room, player.id).length,
      character: player.character,
      position: player.position,
      lockedEnemyId: player.lockedEnemyId,
    }));

  return {
    code: room.code,
    phase: room.phase,
    you: {
      id: playerId,
      name: me?.name ?? '',
      isFacilitator: isFacilitator(room, playerId),
      ready: me?.ready ?? false,
      checkIn: me?.checkIn ?? null,
      character: me?.character ?? null,
      // Only ever your own topics: the board itself is anonymous.
      topics: topicsOf(room, playerId),
      lockedEnemyId: me?.lockedEnemyId ?? null,
    },
    players,
    topicCount: room.topics.size,
    level: room.level,
    attack: {
      available: attackAvailable(room),
      spent: room.attackSpent,
      collected: room.attackCollected,
    },
    encounter: room.encounter,
    resolutions: room.resolutions,
    summary: room.phase === 'victory' ? buildSummary(room) : null,
    save: room.save,
    generation: {
      busy: room.generation.busy,
      message: room.generation.message,
      aiConfigured: isOpenRouterConfigured(),
      textModel: selectedModel.id,
      textModelLabel: selectedModel.label,
      textModelOptions: readOpenRouterModelOptions(),
      avatarImages: 'local-css',
      imageModel: null,
    },
    githubConfigured: isGithubConfigured(),
    canSave: canSave(me?.name ?? ''),
  };
}

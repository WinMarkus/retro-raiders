import { createHash } from 'node:crypto';
import type { BattleArt, Character, GameState, PublicCharacter, PublicPlayer } from '../shared/types.js';
import { attackAvailable, buildSummary } from './game.js';
import { isGithubConfigured } from './github.js';
import {
  isOpenRouterConfigured,
  readOpenRouterImageConfig,
  readOpenRouterModelOptions,
  selectOpenRouterModel,
} from './openrouter.js';
import { isFacilitator, topicsOf, type Room } from './state.js';

/** The one name allowed to write the retro into the repository. */
export const SAVE_PLAYER_NAME = 'Markus';

export function canSave(playerName: string): boolean {
  return playerName === SAVE_PLAYER_NAME;
}

export function canRestartCampaign(playerName: string): boolean {
  return playerName === SAVE_PLAYER_NAME;
}

const imageTags = new WeakMap<object, string>();

/** Content hash of an image, memoised so multi-MB images are hashed once. */
function imageTag(image: { dataUrl: string }): string {
  let tag = imageTags.get(image);
  if (!tag) {
    tag = createHash('sha1').update(image.dataUrl).digest('hex').slice(0, 12);
    imageTags.set(image, tag);
  }
  return tag;
}

/** Content-addressed, so browsers can cache the image forever. */
function avatarUrl(room: Room, playerId: string, character: Character): string | null {
  const image = character.avatarImage;
  return image ? `/avatar/${room.code}/${playerId}/${imageTag(image)}` : null;
}

function battleArt(room: Room): BattleArt {
  const art = room.battleArt;
  const status = art.status === 'idle' && !readOpenRouterImageConfig() ? 'unavailable' : art.status;
  return {
    status,
    url: art.image ? `/battle/${room.code}/${imageTag(art.image)}` : null,
    message: art.message,
  };
}

export function publicCharacter(room: Room, playerId: string, character: Character | null): PublicCharacter | null {
  if (!character) return null;
  const { avatarImage: _image, ...rest } = character;
  return { ...rest, avatarUrl: avatarUrl(room, playerId, character) };
}

export function buildState(room: Room, playerId: string): GameState {
  const me = room.players.get(playerId);
  const selectedModel = selectOpenRouterModel(room.aiTextModel);
  const imageConfig = readOpenRouterImageConfig();
  const players: PublicPlayer[] = [...room.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      isFacilitator: isFacilitator(room, player.id),
      ready: player.ready,
      topicCount: topicsOf(room, player.id).length,
      character: publicCharacter(room, player.id, player.character),
      forging: player.forging,
      position: player.position,
      lockedEnemyId: player.lockedEnemyId,
    }));

  return {
    code: room.code,
    campaignId: room.createdAt,
    version: room.version,
    phase: room.phase,
    you: {
      id: playerId,
      name: me?.name ?? '',
      isFacilitator: isFacilitator(room, playerId),
      ready: me?.ready ?? false,
      checkIn: me?.checkIn ?? null,
      character: publicCharacter(room, playerId, me?.character ?? null),
      forging: me?.forging ?? false,
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
    encounter: room.encounter
      ? {
          ...room.encounter,
          mine:
            room.encounter.proposals.find((proposal) => room.proposalAuthors.get(proposal.id) === playerId)?.id ??
            null,
        }
      : null,
    resolutions: room.resolutions,
    // Sorted by id (random), so the order says nothing about who wrote what.
    board: room.phase === 'topics' ? [...room.topics.values()].sort((a, b) => a.id.localeCompare(b.id)) : [],
    // A timer belongs to the phase it was set in and silently lapses after.
    timer: room.timer && room.timer.phase === room.phase ? room.timer : null,
    serverTime: Date.now(),
    summary: room.phase === 'victory' ? buildSummary(room) : null,
    save: room.save,
    generation: {
      busy: room.generation.busy,
      message: room.generation.message,
      aiConfigured: isOpenRouterConfigured(),
      textModel: selectedModel.id,
      textModelLabel: selectedModel.label,
      textModelOptions: readOpenRouterModelOptions(),
      avatarImages: imageConfig ? 'openrouter-image' : 'local-css',
      imageModel: imageConfig?.model ?? null,
    },
    battleArt: battleArt(room),
    githubConfigured: isGithubConfigured(),
    canSave: canSave(me?.name ?? ''),
    canRestartCampaign: canRestartCampaign(me?.name ?? ''),
    canStartNewRoom: canRestartCampaign(me?.name ?? ''),
  };
}

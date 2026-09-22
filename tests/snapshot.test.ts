import { beforeEach, describe, expect, it } from 'vitest';
import type { Topic } from '../src/shared/types.js';
import { lockOn, resolveEnemy } from '../src/server/game.js';
import { fallbackCharacter, fallbackLevel } from '../src/server/generate.js';
import { buildCommitMessage, buildSavePath, buildSnapshot } from '../src/server/snapshot.js';
import { RoomStore, type PlayerRecord, type Room } from '../src/server/state.js';

let counter = 0;
function topic(title: string, type: Topic['type'] = 'bad'): Topic {
  counter += 1;
  return { id: `topic-${counter}`, type, title, description: '', intensity: 4 };
}

let room: Room;
let players: PlayerRecord[];

beforeEach(() => {
  const store = new RoomStore();
  room = store.create();
  players = ['Markus', 'Lena', 'Ada'].map((name, index) => {
    const result = store.addPlayer(room, name, `socket-${index}`);
    if (!result.ok) throw new Error('could not add player');
    return result.player;
  });

  for (const player of players) {
    player.checkIn = {
      energy: 4,
      pressure: 3,
      satisfaction: 3,
      mood: 'Shipped a lot.',
      keywords: ['coffee'],
    };
    player.character = fallbackCharacter(player.name, player.checkIn);
  }

  const topics = [
    topic('Review takes too long'),
    topic('PRs stuck in review'),
    topic('Deploys fail on Friday', 'sad'),
    topic('Pair programming helped', 'good'),
  ];
  for (const entry of topics) {
    room.topics.set(entry.id, entry);
    room.topicAuthors.set(entry.id, players[0]!.id);
  }

  room.level = fallbackLevel(topics);
  room.attackCollected = 6;
  const enemy = room.level.enemies[0]!;
  for (const player of players) lockOn(room, player, enemy.id);
  resolveEnemy(room, enemy, {
    treatment: 'Reviewers pick up PRs in the morning slot.',
    owner: 'Lena',
    reviewBy: 'next retro',
    attackPoints: 3,
  });
  room.phase = 'victory';
});

describe('the saved snapshot', () => {
  it('contains everything a team would want to reread', () => {
    const snapshot = buildSnapshot(room, new Date('2026-05-14T09:07:00Z'), 'openai/gpt-4o-mini');

    expect(snapshot.app).toBe('Retro Raiders: The Blocker Dungeon');
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.roomCode).toBe(room.code);
    expect(snapshot.savedAt).toBe('2026-05-14T09:07:00.000Z');
    expect(snapshot.createdAt).toBeTruthy();
    expect(snapshot.players.map((player) => player.name)).toEqual(['Markus', 'Lena', 'Ada']);
    expect(snapshot.players[0]!.character?.characterName).toBeTruthy();
    expect(snapshot.players[0]!.checkIn?.mood).toBe('Shipped a lot.');
    expect(snapshot.topics).toHaveLength(4);
    expect(snapshot.enemies.length).toBeGreaterThan(0);
    expect(snapshot.powerUps.length).toBeGreaterThan(0);
    expect(snapshot.resolutions[0]!.treatment).toContain('morning slot');
    expect(snapshot.resolutions[0]!.owner).toBe('Lena');
    expect(snapshot.attackPoints).toEqual({ collected: 6, spent: 3, remaining: 3 });
    expect(snapshot.summary.actionItems.length).toBeGreaterThan(0);
    expect(snapshot.generatedBy.model).toBe('openai/gpt-4o-mini');
    expect(snapshot.generatedBy.level).toBe('fallback');
  });

  it('never carries player ids, socket ids or topic authorship', () => {
    const json = JSON.stringify(buildSnapshot(room, new Date()));
    for (const player of players) {
      expect(json).not.toContain(player.id);
      if (player.socketId) expect(json).not.toContain(player.socketId);
    }
    expect(json).not.toContain('topicAuthors');
    expect(json).not.toContain('socketId');
  });

  it('is plain JSON with no surprises in it', () => {
    const snapshot = buildSnapshot(room, new Date());
    const round = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(round.roomCode).toBe(snapshot.roomCode);
  });
});

describe('save path and commit message', () => {
  it('builds a sortable UTC path with the room code', () => {
    const path = buildSavePath('GH7K2M', new Date('2026-05-14T09:07:42Z'));
    expect(path).toBe('retro-saves/retro-raiders/2026-05-14_09-07_room-GH7K2M.json');
  });

  it('keeps two saves of the same room in different minutes apart', () => {
    const first = buildSavePath('GH7K2M', new Date('2026-05-14T09:07:00Z'));
    const second = buildSavePath('GH7K2M', new Date('2026-05-14T09:08:00Z'));
    expect(first).not.toBe(second);
  });

  it('refuses to let a room code escape into the path', () => {
    const path = buildSavePath('../../etc/passwd', new Date('2026-05-14T09:07:00Z'));
    expect(path).not.toContain('..');
    expect(path.startsWith('retro-saves/retro-raiders/')).toBe(true);
  });

  it('writes a commit message a human can scan', () => {
    const message = buildCommitMessage('GH7K2M', new Date('2026-05-14T09:07:00Z'));
    expect(message).toContain('Retro Raiders');
    expect(message).toContain('GH7K2M');
  });
});

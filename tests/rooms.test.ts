import { describe, expect, it } from 'vitest';
import { EMPTY_ROOM_TTL_MS, LIMITS } from '../src/shared/constants.js';
import { RoomStore, generateRoomCode } from '../src/server/state.js';

describe('room codes', () => {
  it('generates six unreadable-free uppercase characters', () => {
    const code = generateRoomCode(() => false);
    expect(code).toHaveLength(LIMITS.roomCode);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(code).not.toMatch(/[OI10]/);
  });

  it('never hands out a code that already exists', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const code = generateRoomCode((candidate) => taken.has(candidate));
      expect(taken.has(code)).toBe(false);
      taken.add(code);
    }
  });
});

describe('room creation and joining', () => {
  it('creates independent rooms with their own state', () => {
    const store = new RoomStore();
    const first = store.create();
    const second = store.create();
    expect(first.code).not.toBe(second.code);
    expect(store.size).toBe(2);
    store.addPlayer(first, 'Markus', 'socket-1');
    expect(first.players.size).toBe(1);
    expect(second.players.size).toBe(0);
  });

  it('makes the first player the facilitator and keeps it that way', () => {
    const store = new RoomStore();
    const room = store.create();
    const first = store.addPlayer(room, 'Markus', 'socket-1');
    const second = store.addPlayer(room, 'Lena', 'socket-2');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(room.facilitatorId).toBe(first.player.id);
    expect(room.facilitatorId).not.toBe(second.player.id);
  });

  it('rejects a duplicate name in the same room, whatever the casing', () => {
    const store = new RoomStore();
    const room = store.create();
    expect(store.addPlayer(room, 'Markus', 'socket-1').ok).toBe(true);
    const clash = store.addPlayer(room, 'markus', 'socket-2');
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toBe('name-taken');
    expect(room.players.size).toBe(1);
  });

  it('allows the same name in a different room', () => {
    const store = new RoomStore();
    const a = store.create();
    const b = store.create();
    expect(store.addPlayer(a, 'Markus', 'socket-1').ok).toBe(true);
    expect(store.addPlayer(b, 'Markus', 'socket-2').ok).toBe(true);
  });

  it('refuses players beyond the room limit', () => {
    const store = new RoomStore();
    const room = store.create();
    for (let i = 0; i < LIMITS.maxPlayers; i += 1) {
      expect(store.addPlayer(room, `Raider ${i}`, `socket-${i}`).ok).toBe(true);
    }
    const overflow = store.addPlayer(room, 'One too many', 'socket-x');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toBe('room-full');
  });
});

describe('reconnection', () => {
  it('reattaches a disconnected player by player id', () => {
    const store = new RoomStore();
    const room = store.create();
    const joined = store.addPlayer(room, 'Markus', 'socket-1');
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    store.markDisconnected(room, joined.player.id);
    expect(room.players.get(joined.player.id)?.connected).toBe(false);

    const back = store.reattach(room, joined.player.id, 'socket-2');
    expect(back?.connected).toBe(true);
    expect(back?.socketId).toBe('socket-2');
    expect(room.facilitatorId).toBe(joined.player.id);
  });

  it('refuses an unknown player id', () => {
    const store = new RoomStore();
    const room = store.create();
    expect(store.reattach(room, 'not-a-player', 'socket-9')).toBeNull();
  });
});

describe('stale rooms', () => {
  it('removes rooms nobody came back to', () => {
    const store = new RoomStore();
    const room = store.create();
    const joined = store.addPlayer(room, 'Markus', 'socket-1');
    if (!joined.ok) throw new Error('setup failed');
    store.markDisconnected(room, joined.player.id);

    expect(store.sweep(Date.now())).toEqual([]);
    expect(store.sweep(Date.now() + EMPTY_ROOM_TTL_MS + 1000)).toEqual([room.code]);
    expect(store.size).toBe(0);
  });

  it('keeps rooms that still have someone in them', () => {
    const store = new RoomStore();
    const room = store.create();
    store.addPlayer(room, 'Markus', 'socket-1');
    expect(store.sweep(Date.now() + EMPTY_ROOM_TTL_MS + 1000)).toEqual([]);
    expect(store.size).toBe(1);
  });
});

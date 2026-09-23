import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/shared/constants.js';
import { RoomStore, connectedPlayers, generateRoomCode, isFacilitator } from '../src/server/state.js';

describe('room creation', () => {
  it('creates readable codes without look-alike characters', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(LIMITS.roomCode);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    }
  });

  it('keeps rooms independent and starts in the character forge', () => {
    const store = new RoomStore();
    const first = store.create();
    const second = store.create();
    expect(first.code).not.toBe(second.code);
    expect(first.phase).toBe('forge');
    expect(store.size).toBe(2);
  });

  it('makes the first player the facilitator', () => {
    const store = new RoomStore();
    const room = store.create();
    const host = store.addPlayer(room, 'Ada', 'socket-1');
    const guest = store.addPlayer(room, 'Grace', 'socket-2');
    expect(host.ok && guest.ok).toBe(true);
    if (!host.ok || !guest.ok) return;
    expect(isFacilitator(room, host.player.id)).toBe(true);
    expect(isFacilitator(room, guest.player.id)).toBe(false);
  });
});

describe('joining', () => {
  it('rejects a duplicate name regardless of case', () => {
    const store = new RoomStore();
    const room = store.create();
    store.addPlayer(room, 'Markus', 'socket-1');
    const again = store.addPlayer(room, 'markus', 'socket-2');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe('name-taken');
  });

  it('hands an offline player their seat back when they join with the same name', () => {
    const store = new RoomStore();
    const room = store.create();
    const first = store.addPlayer(room, 'Markus', 'socket-1');
    store.markDisconnected('socket-1');
    const again = store.addPlayer(room, 'markus', 'socket-2');
    expect(again.ok).toBe(true);
    if (again.ok && first.ok) {
      expect(again.player.id).toBe(first.player.id);
      expect(again.player.socketId).toBe('socket-2');
      expect(again.player.connected).toBe(true);
    }
    expect(room.players.size).toBe(1);
  });

  it('allows the same name in a different room', () => {
    const store = new RoomStore();
    const first = store.create();
    const second = store.create();
    store.addPlayer(first, 'Markus', 'socket-1');
    expect(store.addPlayer(second, 'Markus', 'socket-2').ok).toBe(true);
  });

  it('refuses players beyond the room limit', () => {
    const store = new RoomStore();
    const room = store.create();
    for (let i = 0; i < LIMITS.maxPlayers; i += 1) {
      expect(store.addPlayer(room, `player-${i}`, `socket-${i}`).ok).toBe(true);
    }
    const overflow = store.addPlayer(room, 'one-too-many', 'socket-x');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toBe('room-full');
  });

  it('spreads spawn points so tokens do not stack', () => {
    const store = new RoomStore();
    const room = store.create();
    const a = store.addPlayer(room, 'Ada', 's1');
    const b = store.addPlayer(room, 'Grace', 's2');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.player.position).not.toEqual(b.player.position);
  });
});

describe('reconnecting', () => {
  it('reattaches a player to a new socket', () => {
    const store = new RoomStore();
    const room = store.create();
    const joined = store.addPlayer(room, 'Ada', 'socket-1');
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    store.markDisconnected('socket-1');
    expect(connectedPlayers(room)).toHaveLength(0);

    const back = store.reattach(room, joined.player.id, 'socket-2');
    expect(back?.connected).toBe(true);
    expect(connectedPlayers(room)).toHaveLength(1);
  });

  it('returns null for an unknown player id', () => {
    const store = new RoomStore();
    const room = store.create();
    expect(store.reattach(room, 'not-a-player', 'socket-9')).toBeNull();
  });

  it('sweeps rooms nobody came back to', () => {
    const store = new RoomStore();
    const room = store.create();
    store.addPlayer(room, 'Ada', 'socket-1');
    store.markDisconnected('socket-1');
    expect(store.sweep(Date.now())).toBe(0);
    expect(store.sweep(Date.now() + 1000 * 60 * 60 * 9)).toBe(1);
    expect(store.size).toBe(0);
  });
});

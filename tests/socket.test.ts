import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createGameServer, type CreatedServer } from '../src/server/app.js';
import type {
  ActionResult,
  DownloadResult,
  GameState,
  JoinResult,
  SaveResult,
} from '../src/shared/types.js';

let server: CreatedServer;
let url = '';
const openSockets: ClientSocket[] = [];

const GITHUB_ENV = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH'] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of GITHUB_ENV) originalEnv[key] = process.env[key];
  server = createGameServer();
  await new Promise<void>((resolve) => {
    server.httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.httpServer.address() as AddressInfo;
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of openSockets) socket.close();
  await server.close();
  for (const key of GITHUB_ENV) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The server pushes `state` before it answers the ack, so tests buffer every
 * broadcast per socket instead of racing it with a late listener.
 */
const inbox = new Map<ClientSocket, GameState[]>();

function connect(): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], forceNew: true });
  openSockets.push(socket);
  inbox.set(socket, []);
  socket.on('state', (state: GameState) => {
    inbox.get(socket)?.push(state);
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emit<T>(socket: ClientSocket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ack for ${event}`)), 4000);
    socket.emit(event, payload ?? {}, (result: T) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function nextState(
  socket: ClientSocket,
  match: (state: GameState) => boolean = () => true,
): Promise<GameState> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const queue = inbox.get(socket) ?? [];
    const index = queue.findIndex(match);
    if (index >= 0) return queue.splice(index, 1)[0] as GameState;
    if (Date.now() > deadline) throw new Error('No matching state broadcast');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function clearGithubEnv(): void {
  for (const key of GITHUB_ENV) delete process.env[key];
}

function setGithubEnv(): void {
  process.env.GITHUB_TOKEN = 'ghp_test_token_value';
  process.env.GITHUB_OWNER = 'akarion';
  process.env.GITHUB_REPO = 'retro-archive';
  process.env.GITHUB_BRANCH = 'main';
}

describe('socket wiring', () => {
  it('creates a room, makes the creator the facilitator and lets others join', async () => {
    const host = await connect();
    const created = await emit<JoinResult>(host, 'room:create', { name: 'Ada' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.code).toMatch(/^[A-Z0-9]{4,6}$/);

    const state = await nextState(host);
    expect(state.you.isFacilitator).toBe(true);
    expect(state.phase).toBe('lobby');
    expect(state.players).toHaveLength(1);

    const guest = await connect();
    const joined = await emit<JoinResult>(guest, 'room:join', {
      name: 'Grace',
      code: created.code,
    });
    expect(joined.ok).toBe(true);
    const guestState = await nextState(guest, (value) => value.players.length === 2);
    expect(guestState.you.isFacilitator).toBe(false);
    expect(guestState.players.map((player) => player.name).sort()).toEqual(['Ada', 'Grace']);
  });

  it('rejects an unknown room code and a nameless join', async () => {
    const socket = await connect();
    const noRoom = await emit<JoinResult>(socket, 'room:join', { name: 'Ada', code: 'ZZZZZZ' });
    expect(noRoom.ok).toBe(false);
    const noName = await emit<JoinResult>(socket, 'room:join', { name: '   ', code: 'ZZZZZZ' });
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.error).toMatch(/player name/i);
  });

  it('rejects a duplicate player name over the wire', async () => {
    const host = await connect();
    const created = await emit<JoinResult>(host, 'room:create', { name: 'Linus' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const guest = await connect();
    const duplicate = await emit<JoinResult>(guest, 'room:join', {
      name: 'linus',
      code: created.code,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toMatch(/already called/i);
  });

  it('reattaches a returning player through room:rejoin', async () => {
    const first = await connect();
    const created = await emit<JoinResult>(first, 'room:create', { name: 'Ada' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    first.close();

    const second = await connect();
    const rejoined = await emit<JoinResult>(second, 'room:rejoin', {
      code: created.code,
      playerId: created.playerId,
    });
    expect(rejoined.ok).toBe(true);
    const state = await nextState(second);
    expect(state.you.name).toBe('Ada');
    expect(state.you.isFacilitator).toBe(true);
  });

  it('only lets the facilitator move the raid forward', async () => {
    const host = await connect();
    const created = await emit<JoinResult>(host, 'room:create', { name: 'Ada' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code: created.code });

    const denied = await emit<ActionResult>(guest, 'game:start');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/facilitator/i);

    const allowed = await emit<ActionResult>(host, 'game:start');
    expect(allowed.ok).toBe(true);
    const state = await nextState(guest, (value) => value.phase === 'adventurer');
    expect(state.phase).toBe('adventurer');
  });

  it('validates event payloads instead of trusting the client', async () => {
    const host = await connect();
    const created = await emit<JoinResult>(host, 'room:create', { name: 'Ada' });
    expect(created.ok).toBe(true);
    await emit<ActionResult>(host, 'game:start');

    const badClass = await emit<ActionResult>(host, 'player:setClass', { classId: 'necromancer' });
    expect(badClass.ok).toBe(false);
    const badEnergy = await emit<ActionResult>(host, 'player:setEnergy', { energy: 99 });
    expect(badEnergy.ok).toBe(false);
    const goodClass = await emit<ActionResult>(host, 'player:setClass', { classId: 'debugger' });
    expect(goodClass.ok).toBe(true);
  });

  it('refuses save:github and save:download for anyone not named Markus', async () => {
    setGithubEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const host = await connect();
    const created = await emit<JoinResult>(host, 'room:create', { name: 'markus' });
    expect(created.ok).toBe(true);

    const save = await emit<SaveResult>(host, 'save:github');
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error).toMatch(/only the player named markus/i);

    const download = await emit<DownloadResult>(host, 'save:download');
    expect(download.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing GitHub configuration precisely without failing the game', async () => {
    clearGithubEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const host = await connect();
    const created = await emit<JoinResult>(host, 'room:create', { name: 'Markus' });
    expect(created.ok).toBe(true);

    const save = await emit<SaveResult>(host, 'save:github');
    expect(save.ok).toBe(false);
    if (!save.ok) {
      expect(save.error).toContain('GITHUB_TOKEN');
      expect(save.error).toContain('GITHUB_OWNER');
      expect(save.error).toContain('GITHUB_REPO');
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // The download fallback still works for Markus.
    const download = await emit<DownloadResult>(host, 'save:download');
    expect(download.ok).toBe(true);
    if (download.ok) {
      expect(download.filename).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_room-[A-Z0-9]+\.json$/);
      const parsed = JSON.parse(download.json) as Record<string, unknown>;
      expect(parsed.app).toBe('Retro Raiders: The Blocker Dungeon');
      expect(JSON.stringify(parsed)).not.toContain(created.ok ? created.playerId : 'x');
    }
  });

  it('commits through a mocked GitHub API and returns the file URL', async () => {
    setGithubEnv();
    const htmlUrl = 'https://github.com/akarion/retro-archive/blob/main/retro-saves/x.json';
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return { ok: false, status: 404, text: async () => 'Not Found' } as unknown as Response;
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ content: { html_url: htmlUrl } }),
        text: async () => '',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await connect();
    const created = await emit<JoinResult>(host, 'room:create', { name: 'Markus' });
    expect(created.ok).toBe(true);

    const save = await emit<SaveResult>(host, 'save:github');
    expect(save.ok).toBe(true);
    if (save.ok) {
      expect(save.url).toBe(htmlUrl);
      expect(save.path).toMatch(
        /^retro-saves\/retro-raiders\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_room-[A-Z0-9]+\.json$/,
      );
    }

    const putCall = fetchMock.mock.calls.find((call) => (call[1] as { method?: string })?.method === 'PUT');
    expect(putCall).toBeTruthy();
    const body = JSON.parse((putCall?.[1] as { body: string }).body) as Record<string, string>;
    expect(body.branch).toBe('main');
    expect(body.message).toContain('Retro Raiders');
    const decoded = Buffer.from(body.content, 'base64').toString('utf8');
    expect(JSON.parse(decoded).schemaVersion).toBe(1);
  });

  it('never reports success when GitHub rejects the commit', async () => {
    setGithubEnv();
    const fetchMock = vi.fn(async (_input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return { ok: false, status: 404, text: async () => 'Not Found' } as unknown as Response;
      }
      return { ok: false, status: 403, text: async () => 'Resource not accessible' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await connect();
    await emit<JoinResult>(host, 'room:create', { name: 'Markus' });
    const save = await emit<SaveResult>(host, 'save:github');
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error).toMatch(/403|permission|token/i);
  });

  it('serves the health endpoint', async () => {
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; app: string };
    expect(body.status).toBe('ok');
    expect(body.app).toBe('Retro Raiders: The Blocker Dungeon');
  });
});

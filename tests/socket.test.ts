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

const MANAGED_ENV = [
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'GITHUB_BRANCH',
  'OPENROUTER_API_KEY',
  'OPENROUTER_TEXT_MODEL',
  'OPENROUTER_MODEL',
  'OPENROUTER_MODEL_OPTIONS',
  'OPENROUTER_IMAGE_MODEL',
  'OPENROUTER_STORY_MODEL',
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of MANAGED_ENV) originalEnv[key] = process.env[key];
  for (const key of MANAGED_ENV) delete process.env[key];
  server = createGameServer();
  await new Promise<void>((resolve) => {
    server.httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of openSockets) socket.close();
  await server.close();
  for (const key of MANAGED_ENV) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of MANAGED_ENV) delete process.env[key];
});

/** The server pushes `state` before it answers the ack, so buffer broadcasts. */
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
    const timer = setTimeout(() => reject(new Error(`No ack for ${event}`)), 5000);
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
  const deadline = Date.now() + 5000;
  for (;;) {
    const queue = inbox.get(socket) ?? [];
    const index = queue.findIndex(match);
    if (index >= 0) return queue.splice(index, 1)[0] as GameState;
    if (Date.now() > deadline) throw new Error('No matching state broadcast');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const CHECK_IN = {
  energy: 4,
  pressure: 3,
  satisfaction: 3,
  mood: 'Shipped a lot, reviewed even more.',
  keywords: ['coffee'],
};

async function joinedRoom(name: string): Promise<{ socket: ClientSocket; code: string }> {
  const socket = await connect();
  const created = await emit<JoinResult>(socket, 'room:create', { name });
  if (!created.ok) throw new Error(created.error);
  return { socket, code: created.code };
}

async function reachLevel(
  host: ClientSocket,
  topics: Array<{ type: string; title: string }>,
): Promise<GameState> {
  await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
  await emit<ActionResult>(host, 'character:forge');
  await emit<ActionResult>(host, 'phase:topics');
  for (const topic of topics) await emit<ActionResult>(host, 'topic:add', { ...topic, intensity: 4 });
  await emit<ActionResult>(host, 'level:generate');
  return nextState(host, (state) => state.phase === 'level');
}

const TOPICS = [
  { type: 'bad', title: 'Review takes too long' },
  { type: 'sad', title: 'Deploys fail on Friday' },
  { type: 'good', title: 'Pair programming helped' },
];

describe('joining over the wire', () => {
  it('creates a room, makes the creator facilitator and lets others in', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const hostState = await nextState(host);
    expect(hostState.you.isFacilitator).toBe(true);
    expect(hostState.phase).toBe('forge');

    const guest = await connect();
    const joined = await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });
    expect(joined.ok).toBe(true);
    const guestState = await nextState(guest, (state) => state.players.length === 2);
    expect(guestState.you.isFacilitator).toBe(false);
  });

  it('rejects a duplicate name and an unknown room', async () => {
    const { code } = await joinedRoom('Linus');
    const guest = await connect();
    const duplicate = await emit<JoinResult>(guest, 'room:join', { name: 'linus', code });
    expect(duplicate.ok).toBe(false);
    const missing = await emit<JoinResult>(guest, 'room:join', { name: 'Ada', code: 'ZZZZZZ' });
    expect(missing.ok).toBe(false);
  });

  it('brings a reconnecting player back into the same room', async () => {
    const { socket: first, code } = await joinedRoom('Ada');
    const state = await nextState(first);
    first.close();

    const second = await connect();
    const back = await emit<JoinResult>(second, 'room:rejoin', { code, playerId: state.you.id });
    expect(back.ok).toBe(true);
    const rejoined = await nextState(second);
    expect(rejoined.you.name).toBe('Ada');
  });
});

describe('the flow', () => {
  it('forges a character from a check-in without any AI key', async () => {
    const { socket: host } = await joinedRoom('Ada');
    const saved = await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
    expect(saved.ok).toBe(true);
    await emit<ActionResult>(host, 'character:forge');

    const state = await nextState(host, (value) => Boolean(value.you.character));
    expect(state.you.character?.source).toBe('fallback');
    expect(state.you.character?.playerName).toBe('Ada');
    expect(state.generation.aiConfigured).toBe(false);
    expect(state.generation.textModelOptions.length).toBeGreaterThan(1);
    expect(state.generation.textModel).toBe(state.generation.textModelOptions[0]!.id);
  });

  it('lets only the facilitator choose an allowed AI text model', async () => {
    process.env.OPENROUTER_MODEL_OPTIONS = 'openai/gpt-4o-mini|Cheap,z-ai/glm-5.3-flash|GLM';
    const { socket: host, code } = await joinedRoom('Ada');
    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });

    const denied = await emit<ActionResult>(guest, 'ai:model:set', { model: 'z-ai/glm-5.3-flash' });
    expect(denied.ok).toBe(false);

    const unknown = await emit<ActionResult>(host, 'ai:model:set', { model: 'made-up/model' });
    expect(unknown.ok).toBe(false);

    const selected = await emit<ActionResult>(host, 'ai:model:set', { model: 'z-ai/glm-5.3-flash' });
    expect(selected.ok).toBe(true);
    const state = await nextState(host, (value) => value.generation.textModel === 'z-ai/glm-5.3-flash');
    expect(state.generation.textModelLabel).toBe('GLM');
  });

  it('refuses a check-in that says nothing', async () => {
    const { socket: host } = await joinedRoom('Ada');
    const result = await emit<ActionResult>(host, 'checkin:set', { ...CHECK_IN, mood: '' });
    expect(result.ok).toBe(false);
  });

  it('only shows a player their own topics', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
    await emit<ActionResult>(host, 'character:forge');
    await emit<ActionResult>(host, 'phase:topics');

    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });
    await emit<ActionResult>(host, 'topic:add', { type: 'bad', title: 'Review takes too long', intensity: 4 });
    await emit<ActionResult>(guest, 'topic:add', { type: 'sad', title: 'Friday deploys', intensity: 3 });

    const guestState = await nextState(guest, (state) => state.topicCount === 2);
    expect(guestState.topicCount).toBe(2);
    expect(guestState.you.topics.map((topic) => topic.title)).toEqual(['Friday deploys']);
  });

  it('keeps non-facilitators out of the facilitator controls', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });

    const denied = await emit<ActionResult>(guest, 'phase:topics');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/facilitator/i);

    await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
    await emit<ActionResult>(host, 'character:forge');
    expect((await emit<ActionResult>(host, 'phase:topics')).ok).toBe(true);
    expect((await emit<ActionResult>(guest, 'level:generate')).ok).toBe(false);
    expect((await emit<ActionResult>(guest, 'game:end')).ok).toBe(false);
  });

  it('will not generate a dungeon from two post-its', async () => {
    const { socket: host } = await joinedRoom('Ada');
    await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
    await emit<ActionResult>(host, 'character:forge');
    await emit<ActionResult>(host, 'phase:topics');
    await emit<ActionResult>(host, 'topic:add', { type: 'bad', title: 'Review takes too long', intensity: 4 });

    const result = await emit<ActionResult>(host, 'level:generate');
    expect(result.ok).toBe(false);
  });

  it('builds a playable level and lets a lone player open the fight', async () => {
    const { socket: host } = await joinedRoom('Ada');
    const level = await reachLevel(host, TOPICS);
    expect(level.level?.source).toBe('fallback');
    expect(level.level!.enemies.length).toBeGreaterThan(0);

    // Walk onto a power-up first: attack points come from the good topics.
    const powerUp = level.level!.powerUps[0]!;
    host.emit('player:move', powerUp.position);
    const stocked = await nextState(host, (state) => state.attack.collected > 0);
    expect(stocked.level!.powerUps[0]!.collectedBy).toBe('Ada');

    const enemyId = level.level!.enemies[0]!.id;
    const locked = await emit<ActionResult>(host, 'enemy:lock', { enemyId });
    expect(locked.ok).toBe(true);

    // Alone in the room, the threshold drops to one, so the modal opens.
    const fighting = await nextState(host, (state) => Boolean(state.encounter));
    expect(fighting.encounter?.enemyId).toBe(enemyId);

    const vague = await emit<ActionResult>(host, 'encounter:resolve', { treatment: 'fix it' });
    expect(vague.ok).toBe(false);

    const greedy = await emit<ActionResult>(host, 'encounter:resolve', {
      treatment: 'Reviewers pick up PRs in the morning slot before new work.',
      attackPoints: 999,
    });
    expect(greedy.ok).toBe(false);

    const resolved = await emit<ActionResult>(host, 'encounter:resolve', {
      treatment: 'Reviewers pick up PRs in the morning slot before new work.',
      owner: 'Lena',
      reviewBy: 'next retro',
      attackPoints: 1,
    });
    expect(resolved.ok).toBe(true);

    const after = await nextState(host, (state) => state.resolutions.length === 1);
    expect(after.level!.enemies[0]!.status).toBe('resolved');
    expect(after.encounter).toBeNull();
    expect(after.attack.spent).toBe(1);
  });

  it('validates enemy ids instead of trusting them', async () => {
    const { socket: host } = await joinedRoom('Ada');
    await reachLevel(host, TOPICS);
    expect((await emit<ActionResult>(host, 'enemy:lock', { enemyId: '../../etc/passwd' })).ok).toBe(false);
    expect((await emit<ActionResult>(host, 'enemy:lock', { enemyId: 'enemy-nope-9' })).ok).toBe(false);
  });

  it('lets only Markus restart the whole campaign in the same room', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const markus = await connect();
    await emit<JoinResult>(markus, 'room:join', { name: 'Markus', code });

    const denied = await emit<ActionResult>(host, 'campaign:restart');
    expect(denied.ok).toBe(false);

    await reachLevel(host, TOPICS);
    const before = await nextState(markus, (state) => state.phase === 'level' && state.topicCount > 0);
    expect(before.canRestartCampaign).toBe(true);

    inbox.set(host, []);
    const restarted = await emit<ActionResult>(markus, 'campaign:restart');
    expect(restarted.ok).toBe(true);

    const after = await nextState(host, (state) => state.phase === 'forge' && state.topicCount === 0);
    expect(after.code).toBe(code);
    expect(after.players.map((player) => player.name)).toEqual(['Ada', 'Markus']);
    expect(after.players.every((player) => player.character === null)).toBe(true);
    expect(after.level).toBeNull();
    expect(after.encounter).toBeNull();
    expect(after.resolutions).toEqual([]);
    expect(after.attack).toEqual({ available: 0, spent: 0, collected: 0 });
  });

  it('lets Markus start an entirely new room without the old players', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const markus = await connect();
    const joined = await emit<JoinResult>(markus, 'room:join', { name: 'Markus', code });
    expect(joined.ok).toBe(true);

    const denied = await emit<JoinResult>(host, 'room:create:fresh');
    expect(denied.ok).toBe(false);

    inbox.set(host, []);
    const fresh = await emit<JoinResult>(markus, 'room:create:fresh');
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error(fresh.error);
    expect(fresh.code).not.toBe(code);

    const newRoom = await nextState(markus, (state) => state.code === fresh.code);
    expect(newRoom.players.map((player) => player.name)).toEqual(['Markus']);
    expect(newRoom.phase).toBe('forge');

    const oldRoom = await nextState(host, (state) => state.code === code);
    expect(oldRoom.players.map((player) => `${player.name}:${player.connected}`)).toEqual([
      'Ada:true',
      'Markus:false',
    ]);
  });
});

describe('saving', () => {
  it('refuses save and download for anyone not named Markus', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { socket: host } = await joinedRoom('markus');
    const save = await emit<SaveResult>(host, 'save:github');
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error).toMatch(/only the player named markus/i);

    const download = await emit<DownloadResult>(host, 'save:download');
    expect(download.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the missing GitHub variables and still offers the download', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { socket: host } = await joinedRoom('Markus');
    const save = await emit<SaveResult>(host, 'save:github');
    expect(save.ok).toBe(false);
    if (!save.ok) {
      expect(save.error).toContain('GITHUB_TOKEN');
      expect(save.error).toContain('GITHUB_OWNER');
      expect(save.error).toContain('GITHUB_REPO');
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const download = await emit<DownloadResult>(host, 'save:download');
    expect(download.ok).toBe(true);
    if (download.ok) {
      expect(download.filename).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_room-[A-Z0-9]+\.json$/);
      const parsed = JSON.parse(download.json) as { app: string; schemaVersion: number };
      expect(parsed.app).toBe('Retro Raiders: The Blocker Dungeon');
      expect(parsed.schemaVersion).toBe(2);
    }
  });

  it('commits through a mocked GitHub API and returns the file URL', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.GITHUB_OWNER = 'WinMarkus';
    process.env.GITHUB_REPO = 'retro-raiders';
    const htmlUrl = 'https://github.com/WinMarkus/retro-raiders/blob/main/retro-saves/x.json';

    const fetchMock = vi.fn(async (_input: unknown, init?: { method?: string }) => {
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

    try {
      const { socket: host } = await joinedRoom('Markus');
      const save = await emit<SaveResult>(host, 'save:github');
      expect(save.ok).toBe(true);
      if (save.ok) {
        expect(save.url).toBe(htmlUrl);
        expect(save.path).toMatch(
          /^retro-saves\/retro-raiders\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_room-[A-Z0-9]+\.json$/,
        );
      }

      const put = fetchMock.mock.calls.find((call) => (call[1] as { method?: string })?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse((put?.[1] as { body: string }).body) as Record<string, string>;
      expect(body.branch).toBe('main');
      const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) as {
        schemaVersion: number;
      };
      expect(decoded.schemaVersion).toBe(2);
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_OWNER;
      delete process.env.GITHUB_REPO;
    }
  });

  it('never reports success when GitHub rejects the commit', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.GITHUB_OWNER = 'WinMarkus';
    process.env.GITHUB_REPO = 'retro-raiders';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { method?: string }) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return { ok: false, status: 404, text: async () => 'Not Found' } as unknown as Response;
        }
        return { ok: false, status: 403, text: async () => 'Resource not accessible' } as unknown as Response;
      }),
    );

    try {
      const { socket: host } = await joinedRoom('Markus');
      const save = await emit<SaveResult>(host, 'save:github');
      expect(save.ok).toBe(false);
      if (!save.ok) expect(save.error).toContain('403');
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_OWNER;
      delete process.env.GITHUB_REPO;
    }
  });
});

describe('the server itself', () => {
  it('answers the health check', async () => {
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; app: string };
    expect(body.status).toBe('ok');
    expect(body.app).toBe('Retro Raiders: The Blocker Dungeon');
  });
});

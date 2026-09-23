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

describe('a full party of seven', () => {
  it('lets everyone forge at the same moment', async () => {
    const { socket: host, code } = await joinedRoom('Host');
    const party = [host];
    for (let i = 1; i < 7; i += 1) {
      const guest = await connect();
      const joined = await emit<JoinResult>(guest, 'room:join', { name: `Dev${i}`, code });
      expect(joined.ok).toBe(true);
      party.push(guest);
    }
    const results = await Promise.all(
      party.map(async (socket) => {
        await emit<ActionResult>(socket, 'checkin:set', CHECK_IN);
        return emit<ActionResult>(socket, 'character:forge');
      }),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const state = await nextState(host, (value) => value.players.every((player) => player.character));
    expect(state.players).toHaveLength(7);
    expect(state.players.some((player) => player.forging)).toBe(false);
  });

  it('refuses a second forge while the first is still running for that player', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { ok: false, status: 503, text: async () => 'busy' } as unknown as Response;
      }),
    );
    const { socket: host } = await joinedRoom('Ada');
    await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
    const [first, second] = await Promise.all([
      emit<ActionResult>(host, 'character:forge'),
      emit<ActionResult>(host, 'character:forge'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });
});

describe('surviving trouble', () => {
  it('lets a player reclaim their seat by name after losing the session', async () => {
    const { socket: first, code } = await joinedRoom('Ada');
    const before = await nextState(first);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fresh = await connect();
    const back = await emit<JoinResult>(fresh, 'room:join', { name: 'ada', code });
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.playerId).toBe(before.you.id);
  });

  it('rebuilds a room from client copies after the server lost it', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });
    const hostCopy = await reachLevel(host, TOPICS);
    const guestCopy = await nextState(guest, (state) => state.phase === 'level');

    // What a restart on the free tier does to in-memory rooms.
    server.store.delete(code);
    host.close();
    guest.close();

    const hostAgain = await connect();
    const restored = await emit<JoinResult>(hostAgain, 'room:rejoin', { code, playerId: hostCopy.you.id, state: hostCopy });
    expect(restored.ok).toBe(true);
    const guestAgain = await connect();
    const guestBack = await emit<JoinResult>(guestAgain, 'room:rejoin', { code, playerId: guestCopy.you.id, state: guestCopy });
    expect(guestBack.ok).toBe(true);

    const state = await nextState(hostAgain, (value) => value.players.filter((p) => p.connected).length === 2);
    expect(state.phase).toBe('level');
    expect(state.level?.enemies.length).toBe(hostCopy.level?.enemies.length);
    expect(state.you.isFacilitator).toBe(true);
    expect(state.you.topics).toHaveLength(TOPICS.length);
    expect(state.topicCount).toBe(TOPICS.length);
  });

  it('never lets a client copy overwrite a live room', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const live = await nextState(host);
    const intruder = await connect();
    const forged = { ...live, phase: 'victory' };
    const result = await emit<JoinResult>(intruder, 'room:rejoin', { code, playerId: 'someone-else', state: forged });
    expect(result.ok).toBe(false);
    expect(server.store.get(code)?.phase).toBe('forge');
  });

  it('survives a handler that throws on a hostile payload', async () => {
    const { socket: host } = await joinedRoom('Ada');
    // Simulate a bug deep inside a handler.
    const originalGet = server.store.get.bind(server.store);
    server.store.get = () => {
      throw new Error('simulated bug');
    };
    try {
      const result = await emit<ActionResult>(host, 'topic:add', { type: 'bad', title: 'Anything' });
      expect(result.ok).toBe(false);
    } finally {
      server.store.get = originalGet;
    }
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
  });

  it('keeps portrait images out of the state and serves them over HTTP', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const state = await nextState(host);
    const room = server.store.get(code)!;
    const player = room.players.get(state.you.id)!;
    const png = Buffer.from('fake-png-bytes');
    player.character = {
      ...(await import('../src/server/generate.js')).fallbackCharacter('Ada', { ...CHECK_IN }),
      avatarImage: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, mediaType: 'image/png', model: 'x', cost: null },
    };
    await emit<ActionResult>(host, 'ready:set', { ready: true });
    const next = await nextState(host, (value) => Boolean(value.you.character));
    expect(JSON.stringify(next)).not.toContain('base64');
    const avatarUrl = next.you.character!.avatarUrl!;
    const response = await fetch(`${url}${avatarUrl}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
  });
});

describe('the topic board and soft timers', () => {
  it('shows every topic to everyone, without authors, only while the board is open', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });
    await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
    await emit<ActionResult>(host, 'character:forge');
    await emit<ActionResult>(host, 'phase:topics');
    await emit<ActionResult>(host, 'topic:add', { type: 'bad', title: 'Review takes too long', intensity: 3 });
    const seen = await nextState(guest, (state) => state.board.length === 1);
    expect(seen.board[0]!.title).toBe('Review takes too long');
    expect(JSON.stringify(seen.board)).not.toContain('Ada');
    expect(seen.you.topics).toHaveLength(0);
  });

  it('lets only the facilitator set a timer, and the timer lapses with the phase', async () => {
    const { socket: host, code } = await joinedRoom('Ada');
    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });
    expect((await emit<ActionResult>(guest, 'timer:set', { minutes: 5 })).ok).toBe(false);
    expect((await emit<ActionResult>(host, 'timer:set', { minutes: 5 })).ok).toBe(true);
    const timed = await nextState(guest, (state) => Boolean(state.timer));
    expect(timed.timer!.endsAt - timed.serverTime).toBeGreaterThan(4 * 60_000);

    await emit<ActionResult>(host, 'checkin:set', CHECK_IN);
    await emit<ActionResult>(host, 'character:forge');
    await emit<ActionResult>(host, 'phase:topics');
    const next = await nextState(guest, (state) => state.phase === 'topics');
    expect(next.timer).toBeNull();
  });
});

describe('the idea board in a fight', () => {
  async function fight(): Promise<{ host: ClientSocket; guest: ClientSocket; state: GameState; code: string }> {
    const { socket: host, code } = await joinedRoom('Ada');
    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });
    const level = await reachLevel(host, TOPICS);
    const enemyId = level.level!.enemies[0]!.id;
    await emit<ActionResult>(host, 'enemy:lock', { enemyId });
    // Two players means a majority is two; the facilitator skips the vote.
    const started = await emit<ActionResult>(host, 'encounter:start');
    expect(started.ok).toBe(true);
    const state = await nextState(guest, (value) => Boolean(value.encounter));
    return { host, guest, state, code };
  }

  it('lets the facilitator start a fight without a majority', async () => {
    const { state } = await fight();
    expect(state.encounter!.proposals).toEqual([]);
    expect(state.encounter!.ideasUntil).toBeGreaterThan(state.encounter!.openedAt);
  });

  it('collects one idea per person, lets them edit it, and hides who wrote what', async () => {
    const { host, guest } = await fight();
    await emit<ActionResult>(guest, 'proposal:submit', { text: 'Review slot every morning' });
    await emit<ActionResult>(guest, 'proposal:submit', { text: 'Review slot every morning at nine' });
    await emit<ActionResult>(host, 'proposal:submit', { text: 'Smaller pull requests' });
    const guestView = await nextState(guest, (state) => state.encounter?.proposals.length === 2);
    expect(guestView.encounter!.proposals.map((p) => p.text)).toContain('Review slot every morning at nine');
    const mine = guestView.encounter!.proposals.find((p) => p.id === guestView.encounter!.mine);
    expect(mine?.text).toBe('Review slot every morning at nine');
    expect(JSON.stringify(guestView.encounter!.proposals)).not.toMatch(/Ada|Grace/);
  });

  it('lets the facilitator kick and merge, but nobody else', async () => {
    const { host, guest } = await fight();
    await emit<ActionResult>(guest, 'proposal:submit', { text: 'Review slot every morning' });
    await emit<ActionResult>(host, 'proposal:submit', { text: 'Smaller pull requests' });
    const both = await nextState(host, (state) => state.encounter?.proposals.length === 2);
    const ids = both.encounter!.proposals.map((p) => p.id);

    const hostIdea = both.encounter!.mine!;
    expect((await emit<ActionResult>(guest, 'proposal:remove', { proposalId: hostIdea })).ok).toBe(false);
    expect((await emit<ActionResult>(guest, 'proposal:merge', { proposalIds: ids, text: 'x' })).ok).toBe(false);

    const merged = await emit<ActionResult>(host, 'proposal:merge', {
      proposalIds: ids,
      text: 'Small PRs, reviewed in a morning slot',
    });
    expect(merged.ok).toBe(true);
    const after = await nextState(guest, (state) => state.encounter?.proposals.length === 1);
    expect(after.encounter!.proposals[0]!.source).toBe('merged');
    // Their idea was merged away, so the guest may put a new one on the table.
    expect(after.encounter!.mine).toBeNull();

    await emit<ActionResult>(host, 'proposal:remove', { proposalId: after.encounter!.proposals[0]!.id });
    const empty = await nextState(guest, (state) => state.encounter?.proposals.length === 0);
    expect(empty.encounter!.proposals).toEqual([]);
  });

  it('asks the oracle for ideas and to take one further, locally without a key', async () => {
    const { host, guest } = await fight();
    const generated = await emit<ActionResult>(guest, 'proposal:generate');
    expect(generated.ok).toBe(true);
    const withIdeas = await nextState(host, (state) => (state.encounter?.proposals.length ?? 0) >= 1 && !state.encounter!.oracleBusy);
    expect(withIdeas.encounter!.proposals.every((p) => p.source === 'oracle')).toBe(true);

    const first = withIdeas.encounter!.proposals[0]!;
    const refined = await emit<ActionResult>(host, 'proposal:refine', { proposalId: first.id });
    expect(refined.ok).toBe(true);
    const after = await nextState(host, (state) => state.encounter!.proposals.some((p) => p.source === 'refined'));
    const index = after.encounter!.proposals.findIndex((p) => p.source === 'refined');
    expect(after.encounter!.proposals[index - 1]!.id).toBe(first.id);
  });

  it('keeps the ideas that were not chosen on the resolution', async () => {
    const { host, code } = await fight();
    await emit<ActionResult>(host, 'proposal:submit', { text: 'Smaller pull requests' });
    await nextState(host, (state) => state.encounter?.proposals.length === 1);
    const room = server.store.get(code)!;
    room.attackCollected = 3;
    const resolved = await emit<ActionResult>(host, 'encounter:resolve', {
      treatment: 'Reviewers take a morning slot before new work',
      attackPoints: 1,
    });
    expect(resolved.ok).toBe(true);
    expect(room.resolutions.at(-1)!.alternatives).toEqual(['Smaller pull requests']);
  });
});

describe('the victory painting', () => {
  it('says it is unavailable without an image model', async () => {
    const { socket: host } = await joinedRoom('Ada');
    const state = await nextState(host);
    expect(state.battleArt.status).toBe('unavailable');
  });

  it('paints the whole party and the dungeon when the raid ends, served outside the state', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_IMAGE_MODEL = 'openai/gpt-image-2';
    const png = Buffer.from('epic-battle-png');
    const prompts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        if (String(input).endsWith('/images')) {
          prompts.push(JSON.parse(init?.body ?? '{}').prompt);
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }] }),
          } as unknown as Response;
        }
        // Text calls fail over to the local generator.
        return { ok: false, status: 503, text: async () => 'busy' } as unknown as Response;
      }),
    );

    const { socket: host, code } = await joinedRoom('Ada');
    const level = await reachLevel(host, TOPICS);
    await emit<ActionResult>(host, 'game:end');
    const painted = await nextState(host, (state) => state.battleArt.status === 'done');

    expect(JSON.stringify(painted)).not.toContain(png.toString('base64'));
    expect(painted.battleArt.url).toMatch(new RegExp(`^/battle/${code}/`));
    const prompt = prompts.at(-1)!;
    expect(prompt).toContain(level.you.character!.characterName);
    expect(prompt).toContain(level.level!.enemies[0]!.name);
    expect(prompt).toMatch(/no text/i);

    vi.unstubAllGlobals();
    const served = await fetch(`${url}${painted.battleArt.url}`);
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
    const download = await fetch(`${url}${painted.battleArt.url}?download=1`);
    expect(download.headers.get('content-disposition')).toContain(`retro-raiders-${code}-battle.png`);

    // Only the facilitator may spend another painting.
    const guest = await connect();
    await emit<JoinResult>(guest, 'room:join', { name: 'Grace', code });
    expect((await emit<ActionResult>(guest, 'art:paint')).ok).toBe(false);
  });
});

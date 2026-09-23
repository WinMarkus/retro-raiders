import type {
  ActionResult,
  DownloadResult,
  GameState,
  JoinResult,
  MoveBroadcast,
  Point,
  SaveResult,
} from '../shared/types.js';

declare const io: (options?: Record<string, unknown>) => ClientSocket;

export interface ClientSocket {
  id: string;
  connected: boolean;
  on(event: string, handler: (...args: never[]) => void): void;
  emit(event: string, payload?: unknown, ack?: (result: unknown) => void): void;
}

const SESSION_KEY = 'retro-raiders-session';
const STATE_KEY = 'retro-raiders-state';
/** Render's free tier sleeps after 15 idle minutes; an open room keeps it up. */
const KEEPALIVE_MS = 4 * 60_000;

export interface Session {
  code: string;
  playerId: string;
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed.code && parsed.playerId ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private mode: the game still works, reconnecting just needs a re-join */
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    /* ignore */
  }
}

/** The last room copy, kept so a restarted server can be handed the room back. */
function saveStateCopy(state: GameState): void {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* full or private mode: the in-memory copy still covers a reconnect */
  }
}

function loadStateCopy(): GameState | null {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as GameState) : null;
  } catch {
    return null;
  }
}

export const socket: ClientSocket = io({ transports: ['websocket', 'polling'] });

export const store = {
  state: null as GameState | null,
  connected: false,
  joinError: null as string | null,
  /** serverTime - Date.now(), so countdowns survive a laptop with a wrong clock. */
  clockOffset: 0,
  /** Positions of other players, patched by the lightweight move broadcast. */
  positions: new Map<string, Point>(),
};

type Listener = () => void;
const listeners: Listener[] = [];

export function onChange(listener: Listener): void {
  listeners.push(listener);
}

export function notify(): void {
  for (const listener of listeners) listener();
}

function call<T>(event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload ?? {}, (result: unknown) => resolve(result as T));
  });
}

export function act(event: string, payload?: unknown): Promise<ActionResult> {
  return call<ActionResult>(event, payload).then((result) => {
    if (result && result.ok === false) toast(result.error);
    else if (result?.message) toast(result.message);
    return result;
  });
}

export async function createRoom(name: string): Promise<void> {
  const result = await call<JoinResult>('room:create', { name });
  handleJoin(result);
}

export async function joinRoom(name: string, code: string): Promise<void> {
  const result = await call<JoinResult>('room:join', { name, code });
  handleJoin(result);
}

export async function createFreshRoom(): Promise<void> {
  const result = await call<JoinResult>('room:create:fresh');
  handleJoin(result);
}

function handleJoin(result: JoinResult): void {
  if (result.ok) {
    saveSession({ code: result.code, playerId: result.playerId });
    store.joinError = null;
    const url = new URL(window.location.href);
    url.searchParams.set('room', result.code);
    window.history.replaceState({}, '', url.toString());
  } else {
    store.joinError = result.error;
  }
  notify();
}

export function saveToGithub(): Promise<SaveResult> {
  return call<SaveResult>('save:github');
}

export async function downloadSnapshot(): Promise<void> {
  const result = await call<DownloadResult>('save:download');
  if (!result.ok) {
    toast(result.error);
    return;
  }
  const blob = new Blob([result.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function serverNow(): number {
  return Date.now() + store.clockOffset;
}

export function inviteLink(code: string): string {
  return `${window.location.origin}/?room=${encodeURIComponent(code)}`;
}

export async function copyInvite(code: string): Promise<void> {
  const link = inviteLink(code);
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied — paste it into the call chat.');
  } catch {
    // Clipboard needs a secure context or permission; show it instead.
    window.prompt('Copy this invite link:', link);
  }
}

export function toast(message: string): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.classList.add('toast--out'), 4000);
  setTimeout(() => node.remove(), 4600);
}

export function attachSocketLifecycle(): void {
  socket.on('connect', () => {
    store.connected = true;
    const session = loadSession();
    if (session) {
      const copy = store.state?.code === session.code ? store.state : loadStateCopy();
      socket.emit('room:rejoin', { ...session, state: copy?.code === session.code ? copy : null }, (result: unknown) => {
        const join = result as JoinResult;
        if (!join.ok) {
          clearSession();
          store.state = null;
          store.joinError = 'Your session in that room ended. Join again with the same name to get your seat back.';
        }
        notify();
      });
    }
    notify();
  });

  socket.on('disconnect', () => {
    store.connected = false;
    notify();
  });

  socket.on('state', ((state: GameState) => {
    store.state = state;
    store.clockOffset = state.serverTime - Date.now();
    for (const player of state.players) store.positions.set(player.id, player.position);
    saveStateCopy(state);
    notify();
  }) as (...args: never[]) => void);

  socket.on('player:moved', ((move: MoveBroadcast) => {
    store.positions.set(move.playerId, move.position);
    window.dispatchEvent(new CustomEvent('party:moved', { detail: move }));
  }) as (...args: never[]) => void);

  socket.on('notice', ((notice: { message: string }) => {
    toast(notice.message);
  }) as (...args: never[]) => void);

  window.setInterval(() => {
    if (!store.state) return;
    void fetch('/health', { cache: 'no-store' }).catch(() => undefined);
  }, KEEPALIVE_MS);
}

export function leave(): void {
  clearSession();
  window.location.href = '/';
}

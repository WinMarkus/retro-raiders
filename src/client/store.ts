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
  } catch {
    /* ignore */
  }
}

export const socket: ClientSocket = io({ transports: ['websocket', 'polling'] });

export const store = {
  state: null as GameState | null,
  connected: false,
  joinError: null as string | null,
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
      socket.emit('room:rejoin', session, (result: unknown) => {
        const join = result as JoinResult;
        if (!join.ok) {
          clearSession();
          store.state = null;
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
    for (const player of state.players) store.positions.set(player.id, player.position);
    notify();
  }) as (...args: never[]) => void);

  socket.on('player:moved', ((move: MoveBroadcast) => {
    store.positions.set(move.playerId, move.position);
    window.dispatchEvent(new CustomEvent('party:moved', { detail: move }));
  }) as (...args: never[]) => void);

  socket.on('notice', ((notice: { message: string }) => {
    toast(notice.message);
  }) as (...args: never[]) => void);
}

export function leave(): void {
  clearSession();
  window.location.href = window.location.pathname;
}

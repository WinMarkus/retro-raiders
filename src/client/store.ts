import type { ActionResult, DownloadResult, GameState, JoinResult, SaveResult } from '../shared/types.js';

export interface ClientSocket {
  id?: string;
  connected: boolean;
  on(event: string, handler: (...args: never[]) => void): void;
  emit(event: string, payload?: unknown, ack?: (result: never) => void): void;
}

declare const io: (options?: Record<string, unknown>) => ClientSocket;

export type Connection = 'connecting' | 'online' | 'offline';

export interface ClientState {
  screen: 'join' | 'game';
  connection: Connection;
  joinError: string | null;
  game: GameState | null;
  pendingSave: boolean;
}

const SESSION_KEY = 'retro-raiders-session';

export interface Session {
  code: string;
  playerId: string;
  name: string;
}

export function loadSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.code || !parsed.playerId) return null;
    return { code: parsed.code, playerId: parsed.playerId, name: parsed.name ?? '' };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private mode: the game still works, reconnecting just needs a re-join */
  }
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export const state: ClientState = {
  screen: 'join',
  connection: 'connecting',
  joinError: null,
  game: null,
  pendingSave: false,
};

export const socket: ClientSocket = io({ transports: ['websocket', 'polling'] });

let renderer: () => void = () => {};

export function onRender(fn: () => void): void {
  renderer = fn;
}

export function render(): void {
  renderer();
}

/* ------------------------------------------------------------- emitting -- */

export function emit<T>(event: string, payload?: unknown): Promise<T> {
  return new Promise<T>((resolve) => {
    socket.emit(event, payload ?? {}, ((result: T) => resolve(result)) as never);
  });
}

/** Fire an action and surface any server complaint as a toast. */
export async function act(event: string, payload?: unknown): Promise<ActionResult> {
  const result = await emit<ActionResult>(event, payload);
  if (result && result.ok === false && result.error) toast(result.error, 'error');
  return result ?? { ok: false, error: 'No answer from the server.' };
}

export function join(event: 'room:create' | 'room:join', payload: unknown): Promise<JoinResult> {
  return emit<JoinResult>(event, payload);
}

export function saveToGithub(): Promise<SaveResult> {
  return emit<SaveResult>('save:github', {});
}

export function downloadSnapshot(): Promise<DownloadResult> {
  return emit<DownloadResult>('save:download', {});
}

/* --------------------------------------------------------------- toasts -- */

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.textContent = message;
  host.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('toast--leaving');
    window.setTimeout(() => node.remove(), 400);
  }, 4200);
}

/* ----------------------------------------------------------- reconnect -- */

export function attachSocketLifecycle(): void {
  socket.on('connect', (() => {
    state.connection = 'online';
    const session = loadSession();
    if (session) {
      void emit<JoinResult>('room:rejoin', { code: session.code, playerId: session.playerId }).then(
        (result) => {
          if (result?.ok) {
            state.screen = 'game';
          } else {
            clearSession();
            state.screen = 'join';
            state.game = null;
            state.joinError = result?.error ?? null;
          }
          render();
        },
      );
    }
    render();
  }) as never);

  socket.on('disconnect', (() => {
    state.connection = 'offline';
    render();
  }) as never);

  socket.on('connect_error', (() => {
    state.connection = 'offline';
    render();
  }) as never);

  socket.on('state', ((game: GameState) => {
    state.game = game;
    state.screen = 'game';
    render();
  }) as never);

  socket.on('discuss:tick', ((payload: { secondsLeft: number; running: boolean }) => {
    if (!state.game?.discussion) return;
    state.game.discussion.secondsLeft = payload.secondsLeft;
    state.game.discussion.running = payload.running;
    const clock = document.getElementById('discussion-clock');
    if (clock) {
      const minutes = Math.floor(Math.max(0, payload.secondsLeft) / 60);
      const seconds = Math.max(0, payload.secondsLeft) % 60;
      clock.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
      clock.classList.toggle('clock--low', payload.secondsLeft <= 30);
    }
  }) as never);
}

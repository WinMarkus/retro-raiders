import { PHASE_LABEL, TIMER_PRESETS } from '../shared/constants.js';
import type { GameState } from '../shared/types.js';
import { countdown, h, mount, patch } from './dom.js';
import { act, attachSocketLifecycle, copyInvite, createFreshRoom, leave, notify, onChange, serverNow, store } from './store.js';
import { createForge } from './views/forge.js';
import { createJoin } from './views/join.js';
import { createLevel } from './views/level.js';
import { createTopics } from './views/topics.js';
import { createVictory } from './views/victory.js';
import { panel, type View } from './views/ui.js';

const getState = (): GameState | null => store.state;

function restartCampaign(): void {
  const ok = window.confirm('Start a new campaign for this room? This clears characters, topics, dungeon and results.');
  if (!ok) return;
  void act('campaign:restart');
}

function startNewRoom(): void {
  const ok = window.confirm('Start an entirely new room? The current players will stay in the old room.');
  if (!ok) return;
  void createFreshRoom();
}

/** The countdown text is ticked by `tickTimers`, so the bar is never rebuilt for it. */
function timerControl(state: GameState): HTMLElement | null {
  const timer = state.timer;
  const canSet = state.you.isFacilitator && state.phase !== 'generating';
  if (!timer && !canSet) return null;
  return h(
    'div',
    { class: 'timer' },
    timer
      ? h('span', { class: 'timer__clock', 'data-ends': String(timer.endsAt), title: `${timer.minutes} minute soft timer` })
      : null,
    canSet
      ? h(
          'div',
          { class: 'timer__presets', role: 'group', 'aria-label': 'Soft timer' },
          h('span', { class: 'timer__icon', 'aria-hidden': 'true', text: '⏳' }),
          ...TIMER_PRESETS.map((minutes) =>
            h('button', {
              class: 'timer__btn',
              type: 'button',
              title: `Start a ${minutes} minute soft timer`,
              text: `${minutes}m`,
              onClick: () => void act('timer:set', { minutes }),
            }),
          ),
          timer
            ? h('button', {
                class: 'timer__btn',
                type: 'button',
                title: 'Clear the timer',
                'aria-label': 'Clear the timer',
                text: '✕',
                onClick: () => void act('timer:set', { minutes: 0 }),
              })
            : null,
        )
      : null,
  );
}

function tickTimers(): void {
  const now = serverNow();
  for (const node of document.querySelectorAll<HTMLElement>('[data-ends]')) {
    const { text, over } = countdown(Number(node.dataset.ends), now);
    if (node.textContent !== text) node.textContent = text;
    node.classList.toggle('is-over', over);
  }
}

function topbar(state: GameState | null): HTMLElement {
  return h(
    'div',
    { class: 'topbar__inner' },
    h('span', { class: 'brand', text: '⚔️ Retro Raiders' }),
    state
      ? h(
          'div',
          { class: 'topbar__meta' },
          h('button', {
            class: 'room-code',
            type: 'button',
            title: 'Copy the invite link',
            'aria-label': `Room ${state.code}. Copy the invite link`,
            text: state.code,
            onClick: () => void copyInvite(state.code),
          }),
          timerControl(state),
          h('span', { class: 'phase-label', text: PHASE_LABEL[state.phase] }),
          h('span', { class: 'party-count', text: `${state.players.filter((p) => p.connected).length} online` }),
          state.canRestartCampaign
            ? h('button', {
                class: 'topbar__restart',
                type: 'button',
                text: 'Start new campaign',
                onClick: restartCampaign,
              })
            : null,
          state.canStartNewRoom
            ? h('button', {
                class: 'topbar__restart topbar__restart--room',
                type: 'button',
                text: 'Start new room',
                onClick: startNewRoom,
              })
            : null,
        )
      : null,
    h('span', {
      class: `conn conn--${store.connected ? 'on' : 'off'}`,
      title: store.connected ? 'Connected' : 'Reconnecting…',
      text: store.connected ? '●' : '○',
    }),
  );
}

function generatingView(initial: GameState): View {
  const hint = h('p', { class: 'field__hint' });
  const update = (state: GameState): void => {
    hint.textContent = state.generation.message ?? 'Reading the post-its, sharpening their teeth…';
  };
  update(initial);
  return {
    root: panel('Summoning the dungeon', h('div', { class: 'summoning' }, h('span', { class: 'spinner spinner--lg' })), hint),
    update,
  };
}

function createView(state: GameState): View {
  switch (state.phase) {
    case 'forge':
      return createForge(state);
    case 'topics':
      return createTopics(state);
    case 'generating':
      return generatingView(state);
    case 'level':
      return createLevel(state, getState);
    case 'victory':
      return createVictory(state);
    default:
      return { root: panel('Retro Raiders', h('p', { class: 'empty', text: 'Unknown phase.' })), update: () => undefined };
  }
}

/** A new key means a genuinely new screen; anything else is patched in place. */
function viewKey(state: GameState): string {
  return [state.code, state.campaignId, state.phase, state.phase === 'level' ? state.level?.generatedAt : ''].join('|');
}

let current: { key: string; view: View } | null = null;
let join: ReturnType<typeof createJoin> | null = null;
let noticeHost: HTMLElement | null = null;
let viewHost: HTMLElement | null = null;

function render(): void {
  const topbarHost = document.getElementById('topbar');
  const stageHost = document.getElementById('stage');
  if (!topbarHost || !stageHost) return;
  if (!noticeHost || !viewHost) {
    noticeHost = h('div', { class: 'stage-notices', 'aria-live': 'polite' });
    viewHost = h('div', { class: 'stage-view' });
    mount(stageHost, noticeHost, viewHost);
  }

  const state = store.state;
  patch(
    topbarHost,
    [
      state?.code,
      state?.phase,
      state?.players.filter((p) => p.connected).length,
      state?.canRestartCampaign,
      state?.canStartNewRoom,
      state?.timer,
      state?.you.isFacilitator,
      store.connected,
    ],
    () => topbar(state),
  );
  tickTimers();

  if (!state) {
    current?.view.destroy?.();
    current = null;
    document.body.dataset.phase = 'join';
    if (!join) {
      join = createJoin();
      mount(viewHost, join.root);
    } else {
      join.update();
    }
    mount(noticeHost);
    return;
  }

  join = null;
  document.body.dataset.phase = state.phase;
  const key = viewKey(state);
  if (!current || current.key !== key) {
    current?.view.destroy?.();
    current = { key, view: createView(state) };
    mount(viewHost, current.view.root);
  } else {
    current.view.update(state);
  }

  patch(noticeHost, [store.connected, state.phase !== 'generating' ? state.generation.message : null], () => [
    store.connected ? null : h('p', { class: 'notice notice--warn', text: 'Connection lost. Trying to get back in…' }),
    state.generation.message && state.phase !== 'generating'
      ? h('p', { class: 'notice', text: state.generation.message })
      : null,
  ]);
}

function boot(): void {
  attachSocketLifecycle();
  onChange(render);
  window.setInterval(tickTimers, 1000);
  document.getElementById('leave')?.addEventListener('click', () => leave());
  render();
  notify();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

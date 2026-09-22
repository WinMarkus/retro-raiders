import { PHASE_LABEL } from '../shared/constants.js';
import type { GameState } from '../shared/types.js';
import { h, mount } from './dom.js';
import { attachSocketLifecycle, leave, notify, onChange, store } from './store.js';
import { renderForge } from './views/forge.js';
import { renderJoin } from './views/join.js';
import { renderLevel, stopLevelLoop } from './views/level.js';
import { renderTopics } from './views/topics.js';
import { renderVictory } from './views/victory.js';
import { panel } from './views/ui.js';

const getState = (): GameState | null => store.state;

function topbar(state: GameState | null): HTMLElement {
  return h(
    'div',
    { class: 'topbar__inner' },
    h('span', { class: 'brand', text: '⚔️ Retro Raiders' }),
    state
      ? h(
          'div',
          { class: 'topbar__meta' },
          h('span', { class: 'room-code', title: 'Room code', text: state.code }),
          h('span', { class: 'phase-label', text: PHASE_LABEL[state.phase] }),
          h('span', { class: 'party-count', text: `${state.players.filter((p) => p.connected).length} online` }),
        )
      : null,
    h('span', {
      class: `conn conn--${store.connected ? 'on' : 'off'}`,
      title: store.connected ? 'Connected' : 'Reconnecting…',
      text: store.connected ? '●' : '○',
    }),
  );
}

function stageFor(state: GameState): HTMLElement {
  switch (state.phase) {
    case 'forge':
      return renderForge(state);
    case 'topics':
      return renderTopics(state);
    case 'generating':
      return panel(
        'Summoning the dungeon',
        h('div', { class: 'summoning' }, h('span', { class: 'spinner spinner--lg' })),
        h('p', {
          class: 'field__hint',
          text: state.generation.message ?? 'Reading the post-its, sharpening their teeth…',
        }),
      );
    case 'level':
      return renderLevel(state, getState);
    case 'victory':
      return renderVictory(state);
    default:
      return panel('Retro Raiders', h('p', { class: 'empty', text: 'Unknown phase.' }));
  }
}

function render(): void {
  const topbarHost = document.getElementById('topbar');
  const stageHost = document.getElementById('stage');
  if (!topbarHost || !stageHost) return;

  const state = store.state;
  mount(topbarHost, topbar(state));

  if (!state) {
    stopLevelLoop();
    mount(stageHost, renderJoin());
    document.body.dataset.phase = 'join';
    return;
  }

  if (state.phase !== 'level') stopLevelLoop();
  document.body.dataset.phase = state.phase;

  mount(
    stageHost,
    store.connected
      ? null
      : h('p', { class: 'notice notice--warn', text: 'Connection lost. Trying to get back in…' }),
    stageFor(state),
    state.generation.message && state.phase !== 'generating'
      ? h('p', { class: 'notice', text: state.generation.message })
      : null,
  );
}

function boot(): void {
  attachSocketLifecycle();
  onChange(render);
  document.getElementById('leave')?.addEventListener('click', () => leave());
  render();
  notify();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

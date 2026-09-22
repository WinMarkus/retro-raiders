import { PHASES, PHASE_META } from '../shared/constants.js';
import type { GameState } from '../shared/types.js';
import { h, mount, withFocusPreserved } from './dom.js';
import { act, attachSocketLifecycle, clearSession, onRender, render, state } from './store.js';
import { renderAdventurer } from './views/adventurer.js';
import { renderBoss } from './views/boss.js';
import { renderDiscuss } from './views/discuss.js';
import { renderExplore, renderReveal } from './views/dungeon.js';
import { renderForge } from './views/forge.js';
import { renderJoin } from './views/join.js';
import { renderLobby } from './views/lobby.js';
import { renderPack } from './views/pack.js';
import { button } from './views/ui.js';
import { renderVictory } from './views/victory.js';

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Connecting…',
  online: 'Connected',
  offline: 'Offline — retrying',
};

function topbar(game: GameState | null): HTMLElement {
  const connection = h(
    'span',
    { class: `conn conn--${state.connection}` },
    h('span', { class: 'conn__dot', 'aria-hidden': 'true' }),
    h('span', { text: CONNECTION_LABEL[state.connection] ?? '' }),
  );

  if (!game) {
    return h(
      'div',
      { class: 'topbar__inner' },
      h('span', { class: 'brand' }, h('span', { 'aria-hidden': 'true', text: '🗡️' }), 'Retro Raiders'),
      connection,
    );
  }

  const awayCount = game.players.filter((player) => !player.connected).length;

  return h(
    'div',
    { class: 'topbar__inner' },
    h('span', { class: 'brand' }, h('span', { 'aria-hidden': 'true', text: '🗡️' }), 'Retro Raiders'),
    h(
      'span',
      { class: 'topbar__room' },
      h('span', { class: 'topbar__room-label', text: 'Room' }),
      h('strong', { class: 'topbar__code', text: game.code }),
    ),
    h('span', { class: 'topbar__phase', text: `${PHASE_META[game.phase].step} · ${PHASE_META[game.phase].title}` }),
    h('span', {
      class: 'topbar__party',
      text: `${game.players.length} raider${game.players.length === 1 ? '' : 's'}${awayCount ? ` · ${awayCount} reconnecting` : ''}`,
    }),
    connection,
  );
}

function phaseRail(game: GameState): HTMLElement {
  const currentIndex = PHASES.indexOf(game.phase);
  return h(
    'nav',
    { class: 'rail', 'aria-label': 'Raid progress' },
    ...PHASES.map((phase, index) =>
      h(
        'span',
        {
          class: `rail__step ${index === currentIndex ? 'rail__step--current' : ''} ${
            index < currentIndex ? 'rail__step--done' : ''
          }`.trim(),
          'aria-current': index === currentIndex ? 'step' : undefined,
          title: PHASE_META[phase].title,
        },
        h('span', { class: 'rail__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'rail__label', text: PHASE_META[phase].title }),
      ),
    ),
  );
}

function facilitatorBar(game: GameState): HTMLElement | null {
  if (!game.you.isFacilitator) return null;
  const isLast = game.phase === PHASES[PHASES.length - 1];
  return h(
    'div',
    { class: 'facilitator__inner' },
    h('span', { class: 'facilitator__label' }, h('span', { 'aria-hidden': 'true', text: '🔥' }), 'Facilitator controls'),
    h(
      'div',
      { class: 'facilitator__actions' },
      button('Back one phase', {
        class: 'btn--ghost btn--small',
        disabled: game.phase === 'lobby',
        onClick: () => void act('phase:back'),
      }),
      button(isLast ? 'The raid is over' : 'Next phase', {
        class: 'btn--primary btn--small',
        disabled: isLast,
        onClick: () => void act('phase:next'),
      }),
      button('Reset the game', {
        class: 'btn--danger btn--small',
        onClick: () => {
          const ok = window.confirm(
            'Reset the whole raid? Every card, token, vote and experiment in this room is wiped and the party goes back to the lobby.',
          );
          if (ok) void act('game:reset');
        },
      }),
    ),
  );
}

function stageFor(game: GameState): HTMLElement {
  switch (game.phase) {
    case 'lobby':
      return renderLobby(game);
    case 'adventurer':
      return renderAdventurer(game);
    case 'pack':
      return renderPack(game);
    case 'reveal':
      return renderReveal(game);
    case 'explore':
      return renderExplore(game);
    case 'discuss':
      return renderDiscuss(game);
    case 'boss':
      return renderBoss(game);
    case 'forge':
      return renderForge(game);
    case 'victory':
      return renderVictory(game);
    default:
      return h('p', { text: 'Unknown phase.' });
  }
}

function renderApp(): void {
  const topbarHost = document.getElementById('topbar');
  const stage = document.getElementById('stage');
  const facilitator = document.getElementById('facilitator');
  if (!topbarHost || !stage || !facilitator) return;

  withFocusPreserved(() => {
    const game = state.screen === 'game' ? state.game : null;
    mount(topbarHost, topbar(game));

    if (!game) {
      mount(stage, renderJoin());
      mount(facilitator);
      facilitator.hidden = true;
      document.body.classList.add('body--join');
      return;
    }

    document.body.classList.remove('body--join');
    mount(
      stage,
      phaseRail(game),
      h(
        'header',
        { class: 'phase-head' },
        h('h1', { class: 'phase-head__title', text: PHASE_META[game.phase].title }),
        h('p', { class: 'phase-head__blurb', text: PHASE_META[game.phase].blurb }),
      ),
      state.connection === 'offline'
        ? h('p', { class: 'notice notice--warn', role: 'status', text: 'Connection lost. Your seat is kept — this page rejoins automatically.' })
        : null,
      stageFor(game),
    );

    const bar = facilitatorBar(game);
    if (bar) {
      mount(facilitator, bar);
      facilitator.hidden = false;
    } else {
      mount(facilitator);
      facilitator.hidden = true;
    }
  });
}

function boot(): void {
  onRender(renderApp);
  attachSocketLifecycle();

  document.getElementById('leave')?.addEventListener('click', () => {
    const ok = window.confirm('Leave this room on this device? The rest of the party keeps playing.');
    if (!ok) return;
    clearSession();
    state.screen = 'join';
    state.game = null;
    window.history.replaceState({}, '', '/');
    window.location.reload();
  });

  render();
}

boot();

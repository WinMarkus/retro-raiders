import { LIMITS, MAP } from '../../shared/constants.js';
import type { Enemy, GameState, MoveBroadcast, Point, PowerUp } from '../../shared/types.js';
import { h, mount } from '../dom.js';
import { act, socket, store } from '../store.js';
import { button, field, panel } from './ui.js';

const SPEED = 260; // map units per second
const EMIT_MS = 80;

interface LevelView {
  root: HTMLElement;
  map: HTMLElement;
  hud: HTMLElement;
  modalHost: HTMLElement;
  enemyNodes: Map<string, HTMLElement>;
  powerNodes: Map<string, HTMLElement>;
  tokens: Map<string, HTMLElement>;
  levelStamp: number;
}

let view: LevelView | null = null;
let ownPosition: Point = { x: MAP.width / 2, y: MAP.height - 80 };
let target: Point | null = null;
let lastEmit = 0;
let frame = 0;
let openEncounterId: string | null = null;
const keys = new Set<string>();

/* --------------------------------------------------------- geometry -- */

function percent(position: Point): { left: string; top: string } {
  return {
    left: `${(position.x / MAP.width) * 100}%`,
    top: `${(position.y / MAP.height) * 100}%`,
  };
}

function place(node: HTMLElement, position: Point): void {
  const { left, top } = percent(position);
  node.style.left = left;
  node.style.top = top;
}

/* ------------------------------------------------------ input loop -- */

function onKeyDown(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const key = event.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(key)) {
    keys.add(key);
    target = null;
    event.preventDefault();
  }
}

function onKeyUp(event: KeyboardEvent): void {
  keys.delete(event.key.toLowerCase());
}

function step(dt: number, paused: boolean): void {
  if (paused) return;
  let dx = 0;
  let dy = 0;
  if (keys.has('arrowup') || keys.has('w')) dy -= 1;
  if (keys.has('arrowdown') || keys.has('s')) dy += 1;
  if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
  if (keys.has('arrowright') || keys.has('d')) dx += 1;

  if (dx === 0 && dy === 0 && target) {
    const toX = target.x - ownPosition.x;
    const toY = target.y - ownPosition.y;
    const length = Math.hypot(toX, toY);
    if (length < 6) {
      target = null;
    } else {
      dx = toX / length;
      dy = toY / length;
    }
  }

  if (dx === 0 && dy === 0) return;
  const length = Math.hypot(dx, dy) || 1;
  ownPosition = {
    x: clamp(ownPosition.x + (dx / length) * SPEED * dt, MAP.margin / 2, MAP.width - MAP.margin / 2),
    y: clamp(ownPosition.y + (dy / length) * SPEED * dt, MAP.margin / 2, MAP.height - MAP.margin / 2),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function startLoop(getState: () => GameState | null): void {
  if (frame) return;
  let previous = performance.now();
  const tick = (now: number): void => {
    const dt = Math.min(0.05, (now - previous) / 1000);
    previous = now;
    const state = getState();
    if (state && state.phase === 'level') {
      step(dt, Boolean(state.encounter));
      const own = view?.tokens.get(state.you.id);
      if (own) place(own, ownPosition);
      if (now - lastEmit > EMIT_MS) {
        lastEmit = now;
        socket.emit('player:move', ownPosition);
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('party:moved', onPartyMoved);
}

const onPartyMoved = ((event: CustomEvent<MoveBroadcast>): void => {
  const node = view?.tokens.get(event.detail.playerId);
  if (node) place(node, event.detail.position);
}) as EventListener;

export function stopLevelLoop(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  keys.clear();
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('party:moved', onPartyMoved);
  view = null;
  openEncounterId = null;
}

/* ----------------------------------------------------------- nodes -- */

function enemyNode(enemy: Enemy): HTMLElement {
  const node = h(
    'button',
    {
      class: `foe foe--${enemy.kind}`,
      type: 'button',
      'data-enemy': enemy.id,
      title: enemy.name,
      onClick: () => void act('enemy:lock', { enemyId: enemy.id }),
    },
    h('span', { class: 'foe__glyph', text: glyphFor(enemy.kind) }),
    h('span', { class: 'foe__name', text: enemy.name }),
    h('span', { class: 'foe__locks' }),
  );
  place(node, enemy.position);
  return node;
}

function glyphFor(kind: Enemy['kind']): string {
  switch (kind) {
    case 'boss':
      return '🐉';
    case 'miniboss':
      return '👹';
    case 'trap':
      return '🕳️';
    case 'curse':
      return '🌀';
    default:
      return '👾';
  }
}

function powerNode(powerUp: PowerUp): HTMLElement {
  const node = h(
    'div',
    { class: 'boon', 'data-power': powerUp.id, title: `${powerUp.name} (+${powerUp.attackPoints})` },
    h('span', { class: 'boon__glyph', text: '🧪' }),
    h('span', { class: 'boon__name', text: powerUp.name }),
  );
  place(node, powerUp.position);
  return node;
}

function tokenNode(name: string, emoji: string, hue: number, isYou: boolean): HTMLElement {
  return h(
    'div',
    { class: `token${isYou ? ' token--you' : ''}`, style: `--avatar-hue:${hue}` },
    h('span', { class: 'token__glyph', text: emoji }),
    h('span', { class: 'token__name', text: name }),
  );
}

/* ---------------------------------------------------------- render -- */

export function renderLevel(state: GameState, getState: () => GameState | null): HTMLElement {
  const level = state.level;
  if (!level) return panel('The dungeon', h('p', { class: 'empty', text: 'No level generated yet.' }));

  if (!view || view.levelStamp !== level.generatedAt) {
    view = buildView(state);
    const me = state.players.find((player) => player.id === state.you.id);
    if (me) ownPosition = { ...me.position };
    startLoop(getState);
  }

  update(view, state);
  return view.root;
}

function buildView(state: GameState): LevelView {
  const level = state.level!;
  const enemyNodes = new Map<string, HTMLElement>();
  const powerNodes = new Map<string, HTMLElement>();
  const tokens = new Map<string, HTMLElement>();

  const map = h('div', { class: 'map', role: 'application', 'aria-label': 'Dungeon map' });

  for (const powerUp of level.powerUps) {
    const node = powerNode(powerUp);
    powerNodes.set(powerUp.id, node);
    map.appendChild(node);
  }
  for (const enemy of level.enemies) {
    const node = enemyNode(enemy);
    enemyNodes.set(enemy.id, node);
    map.appendChild(node);
  }
  for (const player of state.players) {
    const node = tokenNode(
      player.name,
      player.character?.emoji ?? '🎲',
      player.character?.hue ?? 210,
      player.id === state.you.id,
    );
    place(node, store.positions.get(player.id) ?? player.position);
    tokens.set(player.id, node);
    map.appendChild(node);
  }

  map.addEventListener('click', (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.foe')) return;
    const rect = map.getBoundingClientRect();
    target = {
      x: ((event.clientX - rect.left) / rect.width) * MAP.width,
      y: ((event.clientY - rect.top) / rect.height) * MAP.height,
    };
  });

  const hud = h('div', { class: 'hud' });
  const modalHost = h('div', { class: 'modal-host' });

  const root = h(
    'div',
    { class: 'stage stage--level' },
    h(
      'div',
      { class: 'level__head' },
      h('h2', { class: 'level__title', text: level.title }),
      h('p', { class: 'level__intro', text: level.intro }),
    ),
    map,
    hud,
    modalHost,
  );

  return { root, map, hud, modalHost, enemyNodes, powerNodes, tokens, levelStamp: level.generatedAt };
}

function update(current: LevelView, state: GameState): void {
  const level = state.level!;

  for (const enemy of level.enemies) {
    const node = current.enemyNodes.get(enemy.id);
    if (!node) continue;
    node.classList.toggle('foe--resolved', enemy.status === 'resolved');
    node.classList.toggle('foe--locked', enemy.status === 'locked');
    node.classList.toggle('foe--mine', state.you.lockedEnemyId === enemy.id);
    const locks = node.querySelector('.foe__locks');
    if (locks) {
      locks.textContent =
        enemy.status === 'resolved'
          ? '❄ frozen'
          : enemy.lockedBy.length > 0
            ? `🎯 ${enemy.lockedBy.length}`
            : '';
    }
  }

  for (const powerUp of level.powerUps) {
    const node = current.powerNodes.get(powerUp.id);
    if (node) node.classList.toggle('boon--taken', Boolean(powerUp.collectedBy));
  }

  // Players can join mid-level, so tokens are reconciled on every push.
  for (const player of state.players) {
    let node = current.tokens.get(player.id);
    if (!node) {
      node = tokenNode(
        player.name,
        player.character?.emoji ?? '🎲',
        player.character?.hue ?? 210,
        player.id === state.you.id,
      );
      current.tokens.set(player.id, node);
      current.map.appendChild(node);
    }
    node.classList.toggle('token--away', !player.connected);
    if (player.id !== state.you.id) place(node, store.positions.get(player.id) ?? player.position);
  }

  const active = level.enemies.filter((enemy) => enemy.status !== 'resolved').length;
  mount(
    current.hud,
    h(
      'div',
      { class: 'hud__stats' },
      hudStat('⚔️ Attack points', `${state.attack.available} left`, `${state.attack.spent} spent`),
      hudStat('👾 Enemies', `${active} standing`, `${state.resolutions.length} frozen`),
      hudStat('🧪 Power-ups', `${level.powerUps.filter((p) => p.collectedBy).length}/${level.powerUps.length}`, 'collected'),
    ),
    h(
      'div',
      { class: 'hud__actions' },
      h('span', {
        class: 'hud__hint',
        text: state.encounter
          ? 'Fight in progress.'
          : 'WASD or arrows to move, click the map to walk, click an enemy to lock on.',
      }),
      state.you.lockedEnemyId && !state.encounter
        ? button('Release lock', () => void act('enemy:unlock'), 'ghost')
        : null,
      state.you.isFacilitator ? button('End the raid', () => void act('game:end'), 'danger') : null,
    ),
  );

  if (state.encounter && openEncounterId !== state.encounter.enemyId) {
    openEncounterId = state.encounter.enemyId;
    const enemy = level.enemies.find((candidate) => candidate.id === state.encounter!.enemyId);
    if (enemy) mount(current.modalHost, encounterModal(enemy, state));
  } else if (!state.encounter && openEncounterId) {
    openEncounterId = null;
    mount(current.modalHost);
  }
}

function hudStat(label: string, value: string, sub: string): HTMLElement {
  return h(
    'div',
    { class: 'hud__stat' },
    h('span', { class: 'hud__label', text: label }),
    h('strong', { class: 'hud__value', text: value }),
    h('span', { class: 'hud__sub', text: sub }),
  );
}

function encounterModal(enemy: Enemy, state: GameState): HTMLElement {
  const maxSpend = Math.min(LIMITS.maxAttackPerEnemy, state.attack.available);
  let spend = Math.min(maxSpend, Math.max(1, enemy.strength));

  const treatment = h('textarea', {
    class: 'input input--area',
    rows: '3',
    maxlength: String(LIMITS.treatmentText),
    placeholder: 'Reviewers pick up PRs in the morning slot before new work, checked at standup.',
  });
  const owner = h('input', { class: 'input', type: 'text', maxlength: '60', placeholder: 'Optional owner' });
  const reviewBy = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'next retro' });

  const spendOutput = h('output', { class: 'scale__value', text: String(spend) });
  const spendInput = h('input', {
    class: 'scale__input',
    type: 'range',
    min: '0',
    max: String(Math.max(maxSpend, 0)),
    step: '1',
    value: String(spend),
    disabled: maxSpend === 0,
    onInput: (event: Event) => {
      spend = Number.parseInt((event.target as HTMLInputElement).value, 10);
      spendOutput.textContent = String(spend);
    },
  });

  const error = h('p', { class: 'notice notice--error', hidden: true });

  const submit = async (): Promise<void> => {
    const result = await act('encounter:resolve', {
      treatment: treatment.value,
      owner: owner.value,
      reviewBy: reviewBy.value,
      attackPoints: spend,
    });
    if (!result.ok) {
      error.textContent = result.error;
      error.removeAttribute('hidden');
    }
  };

  return h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Encounter: ${enemy.name}` },
    h(
      'div',
      { class: 'modal__card' },
      h(
        'header',
        { class: 'modal__head' },
        h('span', { class: 'modal__glyph', text: glyphFor(enemy.kind) }),
        h(
          'div',
          {},
          h('h2', { class: 'modal__title', text: enemy.name }),
          h('p', { class: 'modal__kind', text: `${enemy.kind} · strength ${enemy.strength}/5` }),
        ),
      ),
      h('p', { class: 'modal__text', text: enemy.description }),
      h(
        'div',
        { class: 'modal__topics' },
        h('h3', { class: 'modal__subtitle', text: 'Born from' }),
        h('ul', {}, ...enemy.sourceTopics.map((topic) => h('li', { text: topic }))),
      ),
      h('p', {
        class: 'modal__party',
        text: `Locked on: ${state.encounter?.party.join(', ') ?? ''}`,
      }),
      field('How does the team want to handle this?', treatment),
      h('div', { class: 'modal__grid' }, field('Owner', owner), field('Review', reviewBy)),
      h(
        'div',
        { class: 'scale' },
        h('span', { class: 'field__label', text: `Attack points to spend (${state.attack.available} available)` }),
        h('div', { class: 'scale__row' }, spendInput, spendOutput),
        h('span', {
          class: 'field__hint',
          text:
            maxSpend === 0
              ? 'Collect a power-up first. Every fight must spend at least one attack point.'
              : 'Points are priority, not damage: spend more on what the team really wants fixed.',
        }),
      ),
      error,
      h(
        'div',
        { class: 'modal__actions' },
        button('Strike — freeze this enemy', () => void submit(), 'primary', maxSpend === 0),
        button('Back off', () => void act('encounter:abandon'), 'ghost'),
      ),
    ),
  );
}

import { ADVENTURER_CLASSES } from '../../shared/constants.js';
import type { GameState } from '../../shared/types.js';
import { h } from '../dom.js';
import { act } from '../store.js';
import { button, panel, party } from './ui.js';

const ENERGY_LABELS: Record<number, string> = {
  1: 'Running on fumes',
  2: 'Low, but upright',
  3: 'Steady',
  4: 'Fresh',
  5: 'Ready to fight a dragon',
};

export function renderAdventurer(game: GameState): HTMLElement {
  const me = game.players.find((player) => player.id === game.you.id);

  const classes = h(
    'div',
    { class: 'class-grid' },
    ...ADVENTURER_CLASSES.map((adventurer) =>
      h(
        'button',
        {
          type: 'button',
          class: `class-card ${me?.classId === adventurer.id ? 'class-card--picked' : ''}`.trim(),
          'aria-pressed': me?.classId === adventurer.id ? 'true' : 'false',
          onClick: () => void act('player:setClass', { classId: adventurer.id }),
        },
        h('span', { class: 'class-card__emoji', 'aria-hidden': 'true', text: adventurer.emoji }),
        h('span', { class: 'class-card__name', text: adventurer.name }),
        h('span', { class: 'class-card__tagline', text: adventurer.tagline }),
      ),
    ),
  );

  const energy = h(
    'div',
    { class: 'energy' },
    h('div', { class: 'energy__scale', role: 'group', 'aria-label': 'Energy level from 1 to 5' }, ...[1, 2, 3, 4, 5].map((level) =>
      h(
        'button',
        {
          type: 'button',
          class: `energy__step ${me?.energy === level ? 'energy__step--picked' : ''}`.trim(),
          'aria-pressed': me?.energy === level ? 'true' : 'false',
          'aria-label': `${level} of 5 — ${ENERGY_LABELS[level]}`,
          onClick: () => void act('player:setEnergy', { energy: level }),
        },
        h('span', { class: 'energy__flame', 'aria-hidden': 'true', text: '🔥' }),
        h('span', { class: 'energy__number', text: String(level) }),
      ),
    )),
    h('p', {
      class: 'field__hint',
      text: me?.energy
        ? `You brought: ${ENERGY_LABELS[me.energy]}.`
        : 'Pick the level that matches today. It is a weather report, not a performance review.',
    }),
  );

  const energies = game.players
    .map((player) => player.energy)
    .filter((value): value is number => typeof value === 'number');
  const combined = energies.reduce((sum, value) => sum + value, 0);
  const maxCombined = game.players.length * 5;

  const readyCount = game.readyPlayerIds.length;

  return h(
    'div',
    { class: 'grid grid--two' },
    panel('Choose an adventurer', 'Classes are cosmetic. Everyone votes with the same weight.', classes),
    panel(
      'Party energy',
      'Combined, never per person.',
      energy,
      h(
        'div',
        { class: 'meter' },
        h('div', {
          class: 'meter__fill',
          style: `width:${maxCombined ? Math.round((combined / maxCombined) * 100) : 0}%`,
        }),
      ),
      h('p', {
        class: 'meter__caption',
        text: energies.length
          ? `The party carries ${combined} of a possible ${maxCombined} torches (${energies.length} of ${game.players.length} reported).`
          : 'No readings yet.',
      }),
      h(
        'div',
        { class: 'actions' },
        button(game.myReady ? 'I need a moment' : 'Ready', {
          class: game.myReady ? 'btn--ghost' : 'btn--primary',
          onClick: () => void act('ready:set', { ready: !game.myReady }),
        }),
        h('p', { class: 'field__hint', text: `${readyCount} of ${game.players.length} raiders ready.` }),
      ),
      party(game.players, { showReady: true }),
    ),
  );
}

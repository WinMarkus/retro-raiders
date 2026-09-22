import { CATEGORIES, CATEGORY_META, LIMITS } from '../../shared/constants.js';
import type { Category, GameState } from '../../shared/types.js';
import { debounce, h } from '../dom.js';
import { act } from '../store.js';
import { button, panel, party } from './ui.js';

const pushDraft = debounce((category: Category, index: number, text: string) => {
  void act('draft:set', { category, index, text });
}, 320);

const PLACEHOLDERS: Record<Category, string[]> = {
  loot: ['The new preview environments saved us a day', 'Someone finally documented the release steps'],
  trap: ['Three days waiting on a review', 'The staging database drifted again'],
  monster: ['Flaky payment tests block every merge', 'Scope arrives after the estimate'],
};

function cardField(game: GameState, category: Category, index: number): HTMLElement {
  const meta = CATEGORY_META[category];
  const value = game.myDraft[category]?.[index] ?? '';
  const locked = game.myReady;
  const id = `draft-${category}-${index}`;
  return h(
    'div',
    { class: `draft draft--${category}` },
    h('label', { class: 'draft__label', for: id }, h('span', { 'aria-hidden': 'true', text: meta.emoji }), `${meta.label} ${index + 1}`),
    h('textarea', {
      class: 'input input--area',
      id,
      'data-key': id,
      rows: '3',
      maxlength: LIMITS.cardText,
      disabled: locked,
      placeholder: PLACEHOLDERS[category][index] ?? meta.prompt,
      value,
      onInput: (event: Event) => {
        const target = event.target as HTMLTextAreaElement;
        game.myDraft[category][index] = target.value;
        pushDraft(category, index, target.value);
        const counter = document.getElementById(`${id}-count`);
        if (counter) counter.textContent = `${target.value.length}/${LIMITS.cardText}`;
      },
    }),
    h('span', { class: 'draft__count', id: `${id}-count`, text: `${value.length}/${LIMITS.cardText}` }),
  );
}

export function renderPack(game: GameState): HTMLElement {
  const columns = CATEGORIES.map((category) => {
    const meta = CATEGORY_META[category];
    return h(
      'div',
      { class: 'pack-column' },
      h(
        'header',
        { class: `pack-column__head pack-column__head--${category}` },
        h('span', { class: 'pack-column__emoji', 'aria-hidden': 'true', text: meta.emoji }),
        h('h3', { class: 'pack-column__title', text: meta.plural }),
        h('p', { class: 'pack-column__prompt', text: meta.prompt }),
      ),
      ...Array.from({ length: LIMITS.cardsPerCategory }, (_, index) => cardField(game, category, index)),
    );
  });

  const filled = CATEGORIES.reduce(
    (count, category) => count + (game.myDraft[category] ?? []).filter((text) => text.trim().length > 0).length,
    0,
  );

  return h(
    'div',
    { class: 'grid grid--wide' },
    panel(
      'Pack the dungeon',
      'Nobody sees a single word until the facilitator reveals the map — not even who is writing.',
      h('div', { class: 'pack-grid' }, ...columns),
      h(
        'div',
        { class: 'actions actions--split' },
        h('p', { class: 'field__hint', text: `${filled} of ${CATEGORIES.length * LIMITS.cardsPerCategory} cards written. Empty cards are simply left out.` }),
        button(game.myReady ? 'Keep editing' : 'Ready — seal my pack', {
          class: game.myReady ? 'btn--ghost' : 'btn--primary',
          onClick: () => void act('ready:set', { ready: !game.myReady }),
        }),
      ),
    ),
    panel(
      `Sealed packs (${game.readyPlayerIds.length}/${game.players.length})`,
      'You can see who is ready. You cannot see what they wrote.',
      party(game.players, { showReady: true }),
    ),
  );
}

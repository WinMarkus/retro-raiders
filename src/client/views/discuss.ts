import { CATEGORY_META, LIMITS } from '../../shared/constants.js';
import type { GameState } from '../../shared/types.js';
import { debounce, formatClock, h } from '../dom.js';
import { act } from '../store.js';
import { button, categoryBadge, emptyState, panel } from './ui.js';

const pushNote = debounce((cardId: string, text: string) => {
  void act('card:note', { cardId, text });
}, 350);

export function renderDiscuss(game: GameState): HTMLElement {
  const discussion = game.discussion;
  if (!discussion || discussion.order.length === 0) {
    return panel(
      'Nothing to explore',
      'No room collected a token.',
      emptyState('The map is quiet.', 'Step back to the exploring phase and spend some tokens first.'),
    );
  }

  const currentId = discussion.order[discussion.index];
  const card = game.cards.find((item) => item.id === currentId);
  if (!card) {
    return panel('That room collapsed', 'The card is gone.', emptyState('Pick another room from the queue.'));
  }

  const clock = h('div', {
    class: `clock ${discussion.secondsLeft <= 30 ? 'clock--low' : ''}`.trim(),
    id: 'discussion-clock',
    role: 'timer',
    'aria-live': 'off',
    text: formatClock(discussion.secondsLeft),
  });

  const controls = game.you.isFacilitator
    ? h(
        'div',
        { class: 'timer-controls' },
        button(discussion.running ? 'Pause' : 'Start', {
          class: 'btn--primary btn--small',
          onClick: () => void act('discuss:control', { action: discussion.running ? 'pause' : 'start' }),
        }),
        button('+1 minute', { class: 'btn--ghost btn--small', onClick: () => void act('discuss:control', { action: 'add60' }) }),
        button('Reset', { class: 'btn--ghost btn--small', onClick: () => void act('discuss:control', { action: 'reset' }) }),
        button('Previous room', {
          class: 'btn--ghost btn--small',
          disabled: discussion.index === 0,
          onClick: () => void act('discuss:control', { action: 'previous' }),
        }),
        button('Skip to next room', {
          class: 'btn--ghost btn--small',
          disabled: discussion.index >= discussion.order.length - 1,
          onClick: () => void act('discuss:control', { action: 'skip' }),
        }),
        h(
          'label',
          { class: 'timer-controls__duration' },
          'Minutes per room',
          h('input', {
            class: 'input input--tiny',
            'data-key': 'discussion-duration',
            type: 'number',
            min: '1',
            max: '15',
            value: String(Math.round(discussion.durationSec / 60)),
            onChange: (event: Event) => {
              const minutes = Number.parseInt((event.target as HTMLInputElement).value, 10);
              if (!Number.isFinite(minutes)) return;
              const seconds = Math.min(
                LIMITS.discussionMaxSec,
                Math.max(LIMITS.discussionMinSec, Math.round(minutes) * 60),
              );
              void act('discuss:setDuration', { seconds });
            },
          }),
        ),
      )
    : h('p', { class: 'field__hint', text: 'The facilitator drives the clock.' });

  const notes = h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: 'card-note', text: 'Shared notes for this room' }),
    h('textarea', {
      class: 'input input--area input--notes',
      id: 'card-note',
      'data-key': `note-${card.id}`,
      rows: '5',
      maxlength: LIMITS.noteText,
      placeholder: 'What did we learn? What is the real cause? Everyone types into the same page.',
      value: card.notes,
      onInput: (event: Event) => pushNote(card.id, (event.target as HTMLTextAreaElement).value),
    }),
    h('p', { class: 'field__hint', text: 'Visible to the whole party as you type. It lands in the summary and the export.' }),
  );

  const queue = h(
    'ol',
    { class: 'queue' },
    ...discussion.order.map((id, index) => {
      const item = game.cards.find((entry) => entry.id === id);
      const label = item ? item.texts[0] ?? '(empty)' : '(gone)';
      return h(
        'li',
        { class: `queue__item ${index === discussion.index ? 'queue__item--current' : ''}`.trim() },
        h('span', { class: 'queue__rank', text: String(index + 1) }),
        h('span', { class: 'queue__label', text: label }),
        h('span', {
          class: 'queue__tokens',
          text: item && item.tokens !== null ? `${item.tokens}` : '',
        }),
      );
    }),
  );

  return h(
    'div',
    { class: 'grid grid--two' },
    panel(
      `Room ${discussion.index + 1} of ${discussion.order.length}`,
      `${CATEGORY_META[card.category].room} · ${card.tokens ?? 0} tokens`,
      h(
        'article',
        { class: `room room--${card.category} room--spotlight` },
        h('header', { class: 'room__head' }, categoryBadge(card.category), card.merged ? h('span', { class: 'tag tag--merged', text: `Merged ×${card.texts.length}` }) : null),
        h('ul', { class: 'room__texts' }, ...card.texts.map((text) => h('li', { class: 'room__text', text }))),
      ),
      h('div', { class: 'clock-row' }, clock, controls),
      notes,
    ),
    panel('The queue', 'Sorted by tokens. The facilitator can jump back and forth.', queue),
  );
}

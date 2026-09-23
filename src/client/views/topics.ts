import { LIMITS, TOPIC_META, TOPIC_TYPES } from '../../shared/constants.js';
import type { GameState, TopicType } from '../../shared/types.js';
import { h, patch, setDisabled } from '../dom.js';
import { act } from '../store.js';
import { button, emptyState, field, panel, party, scaleInput, setBusy, type View } from './ui.js';

/** Built once per visit to the board; pushes only patch lists and counters. */
export function createTopics(initial: GameState): View {
  let type: TopicType = 'bad';
  let intensity = 3;
  let submitting = false;
  let current = initial;

  const titleInput = h('input', {
    class: 'input',
    type: 'text',
    maxlength: String(LIMITS.topicTitle),
    placeholder: 'Review takes too long',
  });
  const descriptionInput = h('textarea', {
    class: 'input input--area',
    rows: '2',
    maxlength: String(LIMITS.topicDescription),
    placeholder: 'Optional: what happened, how often, what it cost us',
  });

  const typeHint = h('p', { class: 'field__hint', text: TOPIC_META[type].hint });
  const typeButtons = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': 'Topic type' },
    ...TOPIC_TYPES.map((candidate) =>
      h('button', {
        class: `segmented__btn segmented__btn--${candidate}${candidate === type ? ' is-active' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': candidate === type ? 'true' : 'false',
        text: `${TOPIC_META[candidate].icon} ${TOPIC_META[candidate].label}`,
        title: TOPIC_META[candidate].hint,
        onClick: () => {
          type = candidate;
          typeHint.textContent = TOPIC_META[candidate].hint;
          for (const node of typeButtons.querySelectorAll('.segmented__btn')) {
            const active = node.classList.contains(`segmented__btn--${candidate}`);
            node.classList.toggle('is-active', active);
            node.setAttribute('aria-checked', active ? 'true' : 'false');
          }
        },
      }),
    ),
  );

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return;
    }
    submitting = true;
    update(current);
    try {
      const result = await act('topic:add', {
        type,
        title,
        description: descriptionInput.value,
        intensity,
      });
      if (result.ok) {
        titleInput.value = '';
        descriptionInput.value = '';
        titleInput.focus();
      }
    } finally {
      submitting = false;
      update(current);
    }
  };

  // Enter adds the topic and keeps you in the title field for the next one.
  titleInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });

  const addButton = button('Add topic', () => void submit(), 'primary');
  const countHint = h('span', { class: 'field__hint' });

  const submitPanel = panel(
    'Throw it on the pile',
    typeHint,
    typeButtons,
    field('Short title', titleInput),
    field('Details (optional)', descriptionInput),
    scaleInput('Intensity', intensity, (value) => {
      intensity = value;
    }, 'How hard did this hit? Repeated or intense things become stronger enemies.'),
    h('div', { class: 'row' }, addButton, countHint),
    h('p', { class: 'field__hint', text: 'Press Enter in the title to add it straight away.' }),
  );

  const mineHost = h('div');
  const minePanel = panel(
    'Your topics',
    mineHost,
    h('p', {
      class: 'field__hint',
      text: 'Only you see who wrote what. The dungeon is built from the pile, anonymously.',
    }),
  );

  const partyHost = h('div');
  const roomCount = h('p', { class: 'field__hint' });
  const doneHost = h('div', { class: 'row' });
  const facilitatorHost = h('div');
  const boardHost = h('div');

  const root = h(
    'div',
    { class: 'stage stage--split' },
    h('div', { class: 'stage__col' }, submitPanel, minePanel),
    h(
      'div',
      { class: 'stage__col' },
      panel('The party', partyHost, roomCount, doneHost, facilitatorHost),
      panel(
        'The pile',
        h('p', {
          class: 'field__hint',
          text: 'Everything on the board so far, without names. Spot a duplicate? Say it — similar topics merge into one stronger enemy anyway.',
        }),
        boardHost,
      ),
    ),
  );

  function update(state: GameState): void {
    current = state;
    const mine = state.you.topics;
    const full = mine.length >= LIMITS.maxTopicsPerPlayer;

    setBusy(addButton, submitting, 'Adding…', full ? 'Topic limit reached' : 'Add topic');
    setDisabled(addButton, submitting || full);
    countHint.textContent = `${mine.length}/${LIMITS.maxTopicsPerPlayer} of yours · ${state.topicCount} in the room`;

    patch(mineHost, mine, () =>
      mine.length === 0
        ? emptyState('Nothing from you yet. Good things count too — they become power-ups.')
        : h(
            'ul',
            { class: 'topic-list' },
            ...mine.map((topic) =>
              h(
                'li',
                { class: `topic topic--${topic.type}` },
                h('span', { class: 'topic__icon', text: TOPIC_META[topic.type].icon }),
                h(
                  'div',
                  { class: 'topic__body' },
                  h('p', { class: 'topic__title', text: topic.title }),
                  topic.description ? h('p', { class: 'topic__desc', text: topic.description }) : null,
                  h('p', { class: 'topic__meta', text: `intensity ${topic.intensity}/5` }),
                ),
                h('button', {
                  class: 'topic__remove',
                  type: 'button',
                  title: 'Remove',
                  'aria-label': `Remove ${topic.title}`,
                  text: '✕',
                  onClick: () => void act('topic:remove', { topicId: topic.id }),
                }),
              ),
            ),
          ),
    );

    patch(partyHost, state.players, () => party(state.players));
    const online = state.players.filter((player) => player.connected);
    const done = online.filter((player) => player.ready).length;
    patch(doneHost, [state.you.ready, done, online.length], () => [
      button(
        state.you.ready ? '✓ Done — add more anyway' : "I'm done adding",
        () => void act('ready:set', { ready: !state.you.ready }),
        state.you.ready ? 'ghost' : 'primary',
      ),
      h('span', { class: 'field__hint', text: `${done}/${online.length} done` }),
    ]);
    patch(boardHost, state.board, () =>
      state.board.length === 0
        ? emptyState('The pile is empty. Be the first.')
        : h(
            'div',
            { class: 'board' },
            ...TOPIC_TYPES.map((kind) => {
              const entries = state.board.filter((topic) => topic.type === kind);
              if (entries.length === 0) return null;
              return h(
                'section',
                { class: `board__group board__group--${kind}` },
                h('h3', { class: 'board__title', text: `${TOPIC_META[kind].icon} ${TOPIC_META[kind].label} · ${entries.length}` }),
                h(
                  'ul',
                  { class: 'board__list' },
                  ...entries.map((topic) =>
                    h(
                      'li',
                      { class: `board__item topic--${topic.type}`, title: topic.description || topic.title },
                      h('span', { class: 'board__text', text: topic.title }),
                      h('span', { class: 'board__intensity', 'aria-label': `intensity ${topic.intensity} of 5`, text: '●'.repeat(topic.intensity) }),
                    ),
                  ),
                ),
              );
            }),
          ),
    );
    roomCount.textContent = `${state.topicCount} topic${state.topicCount === 1 ? '' : 's'} collected.`;

    const enough = state.topicCount >= LIMITS.minTopicsToGenerate;
    patch(facilitatorHost, [state.you.isFacilitator, enough, state.generation.busy], () =>
      state.you.isFacilitator
        ? h(
            'div',
            { class: 'row' },
            button(
              enough ? 'Generate the dungeon' : `Need ${LIMITS.minTopicsToGenerate} topics`,
              () => void act('level:generate'),
              'primary',
              !enough || state.generation.busy,
            ),
            button('Back to the forge', () => void act('phase:back'), 'ghost'),
          )
        : h('p', { class: 'field__hint', text: 'The facilitator generates the dungeon when everyone is done.' }),
    );
  }

  update(initial);
  return { root, update };
}

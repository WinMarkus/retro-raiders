import { LIMITS, TOPIC_META, TOPIC_TYPES } from '../../shared/constants.js';
import type { GameState, TopicType } from '../../shared/types.js';
import { h } from '../dom.js';
import { act } from '../store.js';
import { button, emptyState, field, panel, party, scaleInput } from './ui.js';

let type: TopicType = 'bad';
let intensity = 3;

export function renderTopics(state: GameState): HTMLElement {
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

  const typeButtons = h(
    'div',
    { class: 'segmented' },
    ...TOPIC_TYPES.map((candidate) =>
      h('button', {
        class: `segmented__btn segmented__btn--${candidate}${candidate === type ? ' is-active' : ''}`,
        type: 'button',
        text: `${TOPIC_META[candidate].icon} ${TOPIC_META[candidate].label}`,
        title: TOPIC_META[candidate].hint,
        onClick: () => {
          type = candidate;
          for (const node of typeButtons.querySelectorAll('.segmented__btn')) {
            node.classList.remove('is-active');
          }
          (typeButtons.querySelector(`.segmented__btn--${candidate}`) as HTMLElement)?.classList.add('is-active');
        },
      }),
    ),
  );

  const submit = async (): Promise<void> => {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return;
    }
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
  };

  const mine = state.you.topics;

  const submitPanel = panel(
    'Throw it on the pile',
    h('p', { class: 'field__hint', text: TOPIC_META[type].hint }),
    typeButtons,
    field('Short title', titleInput),
    field('Details (optional)', descriptionInput),
    scaleInput('Intensity', intensity, (value) => {
      intensity = value;
    }, 'How hard did this hit? Repeated or intense things become stronger enemies.'),
    h(
      'div',
      { class: 'row' },
      button('Add topic', () => void submit(), 'primary', mine.length >= LIMITS.maxTopicsPerPlayer),
      h('span', {
        class: 'field__hint',
        text: `${mine.length}/${LIMITS.maxTopicsPerPlayer} of yours · ${state.topicCount} in the room`,
      }),
    ),
  );

  const minePanel = panel(
    'Your topics',
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
                text: '✕',
                onClick: () => void act('topic:remove', { topicId: topic.id }),
              }),
            ),
          ),
        ),
    h('p', {
      class: 'field__hint',
      text: 'Only you see who wrote what. The dungeon is built from the pile, anonymously.',
    }),
  );

  const enough = state.topicCount >= LIMITS.minTopicsToGenerate;

  return h(
    'div',
    { class: 'stage stage--split' },
    h('div', { class: 'stage__col' }, submitPanel, minePanel),
    h(
      'div',
      { class: 'stage__col' },
      panel(
        'The party',
        party(state.players),
        h('p', {
          class: 'field__hint',
          text: `${state.topicCount} topic${state.topicCount === 1 ? '' : 's'} collected.`,
        }),
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
      ),
    ),
  );
}

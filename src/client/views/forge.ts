import type { GameState } from '../../shared/types.js';
import { h } from '../dom.js';
import { act } from '../store.js';
import { button, characterCard, emptyState, field, panel, party, scaleInput } from './ui.js';

interface Draft {
  energy: number;
  pressure: number;
  satisfaction: number;
  mood: string;
  keywords: string;
}

const draft: Draft = { energy: 3, pressure: 3, satisfaction: 3, mood: '', keywords: '' };
let seeded = false;

export function renderForge(state: GameState): HTMLElement {
  if (!seeded && state.you.checkIn) {
    draft.energy = state.you.checkIn.energy;
    draft.pressure = state.you.checkIn.pressure;
    draft.satisfaction = state.you.checkIn.satisfaction;
    draft.mood = state.you.checkIn.mood;
    draft.keywords = state.you.checkIn.keywords.join(', ');
    seeded = true;
  }

  const busy = state.generation.busy;

  const moodInput = h('textarea', {
    class: 'input input--area',
    rows: '3',
    maxlength: '280',
    placeholder: 'Shipped a lot, but every review took two days…',
    value: draft.mood,
    onInput: (event: Event) => {
      draft.mood = (event.target as HTMLTextAreaElement).value;
    },
  });

  const keywordInput = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '120',
    placeholder: 'coffee, hotfixes, rubber ducks',
    value: draft.keywords,
    onInput: (event: Event) => {
      draft.keywords = (event.target as HTMLInputElement).value;
    },
  });

  const forge = async (): Promise<void> => {
    const keywords = draft.keywords
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean)
      .slice(0, 5);
    const saved = await act('checkin:set', { ...draft, keywords });
    if (!saved.ok) return;
    await act('character:forge');
  };

  const formPanel = panel(
    'How were the last two weeks?',
    scaleInput('Energy', draft.energy, (value) => {
      draft.energy = value;
    }, '1 = running on fumes, 5 = fully charged'),
    scaleInput('Pressure', draft.pressure, (value) => {
      draft.pressure = value;
    }, '1 = calm, 5 = everything was urgent'),
    scaleInput('Satisfaction', draft.satisfaction, (value) => {
      draft.satisfaction = value;
    }, '1 = frustrating, 5 = proud of it'),
    field('In a few words', moodInput),
    field('Keywords (optional)', keywordInput, 'Comma separated, up to five.'),
    h(
      'div',
      { class: 'row' },
      button(
        state.you.character ? 'Re-forge my character' : 'Forge my character',
        () => void forge(),
        'primary',
        busy,
      ),
      busy ? h('span', { class: 'spinner', 'aria-label': 'forging' }) : null,
    ),
    state.generation.aiConfigured
      ? null
      : h('p', {
          class: 'notice',
          text: 'No AI key configured on the server — heroes are forged by the local generator.',
        }),
  );

  const heroPanel = panel(
    'Your hero',
    state.you.character
      ? characterCard(state.you.character)
      : emptyState('Fill in the check-in and forge your character.'),
  );

  const forged = state.players.filter((player) => player.character);

  return h(
    'div',
    { class: 'stage stage--split' },
    h('div', { class: 'stage__col' }, formPanel),
    h(
      'div',
      { class: 'stage__col' },
      heroPanel,
      panel(
        `The party (${forged.length}/${state.players.length} forged)`,
        party(state.players),
        state.you.isFacilitator
          ? h(
              'div',
              { class: 'row' },
              button('Everyone forged — open the topic board', () => void act('phase:topics')),
            )
          : h('p', { class: 'field__hint', text: 'The facilitator opens the topic board.' }),
      ),
    ),
  );
}

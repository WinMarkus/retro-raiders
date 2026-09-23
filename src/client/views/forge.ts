import type { GameState } from '../../shared/types.js';
import { h, patch, setDisabled } from '../dom.js';
import { act } from '../store.js';
import { button, characterCard, emptyState, field, panel, party, scaleInput, setBusy, type View } from './ui.js';

/**
 * The form is built once when the forge opens and never rebuilt while you are
 * in it: other players' pushes only touch the hero card, the party list and
 * button states. That is what keeps your text where you typed it.
 */
export function createForge(initial: GameState): View {
  const seed = initial.you.checkIn;
  const draft = {
    energy: seed?.energy ?? 3,
    pressure: seed?.pressure ?? 3,
    satisfaction: seed?.satisfaction ?? 3,
    mood: seed?.mood ?? '',
    keywords: seed?.keywords.join(', ') ?? '',
  };
  let withAvatarImage = false;
  let submitting = false;
  let current = initial;

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
    if (submitting || current.you.forging) return;
    submitting = true;
    update(current);
    try {
      const keywords = draft.keywords
        .split(',')
        .map((word) => word.trim())
        .filter(Boolean)
        .slice(0, 5);
      const saved = await act('checkin:set', { ...draft, keywords });
      if (!saved.ok) return;
      await act('character:forge', { withAvatarImage: withAvatarImage && Boolean(current.generation.imageModel) });
    } finally {
      submitting = false;
      update(current);
    }
  };

  const forgeButton = button('Forge my character', () => void forge(), 'primary');

  const avatarInput = h('input', {
    class: 'switch__input',
    type: 'checkbox',
    onChange: (event: Event) => {
      withAvatarImage = (event.target as HTMLInputElement).checked;
    },
  });
  const avatarToggle = h(
    'label',
    { class: 'switch' },
    avatarInput,
    h('span', { class: 'switch__track' }, h('span', { class: 'switch__thumb' })),
    h('span', { class: 'switch__label', text: 'Create image' }),
  );

  const modelSelect = h('select', {
    class: 'input',
    onChange: (event: Event) => {
      const model = (event.target as HTMLSelectElement).value;
      void act('ai:model:set', { model });
    },
  });
  const modelHint = h('span', { class: 'field__hint' });
  const modelField = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label', text: 'AI text model' }),
    modelSelect,
    modelHint,
  );
  const localNotice = h('p', {
    class: 'notice',
    text: 'No AI key configured on the server — heroes are forged by the local generator.',
  });

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
    h('div', { class: 'row' }, forgeButton, avatarToggle),
    modelField,
    localNotice,
  );

  const heroHost = h('div');
  const partyTitle = h('h2', { class: 'panel__title' });
  const partyHost = h('div');
  const partyActions = h('div');

  const root = h(
    'div',
    { class: 'stage stage--split' },
    h('div', { class: 'stage__col' }, formPanel),
    h(
      'div',
      { class: 'stage__col' },
      panel('Your hero', heroHost),
      h('section', { class: 'panel' }, partyTitle, partyHost, partyActions),
    ),
  );

  function update(state: GameState): void {
    current = state;
    const forging = state.you.forging || submitting;
    const gen = state.generation;

    setBusy(
      forgeButton,
      forging,
      'Forging…',
      state.you.character ? 'Re-forge my character' : 'Forge my character',
    );
    setDisabled(forgeButton, forging);

    avatarToggle.classList.toggle('switch--disabled', !gen.imageModel);
    avatarToggle.title = gen.imageModel
      ? 'Generate a real avatar image for this character. Slower and may cost a tiny amount.'
      : 'Set OPENROUTER_IMAGE_MODEL on the server to enable image avatars.';
    setDisabled(avatarInput, forging || !gen.imageModel);

    // style, not the hidden attribute: .field sets its own display.
    modelField.style.display = gen.aiConfigured ? '' : 'none';
    localNotice.style.display = gen.aiConfigured ? 'none' : '';
    // Never rebuild the dropdown while someone has it open.
    if (document.activeElement !== modelSelect) {
      patch(modelSelect, [gen.textModelOptions, gen.textModel], () =>
        gen.textModelOptions.map((option) =>
          h('option', { value: option.id, selected: option.id === gen.textModel, text: option.label }),
        ),
      );
      modelSelect.value = gen.textModel;
    }
    setDisabled(modelSelect, gen.busy || !state.you.isFacilitator);
    const avatarHint =
      gen.avatarImages === 'openrouter-image'
        ? `Image model available: ${gen.imageModel}. Toggle it on only when you want the slower portrait generation.`
        : 'Portraits use local CSS/emoji cards until OPENROUTER_IMAGE_MODEL is set.';
    modelHint.textContent = state.you.isFacilitator
      ? `Used for character and dungeon generation in this room. ${avatarHint}`
      : `Facilitator controls this. Current: ${gen.textModelLabel}. ${avatarHint}`;

    patch(heroHost, [state.you.character, forging], () =>
      state.you.character
        ? characterCard(state.you.character)
        : forging
          ? h('div', { class: 'summoning' }, h('span', { class: 'spinner spinner--lg' }))
          : emptyState('Fill in the check-in and forge your character.'),
    );

    const forged = state.players.filter((player) => player.character).length;
    partyTitle.textContent = `The party (${forged}/${state.players.length} forged)`;
    patch(partyHost, state.players, () => party(state.players));
    patch(partyActions, state.you.isFacilitator, () =>
      state.you.isFacilitator
        ? h(
            'div',
            { class: 'row' },
            button('Everyone forged — open the topic board', () => void act('phase:topics')),
          )
        : h('p', { class: 'field__hint', text: 'The facilitator opens the topic board.' }),
    );
  }

  update(initial);
  return { root, update };
}

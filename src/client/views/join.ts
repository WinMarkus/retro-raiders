import { LIMITS } from '../../shared/constants.js';
import { h } from '../dom.js';
import { join, render, saveSession, state, toast } from '../store.js';
import { button } from './ui.js';

function roomFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('room') ?? '';
  const fromPath = window.location.pathname.match(/^\/room\/([A-Za-z0-9]{1,8})$/)?.[1] ?? '';
  return (fromQuery || fromPath).toUpperCase();
}

let nameValue = '';
let codeValue = roomFromUrl();
let busy = false;

export function renderJoin(): HTMLElement {
  const nameInput = h('input', {
    class: 'input',
    id: 'join-name',
    'data-key': 'join-name',
    type: 'text',
    value: nameValue,
    maxlength: LIMITS.playerName,
    placeholder: 'Your name in the party',
    autocomplete: 'nickname',
    onInput: (event: Event) => {
      nameValue = (event.target as HTMLInputElement).value;
    },
  });

  const codeInput = h('input', {
    class: 'input input--code',
    id: 'join-code',
    'data-key': 'join-code',
    type: 'text',
    value: codeValue,
    maxlength: LIMITS.roomCode,
    placeholder: 'ABC123',
    autocapitalize: 'characters',
    spellcheck: 'false',
    onInput: (event: Event) => {
      const target = event.target as HTMLInputElement;
      target.value = target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      codeValue = target.value;
    },
  });

  const submit = async (mode: 'create' | 'join'): Promise<void> => {
    if (busy) return;
    const name = nameValue.trim();
    if (!name) {
      state.joinError = 'Enter a player name first — nobody enters the dungeon nameless.';
      render();
      nameInput.focus();
      return;
    }
    if (mode === 'join' && codeValue.trim().length !== LIMITS.roomCode) {
      state.joinError = `Room codes are ${LIMITS.roomCode} characters, like GH7K2M.`;
      render();
      return;
    }
    busy = true;
    state.joinError = null;
    render();
    const result = await join(mode === 'create' ? 'room:create' : 'room:join', {
      name,
      code: codeValue.trim(),
    });
    busy = false;
    if (!result?.ok || !result.code || !result.playerId) {
      state.joinError = result?.error ?? 'The dungeon did not answer. Try again.';
      render();
      return;
    }
    saveSession({ code: result.code, playerId: result.playerId, name });
    state.joinError = null;
    state.screen = 'game';
    window.history.replaceState({}, '', `/room/${result.code}`);
    toast(mode === 'create' ? `Room ${result.code} carved out of the rock.` : `Welcome to room ${result.code}.`, 'success');
    render();
  };

  const form = h(
    'form',
    {
      class: 'join__form',
      onSubmit: (event: Event) => {
        event.preventDefault();
        void submit(codeValue.trim().length === LIMITS.roomCode ? 'join' : 'create');
      },
    },
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: 'join-name', text: 'Player name' }),
      nameInput,
      h('p', { class: 'field__hint', text: 'Shown to the party. Card texts stay anonymous either way.' }),
    ),
    h(
      'div',
      { class: 'join__actions' },
      button(busy ? 'Opening…' : 'Create a new dungeon', {
        class: 'btn--primary btn--wide',
        disabled: busy,
        onClick: () => void submit('create'),
      }),
    ),
    h('div', { class: 'join__divider' }, h('span', { text: 'or join an existing raid' })),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: 'join-code', text: 'Room code' }),
      h(
        'div',
        { class: 'join__row' },
        codeInput,
        button(busy ? 'Knocking…' : 'Join room', {
          class: 'btn--ghost',
          disabled: busy,
          onClick: () => void submit('join'),
        }),
      ),
    ),
    state.joinError ? h('p', { class: 'form-error', role: 'alert', text: state.joinError }) : null,
  );

  return h(
    'div',
    { class: 'join' },
    h(
      'div',
      { class: 'join__hero' },
      h('p', { class: 'join__kicker', text: 'A co-op retrospective for 6–8 raiders' }),
      h('h1', { class: 'join__title' }, 'Retro Raiders', h('span', { class: 'join__title-sub', text: 'The Blocker Dungeon' })),
      h('p', {
        class: 'join__lede',
        text: 'Pack your sprint into a dungeon: loot you found, traps you fell into, monsters that keep coming back. Then fight the one that hurt most and forge a weapon against it.',
      }),
      h(
        'ul',
        { class: 'join__facts' },
        h('li', { text: '7 phases, roughly 45 minutes' }),
        h('li', { text: 'Cards stay anonymous, always' }),
        h('li', { text: 'First player in the room facilitates' }),
      ),
    ),
    h('div', { class: 'join__card' }, form),
  );
}

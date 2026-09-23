import { h, patch } from '../dom.js';
import { createRoom, joinRoom, store } from '../store.js';
import { button, field } from './ui.js';

function codeFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('room');
  if (fromQuery) return fromQuery.toUpperCase();
  const match = window.location.pathname.match(/^\/room\/([A-Za-z0-9]{1,8})$/);
  return match ? match[1]!.toUpperCase() : '';
}

/** Built once; reconnect events must not wipe a half-typed name. */
export function createJoin(): { root: HTMLElement; update: () => void } {
  let name = '';
  let code = codeFromUrl();
  let joining = false;

  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '24',
    placeholder: 'Your name',
    autocomplete: 'nickname',
    autofocus: true,
    onInput: (event: Event) => {
      name = (event.target as HTMLInputElement).value;
    },
  });

  const codeInput = h('input', {
    class: 'input input--code',
    type: 'text',
    maxlength: '6',
    placeholder: 'ROOM',
    value: code,
    onInput: (event: Event) => {
      const element = event.target as HTMLInputElement;
      element.value = element.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      code = element.value;
      update();
    },
  });

  const submitJoin = (): void => {
    if (!name.trim()) {
      store.joinError = 'Enter a player name first.';
      update();
      nameInput.focus();
      return;
    }
    if (joining) return;
    joining = true;
    submitButton.disabled = true;
    const attempt = code.trim() ? joinRoom(name, code) : createRoom(name);
    void attempt.finally(() => {
      joining = false;
      submitButton.disabled = false;
      update();
    });
  };

  const submitButton = button('Create a dungeon', submitJoin);
  const errorHost = h('div');
  const form = h(
    'div',
    { class: 'join__form' },
    field('Player name', nameInput),
    field('Room code', codeInput, 'Leave empty to open a new dungeon.'),
    h('div', { class: 'join__actions' }, submitButton),
    errorHost,
  );

  function update(): void {
    submitButton.textContent = code ? 'Enter the dungeon' : 'Create a dungeon';
    patch(errorHost, store.joinError, () =>
      store.joinError ? h('p', { class: 'notice notice--error', role: 'alert', text: store.joinError }) : null,
    );
  }

  form.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') submitJoin();
  });

  const root = h(
    'section',
    { class: 'join' },
    h('h1', { class: 'join__title', text: 'Retro Raiders' }),
    h('p', { class: 'join__tagline', text: 'Your last two weeks, turned into a dungeon.' }),
    form,
    h(
      'ol',
      { class: 'join__steps' },
      h('li', { text: 'Forge a character from how the sprint actually felt.' }),
      h('li', { text: 'Throw in what was good, bad and draining.' }),
      h('li', { text: 'Fight what comes out of it, together.' }),
    ),
  );
  update();
  return { root, update };
}

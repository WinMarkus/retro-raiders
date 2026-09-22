import type { GameState } from '../../shared/types.js';
import { h } from '../dom.js';
import { act, toast } from '../store.js';
import { button, emptyState, panel, party } from './ui.js';

function inviteUrl(code: string): string {
  return `${window.location.origin}/room/${code}`;
}

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied.`, 'success');
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    toast(ok ? `${label} copied.` : `Copy failed — select it by hand: ${text}`, ok ? 'success' : 'error');
  }
}

export function renderLobby(game: GameState): HTMLElement {
  const url = inviteUrl(game.code);

  const invite = panel(
    'Gather the party',
    'Anyone with the code can walk in. No accounts, no installs.',
    h(
      'div',
      { class: 'code-block' },
      h('span', { class: 'code-block__label', text: 'Room code' }),
      h('strong', { class: 'code-block__code', text: game.code }),
      button('Copy code', { class: 'btn--ghost btn--small', onClick: () => void copy(game.code, 'Room code') }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: 'invite-url', text: 'Invitation link' }),
      h(
        'div',
        { class: 'join__row' },
        h('input', {
          class: 'input',
          id: 'invite-url',
          'data-key': 'invite-url',
          type: 'text',
          value: url,
          readonly: true,
          onFocus: (event: Event) => (event.target as HTMLInputElement).select(),
        }),
        button('Copy link', { class: 'btn--ghost', onClick: () => void copy(url, 'Invitation link') }),
      ),
    ),
  );

  const rules = panel(
    'How the raid runs',
    'Seven phases. The facilitator moves the party forward.',
    h(
      'ol',
      { class: 'rules' },
      h('li', { text: 'Choose an adventurer and say how much energy you brought.' }),
      h('li', { text: 'Pack the dungeon: up to two loot, two traps and two monsters each, in private.' }),
      h('li', { text: 'Reveal the dungeon: everything is shuffled and anonymous.' }),
      h('li', { text: 'Explore: three energy tokens each, spent on the rooms that mattered.' }),
      h('li', { text: 'Final boss: one anonymous vote for the thing worth fighting.' }),
      h('li', { text: 'Forge the weapons: one small experiment each, then spend forge points.' }),
      h('li', { text: 'Victory screen: the summary you can take into next sprint.' }),
    ),
  );

  const partyPanel = panel(
    `In the torchlight (${game.players.length})`,
    'The first raider in the room holds the torch and facilitates.',
    game.players.length > 0
      ? party(game.players)
      : emptyState('Nobody here yet.', 'Send the link above and the party will appear.'),
    game.you.isFacilitator
      ? h(
          'div',
          { class: 'actions' },
          button('Start the raid', {
            class: 'btn--primary',
            onClick: () => void act('game:start'),
          }),
          h('p', {
            class: 'field__hint',
            text: 'You can walk the party back a phase at any time from the bar at the bottom.',
          }),
        )
      : h('p', { class: 'field__hint', text: 'Waiting for the facilitator to open the gate.' }),
  );

  return h('div', { class: 'grid grid--two' }, invite, partyPanel, rules);
}

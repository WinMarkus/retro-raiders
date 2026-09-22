import { h } from '../dom.js';
import type { Character, PublicPlayer } from '../../shared/types.js';

export function panel(title: string | null, ...children: Array<Node | string | false | null>): HTMLElement {
  return h(
    'section',
    { class: 'panel' },
    title ? h('h2', { class: 'panel__title', text: title }) : null,
    ...children,
  );
}

export function button(
  label: string,
  onClick: () => void,
  variant: 'primary' | 'ghost' | 'danger' = 'primary',
  disabled = false,
): HTMLButtonElement {
  return h('button', {
    class: `btn btn--${variant}`,
    type: 'button',
    text: label,
    disabled,
    onClick,
  });
}

export function emptyState(text: string): HTMLElement {
  return h('p', { class: 'empty', text });
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label', text: label }),
    control,
    hint ? h('span', { class: 'field__hint', text: hint }) : null,
  );
}

export function scaleInput(
  label: string,
  value: number,
  onInput: (value: number) => void,
  hint?: string,
): HTMLElement {
  const output = h('output', { class: 'scale__value', text: String(value) });
  const input = h('input', {
    class: 'scale__input',
    type: 'range',
    min: '1',
    max: '5',
    step: '1',
    value: String(value),
    onInput: (event: Event) => {
      const next = Number.parseInt((event.target as HTMLInputElement).value, 10);
      output.textContent = String(next);
      onInput(next);
    },
  });
  return h(
    'div',
    { class: 'scale' },
    h('span', { class: 'field__label', text: label }),
    h('div', { class: 'scale__row' }, input, output),
    hint ? h('span', { class: 'field__hint', text: hint }) : null,
  );
}

export function avatarBadge(character: Character | null, name: string, size: 'sm' | 'lg' = 'sm'): HTMLElement {
  const hue = character?.hue ?? 210;
  return h(
    'span',
    {
      class: `avatar avatar--${size}`,
      style: `--avatar-hue:${hue}`,
      title: character ? `${character.characterName} — ${character.className}` : name,
    },
    character?.avatarImage
      ? h('img', {
          class: 'avatar__image',
          src: character.avatarImage.dataUrl,
          alt: character.characterName,
          loading: 'lazy',
        })
      : h('span', { class: 'avatar__emoji', text: character?.emoji ?? '🎲' }),
  );
}

export function characterCard(character: Character): HTMLElement {
  return h(
    'article',
    { class: 'hero-card', style: `--avatar-hue:${character.hue}` },
    h(
      'header',
      { class: 'hero-card__head' },
      avatarBadge(character, character.playerName, 'lg'),
      h(
        'div',
        {},
        h('h3', { class: 'hero-card__name', text: character.characterName }),
        h('p', { class: 'hero-card__class', text: character.className }),
        h('p', { class: 'hero-card__player', text: `played by ${character.playerName}` }),
      ),
    ),
    h('p', { class: 'hero-card__text', text: character.description }),
    h(
      'dl',
      { class: 'hero-card__stats' },
      h('dt', { text: 'Skill' }),
      h('dd', { text: character.skill }),
      h('dt', { text: 'Weakness' }),
      h('dd', { text: character.weakness }),
      h('dt', { text: 'Attack' }),
      h('dd', { text: '⚔️'.repeat(character.attack) }),
      h('dt', { text: 'Support' }),
      h('dd', { text: '✚'.repeat(character.support) }),
    ),
  );
}

export function playerChip(player: PublicPlayer): HTMLElement {
  return h(
    'li',
    { class: `chip${player.connected ? '' : ' chip--away'}${player.ready ? ' chip--ready' : ''}` },
    avatarBadge(player.character, player.name),
    h('span', { class: 'chip__name', text: player.name }),
    player.isFacilitator ? h('span', { class: 'chip__tag', text: 'facilitator' }) : null,
    player.connected ? null : h('span', { class: 'chip__tag', text: 'away' }),
  );
}

export function party(players: PublicPlayer[]): HTMLElement {
  return h('ul', { class: 'party' }, ...players.map(playerChip));
}

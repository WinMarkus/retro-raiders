import { ADVENTURER_CLASSES, CATEGORY_META } from '../../shared/constants.js';
import type { Category, PublicPlayer } from '../../shared/types.js';
import { h, type Props } from '../dom.js';

export function panel(title: string, subtitle: string | null, ...children: (Node | null | false)[]): HTMLElement {
  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel__head' },
      h('h2', { class: 'panel__title', text: title }),
      subtitle ? h('p', { class: 'panel__subtitle', text: subtitle }) : null,
    ),
    h('div', { class: 'panel__body' }, ...children.filter(Boolean).map((child) => child as Node)),
  );
}

export function button(label: string, props: Props = {}): HTMLButtonElement {
  const { class: className, ...rest } = props;
  return h('button', { type: 'button', class: `btn ${className ?? ''}`.trim(), ...rest }, label);
}

export function emptyState(message: string, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('p', { class: 'empty__message', text: message }),
    hint ? h('p', { class: 'empty__hint', text: hint }) : null,
  );
}

export function classInfo(classId: string | null): { emoji: string; name: string } {
  const found = ADVENTURER_CLASSES.find((item) => item.id === classId);
  return found ? { emoji: found.emoji, name: found.name } : { emoji: '🎲', name: 'Unassigned' };
}

export function playerChip(player: PublicPlayer, options: { showReady?: boolean } = {}): HTMLElement {
  const info = classInfo(player.classId);
  return h(
    'li',
    {
      class: `raider ${player.connected ? '' : 'raider--away'} ${
        options.showReady && player.ready ? 'raider--ready' : ''
      }`.trim(),
    },
    h('span', { class: 'raider__avatar', 'aria-hidden': 'true', text: info.emoji }),
    h(
      'span',
      { class: 'raider__meta' },
      h('span', { class: 'raider__name', text: player.name }),
      h(
        'span',
        { class: 'raider__tags' },
        player.isFacilitator ? h('span', { class: 'tag tag--gold', text: 'Facilitator' }) : null,
        player.classId ? h('span', { class: 'tag', text: info.name }) : null,
        !player.connected ? h('span', { class: 'tag tag--away', text: 'Reconnecting' }) : null,
        options.showReady && player.ready ? h('span', { class: 'tag tag--ready', text: 'Ready' }) : null,
      ),
    ),
  );
}

export function party(players: PublicPlayer[], options: { showReady?: boolean } = {}): HTMLElement {
  return h('ul', { class: 'party' }, ...players.map((player) => playerChip(player, options)));
}

export function categoryBadge(category: Category): HTMLElement {
  const meta = CATEGORY_META[category];
  return h(
    'span',
    { class: `badge badge--${category}` },
    h('span', { 'aria-hidden': 'true', text: meta.emoji }),
    h('span', { text: meta.room }),
  );
}

export function tokenPips(count: number, max = 3): HTMLElement {
  const wrapper = h('span', { class: 'pips', 'aria-hidden': 'true' });
  for (let i = 0; i < max; i += 1) {
    wrapper.appendChild(h('span', { class: `pip ${i < count ? 'pip--lit' : ''}`.trim() }));
  }
  return wrapper;
}

export function progressNote(done: number, total: number, noun: string): HTMLElement {
  return h('p', { class: 'progress-note', text: `${done} of ${total} ${noun}` });
}

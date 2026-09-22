import { CATEGORY_META } from '../../shared/constants.js';
import type { GameState } from '../../shared/types.js';
import { h } from '../dom.js';
import { act } from '../store.js';
import { button, categoryBadge, emptyState, panel } from './ui.js';

export function renderBoss(game: GameState): HTMLElement {
  const shortlist = game.boss.shortlist
    .map((id) => game.cards.find((card) => card.id === id))
    .filter((card): card is NonNullable<typeof card> => Boolean(card));

  if (shortlist.length === 0) {
    return panel(
      'No boss in sight',
      'The shortlist comes from the traps and monsters with the most tokens.',
      emptyState('Nothing qualified.', 'Step back and spend some tokens on traps or monsters.'),
    );
  }

  if (game.boss.revealed && game.boss.winnerCardId) {
    const winner = game.cards.find((card) => card.id === game.boss.winnerCardId);
    return h(
      'div',
      { class: 'grid grid--wide' },
      panel(
        'The final boss',
        `Chosen by the party in round ${game.boss.round}.`,
        h(
          'div',
          { class: 'boss' },
          h('div', { class: 'boss__sigil', 'aria-hidden': 'true', text: winner?.category === 'trap' ? '🕳️' : '🐉' }),
          h('h3', { class: 'boss__title', text: game.boss.title ?? 'The Unnamed' }),
          h(
            'ul',
            { class: 'boss__texts' },
            ...(winner?.texts ?? []).map((text) => h('li', { class: 'boss__text', text })),
          ),
          h('p', {
            class: 'boss__meta',
            text: winner ? `${CATEGORY_META[winner.category].room} · ${winner.tokens ?? 0} tokens from the party` : '',
          }),
        ),
        game.you.isFacilitator
          ? h('p', { class: 'field__hint', text: 'Move to the forge when the party is done gasping.' })
          : null,
      ),
    );
  }

  const votes = game.boss.votedPlayerIds.length;

  return h(
    'div',
    { class: 'grid grid--wide' },
    panel(
      game.boss.runoff ? `Runoff vote, round ${game.boss.round}` : 'Choose the final boss',
      game.boss.runoff
        ? 'The last vote tied. Only the leaders remain.'
        : 'One vote each, anonymous. Nobody sees who voted for what — only how many votes are in.',
      h(
        'div',
        { class: 'ballot' },
        ...shortlist.map((card) =>
          h(
            'button',
            {
              type: 'button',
              class: `ballot__option ballot__option--${card.category} ${
                game.boss.myVote === card.id ? 'ballot__option--picked' : ''
              }`.trim(),
              'aria-pressed': game.boss.myVote === card.id ? 'true' : 'false',
              onClick: () => void act('boss:vote', { cardId: card.id }),
            },
            categoryBadge(card.category),
            h('ul', { class: 'room__texts' }, ...card.texts.map((text) => h('li', { class: 'room__text', text }))),
            h('span', { class: 'ballot__tokens', text: `${card.tokens ?? 0} tokens` }),
          ),
        ),
      ),
      h('p', {
        class: 'field__hint',
        text: `${votes} of ${game.players.length} votes cast.${game.boss.myVote ? ' You can change yours until the vote closes.' : ''}`,
      }),
      game.you.isFacilitator
        ? button('Close the vote now', { class: 'btn--primary btn--small', onClick: () => void act('boss:resolve') })
        : null,
    ),
  );
}

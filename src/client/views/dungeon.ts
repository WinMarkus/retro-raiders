import { CATEGORIES, CATEGORY_META, LIMITS } from '../../shared/constants.js';
import type { Category, GameState, PublicCard } from '../../shared/types.js';
import { h } from '../dom.js';
import { act, render, toast } from '../store.js';
import { button, categoryBadge, emptyState, panel, party, tokenPips } from './ui.js';

const mergeSelection = new Set<string>();

export const TOKEN_MEANING: Record<number, string> = {
  1: 'This affected us',
  2: 'We should discuss this',
  3: 'This may be our boss',
};

function cardTexts(card: PublicCard): HTMLElement {
  return h(
    'ul',
    { class: 'room__texts' },
    ...card.texts.map((text) => h('li', { class: 'room__text', text })),
  );
}

function roomTile(card: PublicCard, body: Node | null, options: { selectable?: boolean } = {}): HTMLElement {
  const selected = mergeSelection.has(card.id);
  return h(
    'article',
    {
      class: `room room--${card.category} ${selected ? 'room--selected' : ''}`.trim(),
      'data-card': card.id,
    },
    h(
      'header',
      { class: 'room__head' },
      categoryBadge(card.category),
      card.merged ? h('span', { class: 'tag tag--merged', text: `Merged ×${card.texts.length}` }) : null,
      card.tokens !== null
        ? h('span', { class: 'room__tokens', text: `${card.tokens} ${card.tokens === 1 ? 'token' : 'tokens'}` })
        : null,
    ),
    cardTexts(card),
    options.selectable
      ? h(
          'label',
          { class: 'room__merge' },
          h('input', {
            type: 'checkbox',
            checked: selected,
            'aria-label': `Select this ${CATEGORY_META[card.category].room.toLowerCase()} for merging`,
            onChange: (event: Event) => {
              const checked = (event.target as HTMLInputElement).checked;
              if (checked) mergeSelection.add(card.id);
              else mergeSelection.delete(card.id);
              render();
            },
          }),
          h('span', { text: 'Select for merge' }),
        )
      : null,
    body,
  );
}

function tokenControls(game: GameState, card: PublicCard): HTMLElement {
  const locked = game.myReady;
  return h(
    'div',
    { class: 'tokens', role: 'group', 'aria-label': `Energy tokens for this room` },
    ...[0, 1, 2, 3].map((amount) =>
      h(
        'button',
        {
          type: 'button',
          class: `token-btn ${card.myTokens === amount ? 'token-btn--on' : ''}`.trim(),
          'aria-pressed': card.myTokens === amount ? 'true' : 'false',
          disabled: locked,
          title: amount === 0 ? 'No tokens here' : TOKEN_MEANING[amount],
          onClick: () => void act('tokens:set', { cardId: card.id, amount }),
        },
        amount === 0 ? '—' : '●'.repeat(amount),
      ),
    ),
    h('span', { class: 'tokens__meaning', text: card.myTokens > 0 ? TOKEN_MEANING[card.myTokens] ?? '' : '' }),
  );
}

function mapSection(
  game: GameState,
  category: Category,
  renderBody: (card: PublicCard) => Node | null,
  selectable: boolean,
): HTMLElement {
  const meta = CATEGORY_META[category];
  const cards = game.cards.filter((card) => card.category === category);
  return h(
    'section',
    { class: `map-section map-section--${category}` },
    h(
      'header',
      { class: 'map-section__head' },
      h('span', { class: 'map-section__emoji', 'aria-hidden': 'true', text: meta.emoji }),
      h('h3', { class: 'map-section__title', text: `${meta.room}s` }),
      h('span', { class: 'map-section__count', text: String(cards.length) }),
    ),
    cards.length
      ? h('div', { class: 'map-section__rooms' }, ...cards.map((card) => roomTile(card, renderBody(card), { selectable })))
      : emptyState(`No ${meta.plural.toLowerCase()} in this dungeon.`, 'Nobody packed one — or the facilitator can reopen the packing phase.'),
  );
}

export function renderReveal(game: GameState): HTMLElement {
  const selectable = game.you.isFacilitator;
  const selected = [...mergeSelection].filter((id) => game.cards.some((card) => card.id === id));

  const mergeBar = selectable
    ? h(
        'div',
        { class: 'merge-bar' },
        h('p', {
          class: 'merge-bar__text',
          text:
            selected.length > 0
              ? `${selected.length} room${selected.length === 1 ? '' : 's'} selected. Merging keeps every original sentence.`
              : 'Tick two or more rooms of the same kind to merge obvious duplicates.',
        }),
        button('Merge selected', {
          class: 'btn--primary btn--small',
          disabled: selected.length < 2,
          onClick: async () => {
            const result = await act('cards:merge', { cardIds: selected });
            if (result.ok) {
              mergeSelection.clear();
              toast('Rooms merged.', 'success');
            }
          },
        }),
        button('Clear selection', {
          class: 'btn--ghost btn--small',
          disabled: selected.length === 0,
          onClick: () => {
            mergeSelection.clear();
            render();
          },
        }),
      )
    : null;

  return h(
    'div',
    { class: 'grid grid--wide' },
    panel(
      'The dungeon is open',
      `${game.cards.length} rooms, shuffled and anonymous. No card shows who wrote it — not here, not in the export.`,
      mergeBar,
      h('div', { class: 'map' }, ...CATEGORIES.map((category) => mapSection(game, category, () => null, selectable))),
    ),
  );
}

export function renderExplore(game: GameState): HTMLElement {
  const remaining = game.tokens.myRemaining;

  const legend = h(
    'ul',
    { class: 'legend' },
    ...[1, 2, 3].map((amount) =>
      h('li', { class: 'legend__item' }, tokenPips(amount), h('span', { text: TOKEN_MEANING[amount] ?? '' })),
    ),
  );

  const spend = h(
    'div',
    { class: 'spend-bar' },
    h(
      'div',
      { class: 'spend-bar__count' },
      tokenPips(remaining),
      h('span', {
        class: 'spend-bar__label',
        text: remaining > 0 ? `${remaining} of ${game.tokens.perPlayer} tokens left` : 'All tokens placed',
      }),
    ),
    button(game.myReady ? 'Take my tokens back' : 'Ready', {
      class: game.myReady ? 'btn--ghost btn--small' : 'btn--primary btn--small',
      onClick: () => void act('ready:set', { ready: !game.myReady }),
    }),
  );

  const waiting = h('p', {
    class: 'field__hint',
    text: game.tokens.revealed
      ? 'Totals are visible to everyone.'
      : `Totals stay hidden until all raiders are ready (${game.readyPlayerIds.length}/${game.players.length}) or the facilitator reveals them.`,
  });

  return h(
    'div',
    { class: 'grid grid--wide' },
    panel(
      'Explore the dungeon',
      'Three energy tokens each. Spend them where it actually hurt or helped.',
      legend,
      spend,
      waiting,
      game.you.isFacilitator && !game.tokens.revealed
        ? button('Reveal the totals', { class: 'btn--ghost btn--small', onClick: () => void act('tokens:reveal') })
        : null,
      game.cards.length
        ? h(
            'div',
            { class: 'map' },
            ...CATEGORIES.map((category) => mapSection(game, category, (card) => tokenControls(game, card), false)),
          )
        : emptyState('This dungeon is empty.', 'Step back to the packing phase and write a few cards.'),
    ),
    panel(
      `Tokens placed (${game.readyPlayerIds.length}/${game.players.length} ready)`,
      'Who has spent what, not on which room.',
      h(
        'ul',
        { class: 'spend-list' },
        ...game.players.map((player) =>
          h(
            'li',
            { class: 'spend-list__row' },
            h('span', { class: 'spend-list__name', text: player.name }),
            tokenPips(game.tokens.spentByPlayer[player.id] ?? 0, LIMITS.tokensPerPlayer),
          ),
        ),
      ),
      party(game.players, { showReady: true }),
    ),
  );
}

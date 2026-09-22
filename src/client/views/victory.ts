import type { GameState } from '../../shared/types.js';
import { h, prefersReducedMotion } from '../dom.js';
import { act, downloadSnapshot, saveToGithub, toast } from '../store.js';
import { button, characterCard, emptyState, panel } from './ui.js';

let saving = false;

export function renderVictory(state: GameState): HTMLElement {
  const summary = state.summary;
  if (!summary) return panel('Victory', emptyState('No summary yet.'));

  const confetti = prefersReducedMotion()
    ? null
    : h(
        'div',
        { class: 'confetti', 'aria-hidden': 'true' },
        ...Array.from({ length: 40 }, (_, index) =>
          h('i', { style: `--i:${index}; --hue:${(index * 37) % 360}` }),
        ),
      );

  const heroes = state.players
    .map((player) => player.character)
    .filter((character): character is NonNullable<typeof character> => Boolean(character));

  return h(
    'div',
    { class: 'stage stage--victory' },
    confetti,
    h(
      'header',
      { class: 'victory__head' },
      h('h2', { class: 'victory__title', text: 'Victory Report' }),
      h('p', { class: 'victory__headline', text: summary.headline }),
      h(
        'ul',
        { class: 'victory__stats' },
        ...summary.stats.map((stat) =>
          h('li', {}, h('span', { text: stat.title }), h('strong', { text: stat.value })),
        ),
      ),
    ),
    panel(
      'Action items',
      summary.actionItems.length === 0
        ? emptyState('Nothing was pinned down — worth a short follow-up.')
        : h('ol', { class: 'action-list' }, ...summary.actionItems.map((item) => h('li', { text: item }))),
    ),
    panel(
      'Frozen enemies',
      summary.resolved.length === 0
        ? emptyState('No enemy was resolved in this run.')
        : h(
            'ul',
            { class: 'result-list' },
            ...summary.resolved.map((resolution) =>
              h(
                'li',
                { class: 'result' },
                h('h3', { class: 'result__title', text: `❄ ${resolution.enemyName}` }),
                resolution.story ? h('p', { class: 'result__story', text: resolution.story }) : null,
                h('p', { class: 'result__text', text: resolution.treatment }),
                h('p', {
                  class: 'result__meta',
                  text: `${resolution.owner ?? 'unowned'} · review ${resolution.reviewBy} · ${
                    resolution.attackSpent
                  } attack · ${resolution.party.join(', ')}`,
                }),
              ),
            ),
          ),
    ),
    summary.unresolved.length > 0
      ? panel(
          'Still standing',
          h(
            'ul',
            { class: 'result-list' },
            ...summary.unresolved.map((enemy) =>
              h(
                'li',
                { class: 'result result--open' },
                h('h3', { class: 'result__title', text: enemy.name }),
                h('p', { class: 'result__text', text: enemy.description }),
                h('p', { class: 'result__meta', text: enemy.sourceTopics.join(' · ') }),
              ),
            ),
          ),
        )
      : null,
    panel('The party', h('div', { class: 'hero-grid' }, ...heroes.map(characterCard))),
    state.canSave ? savePanel(state) : null,
    state.you.isFacilitator
      ? h('div', { class: 'row' }, button('Back to the dungeon', () => void act('phase:back'), 'ghost'))
      : null,
  );
}

function savePanel(state: GameState): HTMLElement {
  const save = async (): Promise<void> => {
    if (saving) return;
    saving = true;
    const result = await saveToGithub();
    saving = false;
    toast(result.ok ? 'Saved to GitHub.' : result.error);
  };

  return panel(
    'Save this retro',
    state.githubConfigured
      ? h('p', { class: 'field__hint', text: 'Commits the session JSON to the configured repository.' })
      : h('p', {
          class: 'notice',
          text: 'GitHub is not configured on the server, so only the download is available.',
        }),
    h(
      'div',
      { class: 'row' },
      state.githubConfigured
        ? button(
            state.save.status === 'saving' ? 'Saving…' : 'Save retro to GitHub',
            () => void save(),
            'primary',
            state.save.status === 'saving' || state.save.status === 'saved',
          )
        : null,
      button('Download JSON', () => void downloadSnapshot(), 'ghost'),
    ),
    state.save.status === 'saved' && state.save.url
      ? h(
          'p',
          { class: 'notice notice--ok' },
          h('a', { class: 'link', href: state.save.url, target: '_blank', rel: 'noreferrer', text: 'View the saved file on GitHub' }),
        )
      : null,
    state.save.status === 'error' && state.save.message
      ? h('p', { class: 'notice notice--error', text: state.save.message })
      : null,
  );
}

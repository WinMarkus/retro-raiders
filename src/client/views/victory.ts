import type { GameState } from '../../shared/types.js';
import { h, patch, prefersReducedMotion } from '../dom.js';
import { act, downloadSnapshot, saveToGithub, toast } from '../store.js';
import { button, characterCard, emptyState, panel, type View } from './ui.js';

let saving = false;

export function createVictory(initial: GameState): View {
  const root = h('div');
  // Lives outside the patched report, so the painting arriving never restarts
  // the confetti and a report update never reloads the image.
  const artHost = h('section', { class: 'battle-art', 'aria-label': 'The battle, painted' });
  const update = (state: GameState): void => {
    patch(
      root,
      [state.summary, state.players.map((player) => player.character), state.canSave, state.save, state.githubConfigured, state.you.isFacilitator],
      () => renderVictory(state, artHost),
    );
    patch(artHost, [state.battleArt, state.you.isFacilitator], () => renderArt(state));
    artHost.hidden = state.battleArt.status === 'unavailable' && !state.you.isFacilitator;
  };
  update(initial);
  return { root, update };
}

function renderArt(state: GameState): Array<Node | null> {
  const art = state.battleArt;
  const repaint = state.you.isFacilitator
    ? button(art.url ? 'Repaint the battle' : 'Paint the battle', () => void act('art:paint'), 'ghost', art.status === 'painting')
    : null;

  if (art.status === 'unavailable') {
    return [
      h('p', {
        class: 'notice',
        text: 'Set OPENROUTER_IMAGE_MODEL on the server and the party gets an epic painting of this battle here.',
      }),
    ];
  }

  const frame = h('figure', { class: `battle-art__frame battle-art__frame--${art.status}` });
  if (art.url) {
    const image = h('img', {
      class: 'battle-art__image',
      src: art.url,
      alt: 'The party fighting the monsters of this dungeon, painted in epic fantasy style.',
      decoding: 'async',
    });
    image.addEventListener('load', () => frame.classList.add('is-loaded'));
    frame.appendChild(image);
  }
  if (art.status === 'painting' || !art.url) {
    frame.appendChild(
      h(
        'div',
        { class: 'battle-art__placeholder' },
        art.status === 'painting' ? h('span', { class: 'spinner spinner--lg' }) : null,
        h('p', {
          class: 'battle-art__caption',
          text:
            art.status === 'painting'
              ? 'The court painters are capturing the battle… (this takes about a minute)'
              : art.status === 'error'
                ? `The painting failed: ${art.message ?? 'unknown error'}`
                : 'No painting yet.',
        }),
      ),
    );
  }

  return [
    frame,
    h(
      'div',
      { class: 'row battle-art__actions' },
      art.url
        ? h('a', {
            class: 'btn btn--primary',
            href: `${art.url}?download=1`,
            download: '',
            text: 'Download the painting',
          })
        : null,
      repaint,
      art.url && art.status !== 'painting'
        ? h('span', { class: 'field__hint', text: 'Take it into the next sprint. Post it in the channel.' })
        : null,
    ),
  ];
}

function renderVictory(state: GameState, artHost: HTMLElement): HTMLElement {
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
    artHost,
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
                resolution.alternatives && resolution.alternatives.length > 0
                  ? h(
                      'details',
                      { class: 'result__alts' },
                      h('summary', { text: `Also on the table (${resolution.alternatives.length})` }),
                      h('ul', {}, ...resolution.alternatives.map((idea) => h('li', { text: idea }))),
                    )
                  : null,
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

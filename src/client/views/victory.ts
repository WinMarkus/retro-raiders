import { CATEGORY_META } from '../../shared/constants.js';
import type { GameState, SummaryCard } from '../../shared/types.js';
import { h, prefersReducedMotion } from '../dom.js';
import { downloadSnapshot, render, saveToGithub, state, toast } from '../store.js';
import { button, emptyState, panel } from './ui.js';

function cardList(cards: SummaryCard[], emptyMessage: string): HTMLElement {
  if (cards.length === 0) return emptyState(emptyMessage);
  return h(
    'ul',
    { class: 'summary-list' },
    ...cards.map((card) =>
      h(
        'li',
        { class: `summary-list__item summary-list__item--${card.category}` },
        h(
          'div',
          { class: 'summary-list__texts' },
          ...card.texts.map((text) => h('p', { class: 'summary-list__text', text })),
        ),
        h('span', { class: 'summary-list__tokens', text: `${card.tokens}` }),
      ),
    ),
  );
}

function confetti(): HTMLElement {
  const host = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  if (prefersReducedMotion()) return host;
  const glyphs = ['💰', '🗝️', '⚔️', '🛡️', '✨', '🪙'];
  for (let i = 0; i < 18; i += 1) {
    host.appendChild(
      h('span', {
        class: 'confetti__bit',
        style: `left:${Math.round((i / 18) * 100)}%; animation-delay:${(i % 6) * 0.25}s`,
        text: glyphs[i % glyphs.length],
      }),
    );
  }
  return host;
}

function saveBlock(game: GameState): HTMLElement | null {
  if (!game.canSaveToGithub) return null;

  const status = game.save;
  const saving = status.status === 'saving' || state.pendingSave;

  const onSave = async (): Promise<void> => {
    if (saving) return;
    state.pendingSave = true;
    render();
    const result = await saveToGithub();
    state.pendingSave = false;
    if (result?.ok && result.url) toast('Retro committed to GitHub.', 'success');
    else if (result?.error) toast(result.error, 'error');
    render();
  };

  const onDownload = async (): Promise<void> => {
    const result = await downloadSnapshot();
    if (!result?.ok || !result.json) {
      toast(result?.error ?? 'Could not build the export.', 'error');
      return;
    }
    const blob = new Blob([result.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: result.filename ?? 'retro.json' });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('JSON downloaded.', 'success');
  };

  return panel(
    'Save the chronicle',
    'Only the player named Markus sees this, and the server checks the name again before it writes anything.',
    !game.githubConfigured
      ? h('p', {
          class: 'notice notice--warn',
          text: 'GitHub saving is not configured on this server (GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO). The download below always works.',
        })
      : null,
    h(
      'div',
      { class: 'actions' },
      button(saving ? 'Saving…' : 'Save retro to GitHub', {
        class: 'btn--primary',
        disabled: saving,
        onClick: () => void onSave(),
      }),
      button('Download JSON', { class: 'btn--ghost', onClick: () => void onDownload() }),
    ),
    status.status === 'saved' && status.url
      ? h(
          'p',
          { class: 'notice notice--ok' },
          'Committed: ',
          h('a', { class: 'link', href: status.url, target: '_blank', rel: 'noreferrer noopener', text: status.url }),
        )
      : null,
    status.status === 'error' && status.message
      ? h('p', { class: 'notice notice--error', role: 'alert', text: status.message })
      : null,
    status.status === 'saved' && status.message
      ? h('p', { class: 'field__hint', text: status.message })
      : null,
  );
}

export function renderVictory(game: GameState): HTMLElement {
  const summary = game.summary;
  if (!summary) {
    return panel('No summary yet', 'The raid has not finished.', emptyState('Nothing to show.'));
  }

  const selected = summary.experiments.filter((experiment) => experiment.selected);
  const others = summary.experiments.filter((experiment) => !experiment.selected);

  const header = h(
    'section',
    { class: 'victory' },
    confetti(),
    h('p', { class: 'victory__kicker', text: `Room ${game.code} · raid complete` }),
    h('h2', { class: 'victory__title', text: 'The party made it out' }),
    h(
      'div',
      { class: 'victory__stats' },
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__value', text: String(summary.participants.length) }),
        h('span', { class: 'stat__label', text: 'raiders' }),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', {
          class: 'stat__value',
          text: summary.averageEnergy === null ? '—' : summary.averageEnergy.toFixed(1),
        }),
        h('span', { class: 'stat__label', text: 'average starting energy' }),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__value', text: String(summary.loot.length) }),
        h('span', { class: 'stat__label', text: 'loot found' }),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__value', text: String(summary.traps.length + summary.monsters.length) }),
        h('span', { class: 'stat__label', text: 'traps and monsters' }),
      ),
    ),
    h('p', { class: 'victory__party', text: summary.participants.join(' · ') }),
  );

  const boss = summary.boss
    ? panel(
        'The boss we named',
        `${CATEGORY_META[summary.boss.category].room} · ${summary.boss.votes} votes`,
        h(
          'div',
          { class: 'boss boss--small' },
          h('h3', { class: 'boss__title', text: summary.boss.title }),
          h('ul', { class: 'boss__texts' }, ...summary.boss.texts.map((text) => h('li', { class: 'boss__text', text }))),
        ),
      )
    : panel('No boss', 'The party skipped the vote.', emptyState('Nothing was crowned.'));

  const experiments = panel(
    'Weapons we carry',
    selected.length ? 'Reviewed on the dates below.' : 'Nothing was selected.',
    selected.length
      ? h(
          'div',
          { class: 'weapons' },
          ...selected.map((experiment) =>
            h(
              'article',
              { class: 'weapon weapon--selected' },
              h('h4', { class: 'weapon__title', text: experiment.title }),
              experiment.description ? h('p', { class: 'weapon__body', text: experiment.description }) : null,
              h(
                'dl',
                { class: 'weapon__facts' },
                h('dt', { text: 'We will know it helped when' }),
                h('dd', { text: experiment.signal }),
                h('dt', { text: 'Owner' }),
                h('dd', { text: experiment.owner || 'The whole party' }),
                h('dt', { text: 'Review' }),
                h('dd', { text: experiment.reviewBy }),
                h('dt', { text: 'Forge points' }),
                h('dd', { text: String(experiment.points) }),
              ),
            ),
          ),
        )
      : emptyState('No experiment selected.', 'The facilitator can step back to the forge and pick one.'),
    others.length
      ? h(
          'details',
          { class: 'details' },
          h('summary', { text: `Also proposed (${others.length})` }),
          h(
            'ul',
            { class: 'summary-list' },
            ...others.map((experiment) =>
              h(
                'li',
                { class: 'summary-list__item' },
                h('div', { class: 'summary-list__texts' }, h('p', { class: 'summary-list__text', text: experiment.title })),
                h('span', { class: 'summary-list__tokens', text: String(experiment.points) }),
              ),
            ),
          ),
        )
      : null,
  );

  const notes = summary.discussed.filter((card) => card.notes.trim().length > 0);

  return h(
    'div',
    { class: 'grid grid--wide' },
    header,
    h(
      'div',
      { class: 'grid grid--two' },
      boss,
      experiments,
      panel('Loot', 'What helped.', cardList(summary.loot, 'No loot was packed.')),
      panel(
        'Traps and monsters that mattered',
        'Ranked by tokens.',
        cardList([...summary.traps, ...summary.monsters].sort((a, b) => b.tokens - a.tokens).slice(0, 8), 'Nothing collected tokens.'),
      ),
      panel(
        'Notes from the discussion',
        notes.length ? 'Captured live by the party.' : 'Nobody wrote anything down.',
        notes.length
          ? h(
              'ul',
              { class: 'summary-list' },
              ...notes.map((card) =>
                h(
                  'li',
                  { class: `summary-list__item summary-list__item--${card.category}` },
                  h(
                    'div',
                    { class: 'summary-list__texts' },
                    ...card.texts.map((text) => h('p', { class: 'summary-list__text', text })),
                    h('p', { class: 'summary-list__note', text: card.notes }),
                  ),
                ),
              ),
            )
          : emptyState('No notes.'),
      ),
      saveBlock(game),
    ),
  );
}

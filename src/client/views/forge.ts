import { LIMITS } from '../../shared/constants.js';
import type { GameState, PublicProposal } from '../../shared/types.js';
import { debounce, h } from '../dom.js';
import { act, render, toast } from '../store.js';
import { button, emptyState, panel } from './ui.js';

interface ProposalDraft {
  title: string;
  description: string;
  signal: string;
  owner: string;
  reviewBy: string;
}

let draft: ProposalDraft = { title: '', description: '', signal: '', owner: '', reviewBy: '' };
let loadedFrom: string | null = null;
let errors: string[] = [];
let busy = false;

const pushEdit = debounce((proposalId: string, values: ProposalDraft) => {
  void act('forge:edit', { proposalId, ...values });
}, 400);

function syncDraft(game: GameState): void {
  const mine = game.forge.proposals.find((proposal) => proposal.id === game.forge.myProposalId);
  if (mine && loadedFrom !== mine.id) {
    draft = {
      title: mine.title,
      description: mine.description,
      signal: mine.signal,
      owner: mine.owner,
      reviewBy: mine.reviewBy,
    };
    loadedFrom = mine.id;
  }
}

function field(
  label: string,
  key: keyof ProposalDraft,
  options: { placeholder: string; max: number; area?: boolean; hint?: string; required?: boolean },
): HTMLElement {
  const id = `forge-${key}`;
  const common = {
    class: `input ${options.area ? 'input--area' : ''}`.trim(),
    id,
    'data-key': id,
    maxlength: options.max,
    placeholder: options.placeholder,
    value: draft[key],
    onInput: (event: Event) => {
      draft[key] = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    },
  };
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: id }, label, options.required ? h('span', { class: 'req', text: ' *' }) : null),
    options.area ? h('textarea', { ...common, rows: '3' }) : h('input', { ...common, type: 'text' }),
    options.hint ? h('p', { class: 'field__hint', text: options.hint }) : null,
  );
}

function proposalCard(game: GameState, proposal: PublicProposal): HTMLElement {
  const isMine = proposal.id === game.forge.myProposalId;
  const canAllocate = !game.forge.revealed;
  return h(
    'article',
    { class: `weapon ${proposal.selected ? 'weapon--selected' : ''}`.trim() },
    h(
      'header',
      { class: 'weapon__head' },
      h('h4', { class: 'weapon__title', text: proposal.title }),
      proposal.selected ? h('span', { class: 'tag tag--gold', text: 'Carried into next sprint' }) : null,
      proposal.points !== null
        ? h('span', { class: 'weapon__points', text: `${proposal.points} forge points` })
        : null,
    ),
    proposal.description ? h('p', { class: 'weapon__body', text: proposal.description }) : null,
    h(
      'dl',
      { class: 'weapon__facts' },
      h('dt', { text: 'We will know it helped when' }),
      h('dd', { text: proposal.signal }),
      h('dt', { text: 'Owner' }),
      h('dd', { text: proposal.owner || 'The whole party' }),
      h('dt', { text: 'Review' }),
      h('dd', { text: proposal.reviewBy }),
      h('dt', { text: 'Proposed by' }),
      h('dd', { text: `${proposal.authorName}${isMine ? ' (you)' : ''}` }),
    ),
    canAllocate
      ? h(
          'div',
          { class: 'weapon__allocate' },
          h('label', { class: 'field__label', for: `points-${proposal.id}`, text: 'Your forge points' }),
          h('input', {
            class: 'input input--tiny',
            id: `points-${proposal.id}`,
            'data-key': `points-${proposal.id}`,
            type: 'number',
            min: '0',
            max: String(LIMITS.forgePoints),
            value: String(proposal.myPoints),
            onChange: (event: Event) => {
              const raw = Number.parseInt((event.target as HTMLInputElement).value, 10);
              const points = Number.isFinite(raw) ? Math.max(0, Math.min(LIMITS.forgePoints, raw)) : 0;
              void act('forge:allocate', { proposalId: proposal.id, points });
            },
          }),
        )
      : null,
    game.you.isFacilitator && game.forge.revealed
      ? h(
          'div',
          { class: 'weapon__facilitate' },
          button(proposal.selected ? 'Drop from the loadout' : 'Carry this one', {
            class: 'btn--ghost btn--small',
            onClick: () => void act('forge:toggleSelect', { proposalId: proposal.id }),
          }),
        )
      : null,
    game.you.isFacilitator && game.forge.revealed && proposal.selected
      ? h(
          'div',
          { class: 'weapon__edit' },
          h('p', { class: 'field__hint', text: 'Final wording — everyone sees your edits live.' }),
          h('input', {
            class: 'input',
            'data-key': `edit-title-${proposal.id}`,
            type: 'text',
            value: proposal.title,
            maxlength: LIMITS.proposalTitle,
            'aria-label': 'Final action title',
            onInput: (event: Event) =>
              pushEdit(proposal.id, {
                title: (event.target as HTMLInputElement).value,
                description: proposal.description,
                signal: proposal.signal,
                owner: proposal.owner,
                reviewBy: proposal.reviewBy,
              }),
          }),
          h('textarea', {
            class: 'input input--area',
            'data-key': `edit-signal-${proposal.id}`,
            rows: '2',
            value: proposal.signal,
            maxlength: LIMITS.proposalSignal,
            'aria-label': 'Final observable sign',
            onInput: (event: Event) =>
              pushEdit(proposal.id, {
                title: proposal.title,
                description: proposal.description,
                signal: (event.target as HTMLTextAreaElement).value,
                owner: proposal.owner,
                reviewBy: proposal.reviewBy,
              }),
          }),
        )
      : null,
  );
}

export function renderForge(game: GameState): HTMLElement {
  syncDraft(game);

  const spent = game.forge.proposals.reduce((sum, proposal) => sum + proposal.myPoints, 0);
  const left = game.forge.pointsPerPlayer - spent;

  const form = panel(
    game.forge.myProposalId ? 'Your experiment' : 'Forge a weapon',
    'One small thing the team can try in the next few weeks. Concrete beats noble.',
    field('Action title', 'title', {
      placeholder: 'Pair on the flaky payment specs every Tuesday morning',
      max: LIMITS.proposalTitle,
      required: true,
      hint: '"Communicate better" will be rejected by the forge. Name the actual change.',
    }),
    field('Short description', 'description', {
      placeholder: 'Two people, one hour, same tests, until the suite is green three runs in a row.',
      max: LIMITS.proposalDescription,
      area: true,
    }),
    field('We will know it helped when', 'signal', {
      placeholder: 'No red build caused by payment specs for two weeks.',
      max: LIMITS.proposalSignal,
      area: true,
      required: true,
    }),
    h(
      'div',
      { class: 'field-row' },
      field('Owner (optional)', 'owner', { placeholder: 'Whoever volunteers', max: LIMITS.proposalOwner }),
      field('Review date or period', 'reviewBy', {
        placeholder: 'In two sprints / 2026-10-15',
        max: LIMITS.proposalReview,
        required: true,
      }),
    ),
    errors.length
      ? h('ul', { class: 'form-error', role: 'alert' }, ...errors.map((error) => h('li', { text: error })))
      : null,
    h(
      'div',
      { class: 'actions' },
      button(busy ? 'Hammering…' : game.forge.myProposalId ? 'Update my experiment' : 'Put it on the anvil', {
        class: 'btn--primary',
        disabled: busy || game.forge.revealed,
        onClick: async () => {
          busy = true;
          errors = [];
          render();
          const result = await act('forge:propose', draft);
          busy = false;
          errors = result.errors ?? (result.ok ? [] : result.error ? [result.error] : []);
          if (result.ok) toast('Experiment forged.', 'success');
          render();
        },
      }),
    ),
  );

  const anvil = panel(
    `The anvil (${game.forge.proposals.length} experiment${game.forge.proposals.length === 1 ? '' : 's'})`,
    game.forge.revealed
      ? 'Totals are in. The facilitator picks the one or two the team carries.'
      : `You hold ${game.forge.pointsPerPlayer} forge points — ${left} left. Spend them privately; totals appear together.`,
    game.forge.proposals.length
      ? h('div', { class: 'weapons' }, ...game.forge.proposals.map((proposal) => proposalCard(game, proposal)))
      : emptyState('The anvil is cold.', 'Add the first experiment on the left.'),
    game.you.isFacilitator && !game.forge.revealed
      ? button('Reveal the forge points', {
          class: 'btn--primary btn--small',
          onClick: () => void act('forge:reveal'),
        })
      : null,
    h('p', {
      class: 'field__hint',
      text: `${game.forge.proposedPlayerIds.length} of ${game.players.length} raiders proposed something · ${game.forge.allocatedPlayerIds.length} have spent points.`,
    }),
  );

  return h('div', { class: 'grid grid--two' }, form, anvil);
}

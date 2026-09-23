import { LIMITS } from '../shared/constants.js';
import type { Enemy } from '../shared/types.js';
import { complete, extractJson, type OpenRouterConfig } from './openrouter.js';
import { sanitizeText } from './validation.js';

/*
 * The oracle suggests ways to beat an enemy, or sharpens an idea someone wrote.
 * Its output lands on the idea board like anyone else's: the party still
 * decides, kicks and merges. Without an API key a small local playbook stands
 * in, so the buttons never go dead.
 */

const IDEA_TIMEOUT_MS = 12_000;

const IDEAS_SYSTEM = [
  'You help a software team in a retrospective game find concrete ways to handle a problem.',
  'The problem is presented as a fantasy enemy; answer about the real problem behind it.',
  'Answer with JSON only: {"ideas":["...","..."]}.',
  'Give exactly 3 ideas, each one sentence, max 30 words, concrete and testable within two weeks:',
  'who does what, when, and how the team will notice it worked. Plain language, no fantasy wording.',
  'Do not repeat or rephrase ideas that are already on the table. Never blame a person.',
].join(' ');

const REFINE_SYSTEM = [
  'You help a software team in a retrospective turn a rough idea into a concrete agreement.',
  'Answer with JSON only: {"idea":"..."}.',
  'Keep the original intent. Make it specific: first step, a rhythm or trigger, and a signal that shows it worked.',
  'Max 45 words, plain language, no fantasy wording, no invented names or dates.',
].join(' ');

const PLAYBOOK: Array<{ match: RegExp; ideas: string[] }> = [
  {
    match: /review|pr\b|pull request|approval/i,
    ideas: [
      'Reserve a 30-minute review slot every morning before new work starts, and check open PR age at standup.',
      'Cap pull requests at roughly 400 changed lines so reviews fit into one sitting.',
      'Name a daily review buddy in standup who owns getting every waiting PR a first look by noon.',
    ],
  },
  {
    match: /deploy|release|pipeline|ci\b|build/i,
    ideas: [
      'Freeze non-urgent deploys after Thursday noon and track how many Friday incidents we avoid.',
      'Fix the slowest pipeline stage first: measure it this week, pair on it next week.',
      'Add a one-page release checklist and let whoever deploys tick it off in the channel.',
    ],
  },
  {
    match: /flaky|test|qa|bug|regression/i,
    ideas: [
      'Quarantine flaky tests into a separate job the day they flake, with a ticket and an owner.',
      'Pair for one hour every Tuesday on the flakiest test until the list is empty.',
      'Add a regression test for every bug we fix this sprint, and review the count at the next retro.',
    ],
  },
  {
    match: /meeting|call|standup|termin/i,
    ideas: [
      'Give every recurring meeting an agenda in the invite, or cancel it that week.',
      'Block two meeting-free focus afternoons per week for the whole team.',
      'Time-box standup to 15 minutes and move deep dives into a follow-up with only the people involved.',
    ],
  },
  {
    match: /scope|requirement|unclear|vague|spec|refine/i,
    ideas: [
      'No ticket enters the sprint without acceptance criteria that a tester could check.',
      'Hold a 20-minute three-amigos chat (dev, product, QA) before starting any story larger than two days.',
      'When scope grows mid-sprint, product decides out loud what drops out in exchange.',
    ],
  },
  {
    match: /owner|responsib|who does/i,
    ideas: [
      'Write down one owner per service in the README and review the list monthly.',
      'Every ticket gets an assignee before it leaves refinement.',
      'Start a rotating "caretaker of the week" for orphaned alerts and requests.',
    ],
  },
  {
    match: /context|switch|interrupt|focus/i,
    ideas: [
      'Route ad-hoc requests to one rotating shield person per day so the rest can focus.',
      'Limit work in progress to one ticket per person and make exceptions visible on the board.',
      'Batch non-urgent questions into two fixed slots a day instead of instant pings.',
    ],
  },
];

const GENERIC = [
  'Pick the smallest version of a fix we can try for one sprint, and look at the result together at the next retro.',
  'Make the problem visible: track how often it happens this sprint on the team board.',
  'Pair on it for one hour this week and write down what we learn.',
  'Agree on a clear trigger: when this happens again, whoever notices raises it in standup the same day.',
];

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function localIdeas(enemy: Enemy, existing: string[], count = 3): string[] {
  const text = `${enemy.name} ${enemy.description} ${enemy.sourceTopics.join(' ')}`;
  const themed = PLAYBOOK.filter((entry) => entry.match.test(text)).flatMap((entry) => entry.ideas);
  const taken = new Set(existing.map(normalise));
  return [...themed, ...GENERIC].filter((idea) => !taken.has(normalise(idea))).slice(0, count);
}

export function localRefinement(idea: string): string {
  const base = idea.trim().replace(/[.!]+$/, '');
  return `${base}. First step: agree who starts it tomorrow. Check it at every standup for two weeks, then keep or drop it at the next retro.`.slice(
    0,
    LIMITS.proposalText,
  );
}

function enemyBrief(enemy: Enemy): Record<string, unknown> {
  return {
    enemy: enemy.name,
    description: enemy.description,
    realProblems: enemy.sourceTopics,
  };
}

export async function generateIdeas(
  enemy: Enemy,
  existing: string[],
  config: OpenRouterConfig | null,
  fetchImpl?: typeof fetch,
): Promise<{ ideas: string[]; source: 'ai' | 'local' }> {
  const fallback = { ideas: localIdeas(enemy, existing), source: 'local' as const };
  if (!config) return fallback;
  const result = await complete({
    config,
    system: IDEAS_SYSTEM,
    user: JSON.stringify({ ...enemyBrief(enemy), alreadyOnTheTable: existing }),
    maxTokens: 400,
    timeoutMs: IDEA_TIMEOUT_MS,
    fetchImpl,
  });
  if (!result.ok) return fallback;
  const parsed = extractJson(result.content) as { ideas?: unknown } | null;
  const ideas = (Array.isArray(parsed?.ideas) ? parsed!.ideas : [])
    .map((idea) => sanitizeText(idea, LIMITS.proposalText).replace(/\s+/g, ' '))
    .filter((idea) => idea.length >= 10)
    .slice(0, 3);
  return ideas.length > 0 ? { ideas, source: 'ai' } : fallback;
}

export async function refineIdea(
  enemy: Enemy,
  idea: string,
  config: OpenRouterConfig | null,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const fallback = localRefinement(idea);
  if (!config) return fallback;
  const result = await complete({
    config,
    system: REFINE_SYSTEM,
    user: JSON.stringify({ ...enemyBrief(enemy), roughIdea: idea }),
    maxTokens: 200,
    timeoutMs: IDEA_TIMEOUT_MS,
    fetchImpl,
  });
  if (!result.ok) return fallback;
  const parsed = extractJson(result.content) as { idea?: unknown } | null;
  const refined = sanitizeText(parsed?.idea, LIMITS.proposalText).replace(/\s+/g, ' ');
  return refined.length >= 10 ? refined : fallback;
}

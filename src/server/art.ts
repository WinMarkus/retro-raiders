import { generateImage, type OpenRouterImageConfig } from './openrouter.js';
import type { Room } from './state.js';

/*
 * One painting per raid: the whole party mid-battle against the dungeon they
 * built from their own sprint. Frozen enemies are shown shattering; the ones
 * still standing loom in the dark behind them — that is next sprint's fight.
 */

const MAX_HEROES = 8;
const MAX_FOES = 5;
const MAX_PROMPT = 3_000;

function clip(text: string, length: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length - 1).trim()}…` : clean;
}

/** Portrait hints are written for small cartoon avatars; keep what, drop the style. */
function looks(hint: string): string {
  return hint
    .replace(/\b(tiny|cute|chibi|cartoon(ish)?|warm|pixel[- ]?art|8-?bit|style|illustration|avatar|portrait)\b/gi, '')
    .replace(/[\s,]+/g, ' ')
    .trim();
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function sentence(text: string): string {
  return text.trim().replace(/[.;,\s]+$/, '');
}

export function buildBattlePrompt(room: Room): string {
  const heroes = [...room.players.values()]
    .map((player) => player.character)
    .filter((character): character is NonNullable<typeof character> => Boolean(character))
    .slice(0, MAX_HEROES)
    .map((character) => {
      const detail = looks(character.avatarPrompt) || character.skill;
      return clip(`${character.characterName}, ${article(character.className)} ${character.className}${detail ? ` (${sentence(detail)})` : ''}`, 150);
    });

  const enemies = room.level?.enemies ?? [];
  const frozen = enemies.filter((enemy) => enemy.status === 'resolved');
  const standing = enemies.filter((enemy) => enemy.status !== 'resolved');
  const strongest = [...enemies].sort((a, b) => b.strength - a.strength).slice(0, MAX_FOES);
  const describe = (list: typeof enemies): string =>
    list
      .filter((enemy) => strongest.includes(enemy))
      .map((enemy) => clip(`${enemy.name}, ${sentence(enemy.description).replace(/^./, (c) => c.toLowerCase())}`, 160))
      .join('; ');

  const lines = [
    'Epic Dungeons & Dragons battle painting, wide cinematic 16:9 composition, dramatic low-angle view.',
    `Setting: ${clip(room.level?.title ?? 'a vast torch-lit dungeon hall', 80)}, an ancient stone dungeon hall lit by torches and magic.`,
    heroes.length > 0
      ? `A party of ${heroes.length} heroes fights side by side in the foreground: ${heroes.join('; ')}.`
      : 'A party of adventurers fights side by side in the foreground.',
    frozen.length > 0
      ? `Monsters the party has just defeated, cracking apart and encased in shattering ice: ${describe(frozen) || frozen.map((enemy) => enemy.name).join(', ')}.`
      : '',
    standing.length > 0
      ? `Monsters still standing, huge and menacing, looming from the darkness behind them: ${describe(standing) || standing.map((enemy) => enemy.name).join(', ')}.`
      : 'The last monster falls; the hall is theirs.',
    'Mood: raw power and defiance, crimson blood magic swirling around the casters, arcane lightning, sparks and embers, heroes mid-strike, an unstoppable team.',
    'Style: highly detailed dark fantasy oil painting, realistic lighting, rich contrast, deep reds and golds against cold blue ice.',
    'No gore, no text, no letters, no logos, no UI, no watermark.',
  ];
  return clip(lines.filter(Boolean).join(' '), MAX_PROMPT);
}

export async function paintBattle(
  room: Room,
  config: OpenRouterImageConfig,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; dataUrl: string; mediaType: string; prompt: string } | { ok: false; error: string; prompt: string }> {
  const prompt = buildBattlePrompt(room);
  const result = await generateImage({ config, prompt, fetchImpl, timeoutMs: 180_000 });
  return result.ok
    ? { ok: true, dataUrl: result.dataUrl, mediaType: result.mediaType, prompt }
    : { ok: false, error: result.error, prompt };
}

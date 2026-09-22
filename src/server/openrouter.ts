export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  referer: string;
  title: string;
}

export interface OpenRouterConfigResult {
  ok: boolean;
  config?: OpenRouterConfig;
  message?: string;
}

export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export function readOpenRouterConfig(env: NodeJS.ProcessEnv = process.env): OpenRouterConfigResult {
  const apiKey = (env.OPENROUTER_API_KEY ?? '').trim();
  if (!apiKey) {
    return {
      ok: false,
      message:
        'OPENROUTER_API_KEY is not set on the server, so the dungeon is built by the deterministic generator instead of the AI.',
    };
  }
  return {
    ok: true,
    config: {
      apiKey,
      model: (env.OPENROUTER_MODEL ?? '').trim() || DEFAULT_MODEL,
      referer: (env.OPENROUTER_SITE_URL ?? '').trim() || 'https://github.com/WinMarkus/retro-raiders',
      title: (env.OPENROUTER_APP_NAME ?? '').trim() || 'Retro Raiders',
    },
  };
}

export function isOpenRouterConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readOpenRouterConfig(env).ok;
}

/** Keeps the key out of logs, error messages and anything that reaches a client. */
function scrub(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

export interface CompletionInput {
  config: OpenRouterConfig;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type CompletionResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export async function complete(input: CompletionInput): Promise<CompletionResult> {
  const { config, system, user } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 45_000);

  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'HTTP-Referer': config.referer,
        'X-Title': config.title,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.9,
        max_tokens: input.maxTokens ?? 1600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        error: scrub(`OpenRouter answered ${response.status}. ${body.slice(0, 200)}`, config.apiKey).trim(),
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'OpenRouter returned an empty completion.' };
    }
    return { ok: true, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const friendly =
      error instanceof Error && error.name === 'AbortError'
        ? 'OpenRouter did not answer in time.'
        : `Could not reach OpenRouter: ${message}`;
    return { ok: false, error: scrub(friendly, config.apiKey) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Models sometimes wrap JSON in prose or a fenced block even when asked not to.
 * Pull out the first balanced object and parse that.
 */
export function extractJson(raw: string): unknown | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return tryParse(trimmed.slice(start, i + 1));
    }
  }
  return null;
}

function tryParse(text: string): unknown | null {
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

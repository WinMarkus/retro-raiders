export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  modelLabel: string;
  referer: string;
  title: string;
}

export interface OpenRouterModelOption {
  id: string;
  label: string;
}

export interface OpenRouterConfigResult {
  ok: boolean;
  config?: OpenRouterConfig;
  message?: string;
}

export const DEFAULT_TEXT_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_MODEL = DEFAULT_TEXT_MODEL;

export const BUILTIN_TEXT_MODEL_OPTIONS: OpenRouterModelOption[] = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini - cheap solid default' },
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini - better wording' },
  { id: 'openai/gpt-4.1', label: 'GPT-4.1 - stronger, pricier' },
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4 - creative' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash - fast' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash - experimental cheap' },
];

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function splitList(value: string | undefined): string[] {
  const clean = (value ?? '').trim().replace(/^['"]|['"]$/g, '');
  return clean
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizeModelId(model: string): string {
  return model.trim().replace(/[^a-zA-Z0-9._:/-]/g, '').slice(0, 120);
}

export function readOpenRouterModelOptions(env: NodeJS.ProcessEnv = process.env): OpenRouterModelOption[] {
  const configured = splitList(env.OPENROUTER_MODEL_OPTIONS);
  if (configured.length === 0) return BUILTIN_TEXT_MODEL_OPTIONS;

  const seen = new Set<string>();
  const options: OpenRouterModelOption[] = [];
  for (const raw of configured) {
    const [idPart, labelPart] = raw.split('|');
    const id = sanitizeModelId(idPart ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: (labelPart ?? id).trim() || id });
  }
  return options.length > 0 ? options : BUILTIN_TEXT_MODEL_OPTIONS;
}

export function selectOpenRouterModel(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterModelOption {
  const options = readOpenRouterModelOptions(env);
  const preferred = sanitizeModelId(
    requested || env.OPENROUTER_TEXT_MODEL || env.OPENROUTER_MODEL || DEFAULT_TEXT_MODEL,
  );
  return options.find((option) => option.id === preferred) ?? options[0]!;
}

export function isAllowedOpenRouterModel(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const clean = sanitizeModelId(model);
  return readOpenRouterModelOptions(env).some((option) => option.id === clean);
}

export function readOpenRouterConfig(
  env: NodeJS.ProcessEnv = process.env,
  requestedModel?: string | null,
): OpenRouterConfigResult {
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
      model: selectOpenRouterModel(requestedModel, env).id,
      modelLabel: selectOpenRouterModel(requestedModel, env).label,
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

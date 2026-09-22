export interface GithubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface GithubConfigResult {
  ok: boolean;
  config?: GithubConfig;
  missing: string[];
  message?: string;
}

const REQUIRED_VARS = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'] as const;

export function readGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfigResult {
  const missing = REQUIRED_VARS.filter((name) => !env[name] || env[name]!.trim() === '');
  if (missing.length > 0) {
    return {
      ok: false,
      missing: [...missing],
      message: `Saving to GitHub is not configured on the server. Missing environment ${
        missing.length === 1 ? 'variable' : 'variables'
      }: ${missing.join(', ')}. Set them (plus the optional GITHUB_BRANCH, default "main") and restart the server. Until then, use Download JSON.`,
    };
  }
  return {
    ok: true,
    missing: [],
    config: {
      token: env.GITHUB_TOKEN!.trim(),
      owner: env.GITHUB_OWNER!.trim(),
      repo: env.GITHUB_REPO!.trim(),
      branch: (env.GITHUB_BRANCH ?? 'main').trim() || 'main',
    },
  };
}

export function isGithubConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readGithubConfig(env).ok;
}

export interface CommitInput {
  config: GithubConfig;
  path: string;
  message: string;
  content: string;
}

export interface CommitResult {
  ok: boolean;
  url?: string;
  error?: string;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'retro-raiders',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Never let a token reach a log line or an error message. */
function scrub(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('***');
}

/**
 * Commits one file through the GitHub Contents API.
 * Success is only reported when GitHub answers with a created/updated content
 * object that carries an html_url.
 */
export async function commitFile(input: CommitInput, fetchImpl: typeof fetch = fetch): Promise<CommitResult> {
  const { config, path, message, content } = input;
  const base = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
    config.repo,
  )}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  let sha: string | undefined;
  try {
    const existing = await fetchImpl(`${base}?ref=${encodeURIComponent(config.branch)}`, {
      method: 'GET',
      headers: apiHeaders(config.token),
    });
    if (existing.status === 200) {
      const body = (await existing.json()) as { sha?: string };
      sha = typeof body.sha === 'string' ? body.sha : undefined;
    } else if (existing.status !== 404) {
      const detail = await safeText(existing);
      return {
        ok: false,
        error: `GitHub refused the request while checking the file (HTTP ${existing.status}). ${scrub(
          detail,
          config.token,
        )}`,
      };
    }
  } catch (error) {
    return { ok: false, error: `Could not reach GitHub: ${describe(error, config.token)}` };
  }

  try {
    const response = await fetchImpl(base, {
      method: 'PUT',
      headers: apiHeaders(config.token),
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: config.branch,
        ...(sha ? { sha } : {}),
      }),
    });

    if (response.status !== 200 && response.status !== 201) {
      const detail = await safeText(response);
      return {
        ok: false,
        error: `GitHub rejected the commit (HTTP ${response.status}). ${scrub(detail, config.token)}`,
      };
    }

    const body = (await response.json()) as { content?: { html_url?: string } };
    const url = body?.content?.html_url;
    if (!url) {
      return { ok: false, error: 'GitHub answered without a file URL, so the save is not confirmed.' };
    }
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: `Could not reach GitHub: ${describe(error, config.token)}` };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function describe(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrub(message.slice(0, 300), token);
}

import { describe, expect, it, vi } from 'vitest';
import { commitFile, isGithubConfigured, readGithubConfig } from '../src/server/github.js';

const config = { token: 'ghp_secret_token_value', owner: 'akarion', repo: 'team-retros', branch: 'main' };

function response(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('configuration', () => {
  it('names every missing variable and stays usable without them', () => {
    const result = readGithubConfig({} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO']);
    expect(result.message).toContain('GITHUB_TOKEN');
    expect(result.message).toContain('GITHUB_OWNER');
    expect(result.message).toContain('GITHUB_REPO');
    expect(result.message).toContain('Download JSON');
    expect(isGithubConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('reports a partial configuration precisely', () => {
    const result = readGithubConfig({ GITHUB_TOKEN: 'x', GITHUB_OWNER: '  ' } as NodeJS.ProcessEnv);
    expect(result.missing).toEqual(['GITHUB_OWNER', 'GITHUB_REPO']);
  });

  it('defaults the branch to main', () => {
    const result = readGithubConfig({
      GITHUB_TOKEN: 'x',
      GITHUB_OWNER: 'akarion',
      GITHUB_REPO: 'team-retros',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
    expect(result.config?.branch).toBe('main');
  });
});

describe('committing (GitHub API mocked, no real commits)', () => {
  it('creates a new file and returns the URL GitHub confirmed', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'PUT') {
        return response(201, { content: { html_url: 'https://github.com/akarion/team-retros/blob/main/retro-saves/x.json' } });
      }
      return response(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;

    const result = await commitFile(
      { config, path: 'retro-saves/retro-raiders/2026-03-04_09-05_room-GH7K2M.json', message: 'save', content: '{"a":1}' },
      fetchMock,
    );

    expect(result.ok).toBe(true);
    expect(result.url).toContain('github.com/akarion/team-retros');
    expect(calls).toHaveLength(2);

    const put = calls[1]!;
    const body = JSON.parse(String(put.init?.body)) as { content: string; branch: string; sha?: string };
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('{"a":1}');
    expect(body.branch).toBe('main');
    expect(body.sha).toBeUndefined();
    expect((put.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${config.token}`);
  });

  it('sends the existing sha when the file is already there', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return response(200, { content: { html_url: 'https://github.com/x/y/blob/main/z.json' } });
      return response(200, { sha: 'abc123' });
    }) as unknown as typeof fetch;

    const result = await commitFile({ config, path: 'a/b.json', message: 'save', content: '{}' }, fetchMock);
    expect(result.ok).toBe(true);
    const put = (fetchMock as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[1]!;
    expect(JSON.parse(String(put[1].body)).sha).toBe('abc123');
  });

  it('never reports success when GitHub rejects the commit', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return response(403, { message: 'Resource not accessible by personal access token' });
      return response(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;

    const result = await commitFile({ config, path: 'a/b.json', message: 'save', content: '{}' }, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.url).toBeUndefined();
    expect(result.error).toContain('403');
  });

  it('never reports success when GitHub answers without a file URL', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return response(201, { content: {} });
      return response(404, {});
    }) as unknown as typeof fetch;

    const result = await commitFile({ config, path: 'a/b.json', message: 'save', content: '{}' }, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not confirmed');
  });

  it('keeps the token out of error messages', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`socket hang up while using ${config.token}`);
    }) as unknown as typeof fetch;

    const result = await commitFile({ config, path: 'a/b.json', message: 'save', content: '{}' }, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(config.token);
    expect(result.error).toContain('***');
  });

  it('reports a network failure instead of hanging', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') throw new Error('ENOTFOUND api.github.com');
      return response(404, {});
    }) as unknown as typeof fetch;

    const result = await commitFile({ config, path: 'a/b.json', message: 'save', content: '{}' }, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not reach GitHub');
  });
});

// Small GitHub REST/GraphQL client and workflow-command helpers shared by the
// PR policy (main.mjs) and the Claude review plan (review-main.mjs).
// No dependencies: uses the global fetch of Node 22.

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CONFIG_PATH } from './policy.mjs';

export function createClient({
  token,
  api = 'https://api.github.com',
  graphqlUrl = `${api.replace(/\/v3\/?$/, '')}/graphql`,
  repo,
  userAgent = 'mdivani-pr-policy',
}) {
  async function gh(path, { method = 'GET', body, accept = 'application/vnd.github+json', allow = [] } = {}) {
    const url = /^https?:\/\//.test(path) ? path : `${api}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': userAgent,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !allow.includes(res.status)) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function paginate(path, cap) {
    const items = [];
    for (let page = 1; items.length < cap; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await gh(`${path}${sep}per_page=100&page=${page}`);
      const batch = await res.json();
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items.slice(0, cap);
  }

  /** `.github/pr-policy.yml` from the given ref, or null if the repo has none. */
  async function readConfig(ref) {
    const res = await gh(`/repos/${repo}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(ref)}`, {
      accept: 'application/vnd.github.raw',
      allow: [404],
    });
    return res.status === 404 ? null : res.text();
  }

  async function graphql(query, variables = {}) {
    const res = await gh(graphqlUrl, { method: 'POST', body: { query, variables } });
    const json = await res.json();
    if (json.errors?.length) throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
    return json.data;
  }

  return { gh, paginate, readConfig, graphql };
}

/** Write step outputs. Multi-line values use a random heredoc delimiter. */
export function setOutputs(outputs, file = process.env.GITHUB_OUTPUT) {
  const text = Object.entries(outputs)
    .map(([k, v]) => {
      const value = String(v ?? '');
      if (!value.includes('\n')) return `${k}=${value}\n`;
      const delim = `EOF_${randomBytes(12).toString('hex')}`;
      return `${k}<<${delim}\n${value}\n${delim}\n`;
    })
    .join('');
  if (file) appendFileSync(file, text);
}

export function annotation(level, message) {
  // Workflow commands must be single-line; escape per the runner's rules.
  const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level}::${escaped}`);
}

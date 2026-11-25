import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SENSITIVE_PATHS,
  compileGlobs,
  evaluate,
  expandBraces,
  formatSummary,
  matchesGlob,
  parseBody,
  parseConfig,
  stripHtmlComments,
} from './policy.mjs';

const TEMPLATE_BODY = `## Changes
<!-- What changed and why -->
Fix the session refresh.

## Affected areas
<!-- Pages, services, tables, jobs touched -->
Login page.

## Difficulty
<!-- One of: critical | high | medium | low -->
Difficulty: medium
`;

const commit = (sha, parents = 1, message = 'work') => ({
  sha,
  parents: Array.from({ length: parents }, (_, i) => ({ sha: `${sha}p${i}` })),
  commit: { message },
});

function run(overrides = {}) {
  const { pr = {}, ...rest } = overrides;
  return evaluate({
    pr: {
      title: 'fix: refresh session',
      body: TEMPLATE_BODY,
      headRef: 'fix/session-refresh',
      baseRef: 'development',
      headRepo: 'Mdivani-Agency/app',
      baseRepo: 'Mdivani-Agency/app',
      commits: 1,
      changedFiles: 1,
      ...pr,
    },
    commits: [commit('aaaaaaa1')],
    files: [{ filename: 'src/app/page.tsx' }],
    ...rest,
  });
}

const hasError = (result, re) => result.errors.some((e) => re.test(e));

describe('globs', () => {
  it('expands braces', () => {
    assert.deepEqual(expandBraces('a.{ts,js}'), ['a.ts', 'a.js']);
    assert.deepEqual(expandBraces('{a,b}/{c,d}'), ['a/c', 'a/d', 'b/c', 'b/d']);
    assert.deepEqual(expandBraces('plain'), ['plain']);
  });

  it('matches ** as zero or more directories', () => {
    assert.ok(matchesGlob('README.md', '**/*.md'));
    assert.ok(matchesGlob('a/b/c.md', '**/*.md'));
    assert.ok(!matchesGlob('a/b/c.mdx', '**/*.md'));
    assert.ok(matchesGlob('supabase/migrations/001.sql', '**/supabase/migrations/**'));
    assert.ok(matchesGlob('apps/web/supabase/migrations/x/001.sql', '**/supabase/migrations/**'));
    assert.ok(!matchesGlob('supabase/seed.sql', '**/supabase/migrations/**'));
  });

  it('keeps * and ? inside one segment', () => {
    assert.ok(matchesGlob('docs/a.md', 'docs/*.md'));
    assert.ok(!matchesGlob('docs/x/a.md', 'docs/*.md'));
    assert.ok(matchesGlob('a1.tf', 'a?.tf'));
    assert.ok(!matchesGlob('a/1.tf', 'a?.tf'));
    assert.ok(matchesGlob('.env.example', '*.example'));
  });

  it('anchors root-relative globs', () => {
    assert.ok(matchesGlob('docs/guide/x.png', 'docs/**'));
    assert.ok(!matchesGlob('packages/docs/x.png', 'docs/**'));
    assert.ok(matchesGlob('docs/x.png', './docs/**'));
  });

  it('escapes regex characters', () => {
    assert.ok(matchesGlob('a+b(c).ts', 'a+b(c).ts'));
    assert.ok(!matchesGlob('axts', 'a.ts'));
  });

  it('default sensitive globs hit the intended files and not neighbours', () => {
    const isSensitive = compileGlobs(DEFAULT_SENSITIVE_PATHS);
    for (const p of [
      'supabase/migrations/20260101_init.sql',
      'supabase/schemas/profiles.sql',
      'db/rls/profiles.sql',
      'db/profiles_rls.sql',
      'db/rls_profiles.sql',
      'db/policies/read/profiles.sql',
      'src/lib/auth/session.ts',
      'proxy.ts',
      'src/proxy.ts',
      'src/middleware.ts',
      'src/lib/middlewares/authorization.middleware.ts',
      'src/api/authorizer.ts',
      'src/functions/authorizer/handler.ts',
      'src/lib/session.ts',
      'src/lib/sessions/store.ts',
      'src/billing/invoice.ts',
      'app/payments/route.ts',
      'src/credits/ledger.ts',
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      '.github/pr-policy.yml',
      'infra/main.tf',
      'infra/prod.tfvars',
    ]) {
      assert.ok(isSensitive(p), `${p} should be sensitive`);
    }
    for (const p of [
      'src/app/page.tsx',
      'db/urls.sql',
      'README.md',
      'docs/auth.md',
      'src/authors.ts',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'src/lib/proxy-utils.ts',
    ]) {
      assert.equal(isSensitive(p), null, `${p} should not be sensitive`);
    }
  });
});

describe('parseConfig', () => {
  it('returns empty lists for a missing file', () => {
    assert.deepEqual(parseConfig(null), { sensitive_paths: [], docs_paths: [] });
  });

  it('parses block lists with quotes and comments', () => {
    const cfg = parseConfig(`# per-repo floor
sensitive_paths:
  - "src/lib/repositories/**"  # data access
  - 'serverless.ts'
  - src/lib/clients/*.ts
docs_paths: []
`);
    assert.deepEqual(cfg, {
      sensitive_paths: ['src/lib/repositories/**', 'serverless.ts', 'src/lib/clients/*.ts'],
      docs_paths: [],
    });
  });

  it('accepts list items at column zero and CRLF', () => {
    assert.deepEqual(parseConfig('docs_paths:\r\n- "site/**"\r\n').docs_paths, ['site/**']);
  });

  it('rejects unknown keys, unquoted globs starting with *, and other syntax', () => {
    assert.throws(() => parseConfig('sensitive:\n  - a'), /line 1: unknown key "sensitive"/);
    assert.throws(() => parseConfig('sensitive_paths:\n  - **/x'), /line 2: quote the value/);
    assert.throws(() => parseConfig('sensitive_paths: a'), /must be a list/);
    assert.throws(() => parseConfig('  - a'), /outside of a list key/);
    assert.throws(() => parseConfig('sensitive_paths:\n  foo'), /unsupported syntax/);
    assert.throws(() => parseConfig('docs_paths:\ndocs_paths:'), /duplicate key/);
    assert.throws(() => parseConfig('docs_paths:\n  - ""'), /empty glob/);
  });
});

describe('parseBody', () => {
  it('strips HTML comments, including unterminated ones', () => {
    assert.equal(stripHtmlComments('a<!-- x\ny -->b<!-- open'), 'ab');
  });

  it('extracts sections and difficulty lines', () => {
    const { sections, difficulties } = parseBody(TEMPLATE_BODY);
    assert.equal(sections.get('changes'), 'Fix the session refresh.');
    assert.equal(sections.get('affected areas'), 'Login page.');
    assert.deepEqual(difficulties, ['medium']);
  });

  it('treats comment-only sections as empty', () => {
    const { sections } = parseBody('## Changes\n<!-- todo -->\n\n## Affected areas\n   \n');
    assert.equal(sections.get('changes'), '');
    assert.equal(sections.get('affected areas'), '');
  });

  it('ignores a Difficulty line inside a comment', () => {
    assert.deepEqual(parseBody('<!-- Difficulty: low -->').difficulties, []);
  });

  it('handles a null body', () => {
    assert.equal(parseBody(null).sections.size, 0);
  });
});

describe('evaluate: title, branch, body', () => {
  it('passes a compliant PR', () => {
    const r = run();
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.outputs, { type: 'fix', difficulty: 'medium', sensitive: 'false', is_release: 'false' });
  });

  it('accepts every PR type with a matching branch', () => {
    for (const t of ['feature', 'fix', 'hotfix', 'docs', 'ci']) {
      const r = run({ pr: { title: `${t}: thing`, headRef: `${t}/thing` }, files: [{ filename: 'a.md' }] });
      assert.deepEqual(r.errors, [], t);
      assert.equal(r.outputs.type, t);
    }
  });

  it('rejects a bad title and says how to fix it', () => {
    const r = run({ pr: { title: 'feat: add login' } });
    assert.ok(hasError(r, /Title: "feat: add login" does not match.*Use "feature", not "feat"/));
    assert.equal(r.outputs.type, '');
    assert.ok(hasError(run({ pr: { title: 'fix(api): x' } }), /no scope/));
    assert.ok(hasError(run({ pr: { title: 'chore: x' } }), /"chore" is not a PR type/));
    assert.ok(hasError(run({ pr: { title: 'Fix: x' } }), /lowercase "fix"/));
    assert.ok(hasError(run({ pr: { title: 'fix:   ' } }), /Title:/));
    assert.ok(hasError(run({ pr: { title: 'fix:x' } }), /Title:/));
  });

  it('rejects a bad branch name', () => {
    const r = run({ pr: { headRef: 'session-refresh' } });
    assert.ok(hasError(r, /Branch: head branch "session-refresh" does not match/));
    assert.ok(hasError(run({ pr: { headRef: 'feat/x' } }), /Branch:/));
    assert.ok(hasError(run({ pr: { headRef: 'fix/' } }), /Branch:/));
  });

  it('rejects a title/branch type mismatch', () => {
    const r = run({ pr: { headRef: 'feature/session' } });
    assert.ok(hasError(r, /mismatch: the title type is "fix" but the branch "feature\/session" has type "feature"/));
  });

  it('requires non-empty Changes and Affected areas', () => {
    const r = run({ pr: { body: '## Changes\n<!-- What changed -->\n\nDifficulty: low' } });
    assert.ok(hasError(r, /"## Changes" section is empty/));
    assert.ok(hasError(r, /"## Affected areas" section is missing/));
  });

  it('requires a valid single Difficulty line', () => {
    const base = '## Changes\nx\n## Affected areas\ny\n';
    assert.ok(hasError(run({ pr: { body: base } }), /no "Difficulty: <level>" line/));
    assert.ok(hasError(run({ pr: { body: `${base}Difficulty: huge` } }), /"huge" is not a valid level/));
    assert.ok(hasError(run({ pr: { body: `${base}Difficulty: low\nDifficulty: high` } }), /conflicting/));
    const ok = run({ pr: { body: `${base}Difficulty: High` } });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.outputs.difficulty, 'high');
  });

  it('reports all failures at once', () => {
    const r = run({
      pr: { title: 'oops', headRef: 'oops', body: '' },
      commits: [commit('bbbbbbb1', 2, "Merge branch 'main'")],
    });
    assert.equal(r.errors.length, 6, r.errors.join('\n'));
  });
});

describe('evaluate: docs-only', () => {
  const docs = { title: 'docs: update guide', headRef: 'docs/guide' };

  it('allows Markdown anywhere and anything under docs/', () => {
    const r = run({ pr: docs, files: [{ filename: 'README.md' }, { filename: 'docs/img/a.png' }] });
    assert.deepEqual(r.errors, []);
  });

  it('lists the non-docs files', () => {
    const r = run({ pr: docs, files: [{ filename: 'docs/a.md' }, { filename: 'src/a.ts' }] });
    assert.ok(hasError(r, /Docs: .*These files do not: `src\/a.ts`/));
  });

  it('checks the old path of a rename', () => {
    const r = run({ pr: docs, files: [{ filename: 'docs/a.ts', previous_filename: 'src/a.ts' }] });
    assert.ok(hasError(r, /`src\/a.ts`/));
  });

  it('honours per-repo docs_paths', () => {
    const r = run({
      pr: docs,
      files: [{ filename: 'website/content/a.mdx' }],
      configText: 'docs_paths:\n  - "website/content/**"\n',
    });
    assert.deepEqual(r.errors, []);
  });

  it('fails when the file list is truncated', () => {
    const r = run({ pr: { ...docs, changedFiles: 3001 }, files: [{ filename: 'a.md' }] });
    assert.ok(hasError(r, /cannot be verified as docs-only/));
  });

  it('does not apply to other types', () => {
    assert.deepEqual(run({ files: [{ filename: 'src/a.ts' }] }).errors, []);
  });
});

describe('evaluate: merge commits', () => {
  it('flags merge commits with sha and subject', () => {
    const r = run({ commits: [commit('aaaaaaa1'), commit('ccccccc1', 2, "Merge branch 'development' into fix/x\n\nbody")] });
    assert.ok(hasError(r, /1 merge commit\(s\): ccccccc "Merge branch 'development' into fix\/x".*git rebase origin\/development/));
  });

  it('fails when the commit list is capped', () => {
    const r = run({ pr: { commits: 300 } });
    assert.ok(hasError(r, /300 commits.*at most 250/));
  });
});

describe('evaluate: path floor', () => {
  it('raises difficulty to high for a sensitive path', () => {
    const r = run({ files: [{ filename: 'supabase/migrations/001.sql' }] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.outputs.difficulty, 'high');
    assert.equal(r.outputs.sensitive, 'true');
    assert.equal(r.declaredDifficulty, 'medium');
    assert.ok(r.notes.some((n) => /raised from medium to high/.test(n)));
  });

  it('keeps critical when declared', () => {
    const body = TEMPLATE_BODY.replace('Difficulty: medium', 'Difficulty: critical');
    const r = run({ pr: { body }, files: [{ filename: 'src/auth/x.ts' }] });
    assert.equal(r.outputs.difficulty, 'critical');
  });

  it('uses high when the declaration is missing but a sensitive path is touched', () => {
    const r = run({ pr: { body: '## Changes\nx\n## Affected areas\ny' }, files: [{ filename: 'infra/a.tf' }] });
    assert.equal(r.outputs.difficulty, 'high');
    assert.ok(hasError(r, /Difficulty/));
  });

  it('adds per-repo sensitive_paths to the defaults', () => {
    const configText = 'sensitive_paths:\n  - "src/lib/repositories/**"\n';
    const r = run({ files: [{ filename: 'src/lib/repositories/media.ts' }], configText });
    assert.equal(r.outputs.difficulty, 'high');
    const d = run({ files: [{ filename: '.github/workflows/x.yml' }], configText });
    assert.equal(d.outputs.difficulty, 'high');
  });

  it('matches the old path of a rename', () => {
    const r = run({ files: [{ filename: 'src/old.ts', previous_filename: 'src/billing/x.ts' }] });
    assert.equal(r.outputs.sensitive, 'true');
  });

  it('treats a truncated file list as sensitive', () => {
    const r = run({ pr: { changedFiles: 4000 } });
    assert.equal(r.outputs.sensitive, 'true');
    assert.equal(r.outputs.difficulty, 'high');
  });

  it('reports an invalid config and falls back to defaults', () => {
    const r = run({ configText: 'sensitive: x', files: [{ filename: 'src/auth/a.ts' }] });
    assert.ok(hasError(r, /Config: .github\/pr-policy.yml on base branch "development" is invalid \(line 1: unknown key/));
    assert.equal(r.outputs.difficulty, 'high');
  });
});

describe('evaluate: release PRs', () => {
  const release = {
    title: 'release: 2026-11-25',
    headRef: 'development',
    baseRef: 'main',
    body: '## Changes\nShip it.\n## Affected areas\nEverything.\n',
  };

  it('skips branch, difficulty and merge-commit checks', () => {
    const r = run({ pr: release, commits: [commit('ddddddd1', 2, 'Merge pull request #1')] });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.outputs, { type: 'release', difficulty: '', sensitive: 'false', is_release: 'true' });
  });

  it('still requires Changes and Affected areas', () => {
    const r = run({ pr: { ...release, body: '' } });
    assert.ok(hasError(r, /Changes/));
    assert.ok(hasError(r, /Affected areas/));
  });

  it('requires the release title', () => {
    const r = run({ pr: { ...release, title: 'fix: something' } });
    assert.ok(hasError(r, /must be titled "release: <summary>"/));
  });

  it('applies the path floor', () => {
    const r = run({ pr: release, files: [{ filename: 'src/payments/a.ts' }] });
    assert.equal(r.outputs.difficulty, 'high');
  });

  it('is not a release from a fork branch named development', () => {
    const r = run({ pr: { ...release, headRepo: 'someone/app' } });
    assert.equal(r.outputs.is_release, 'false');
    assert.ok(hasError(r, /only for PRs from development into main/));
  });

  it('rejects release titles elsewhere', () => {
    const r = run({ pr: { title: 'release: x' } });
    assert.ok(hasError(r, /only for PRs from development into main/));
  });
});

describe('formatSummary', () => {
  it('numbers every error and shows outputs', () => {
    const md = formatSummary(run({ pr: { title: 'x', headRef: 'y' } }), 'o/r#1');
    assert.match(md, /## PR policy: FAILED \(o\/r#1\)/);
    assert.match(md, /^1\. Title:/m);
    assert.match(md, /^2\. Branch:/m);
    assert.match(md, /\| difficulty \| `medium` \|/);
    assert.match(formatSummary(run()), /PR policy: passed/);
  });
});

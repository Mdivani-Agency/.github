import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluate } from './policy.mjs';
import {
  AGAIN_LABEL,
  MAX_REVIEWS,
  classifyThreads,
  maxDifficulty,
  reviewLabel,
  formatReviewSummary,
  normalizeLogin,
  oneLine,
  REVIEW_LEVELS,
  reviewCommand,
  reviewPlan,
  reviewPrompt,
  reviewReplyResult,
  workflowPathFromRef,
} from './review-plan.mjs';

const PR_URL = 'https://github.com/Mdivani-Agency/app/pull/7';
const CONFIGURED = { hasToken: true, modelLow: 'model-low', modelHigh: 'model-high' };

const body = (difficulty) => `## Changes
Change things.

## Affected areas
Login page.

## Difficulty
${difficulty === null ? '' : `Difficulty: ${difficulty}`}
`;

/** Build a plan from PR-like data, running the real policy for the difficulty. */
function plan({
  title = 'fix: refresh session',
  difficulty = 'medium',
  files = ['src/app/page.tsx'],
  headRef = 'fix/session-refresh',
  baseRef = 'development',
  headRepo = 'Mdivani-Agency/app',
  draft = false,
  state = 'open',
  action = 'opened',
  eventName = 'pull_request',
  actor = 'dev',
  config = CONFIGURED,
  workflowPath = '.github/workflows/claude-review.yml',
  label = '',
  labels = [],
  history = undefined,
} = {}) {
  const fileItems = files.map((filename) => ({ filename }));
  const policy = evaluate({
    pr: {
      title,
      body: body(difficulty),
      headRef,
      baseRef,
      headRepo,
      baseRepo: 'Mdivani-Agency/app',
      commits: 1,
      changedFiles: fileItems.length,
    },
    files: fileItems,
  });
  return reviewPlan({
    eventName,
    action,
    actor,
    pr: { number: 7, url: PR_URL, state, draft, headRepo, baseRepo: 'Mdivani-Agency/app' },
    policy,
    files: fileItems,
    config,
    workflowPath,
    label,
    labels,
    history,
  });
}

describe('review plan: tiers', () => {
  it('low -> LOW tier, low level, no extras', () => {
    const p = plan({ difficulty: 'low' });
    assert.equal(p.skip, false);
    assert.equal(p.review, true);
    assert.equal(p.followUp, false);
    assert.equal(p.tier, 'low');
    assert.equal(p.model, 'model-low');
    assert.equal(p.level, 'low');
    assert.equal(p.security, false);
    assert.equal(p.migrationReview, false);
    assert.equal(p.reviewCommand, '/code-review low --comment 7');
  });

  it('medium -> HIGH tier, low level, no extras', () => {
    const p = plan({ difficulty: 'medium' });
    assert.equal(p.tier, 'high');
    assert.equal(p.model, 'model-high');
    assert.equal(p.level, 'low');
    assert.equal(p.security, false);
    assert.equal(p.migrationReview, false);
    assert.equal(p.reviewCommand, '/code-review low --comment 7');
  });

  it('high without a sensitive path -> HIGH tier, medium level, no security review', () => {
    const p = plan({ difficulty: 'high' });
    assert.equal(p.tier, 'high');
    assert.equal(p.level, 'medium');
    assert.equal(p.security, false);
    assert.equal(p.migrationReview, false);
  });

  it('high with a sensitive path -> security review', () => {
    const p = plan({ difficulty: 'high', files: ['src/auth/login.ts'] });
    assert.equal(p.level, 'medium');
    assert.equal(p.security, true);
    assert.match(p.securityReason, /sensitive/);
    assert.equal(p.migrationReview, false);
  });

  it('medium on a sensitive path is raised to high and gets the security review', () => {
    const p = plan({ difficulty: 'medium', files: ['src/billing/charge.ts'] });
    assert.equal(p.difficulty, 'high');
    assert.equal(p.level, 'medium');
    assert.equal(p.security, true);
    assert.ok(p.notes.some((n) => /raised to high/.test(n)));
  });

  it('high touching migrations -> security review but no migration review', () => {
    const p = plan({ difficulty: 'high', files: ['supabase/migrations/20261125_a.sql'] });
    assert.equal(p.security, true);
    assert.equal(p.migrationReview, false);
  });

  it('critical -> security review always, no migration review without migrations', () => {
    const p = plan({ difficulty: 'critical' });
    assert.equal(p.tier, 'high');
    assert.equal(p.level, 'high');
    assert.equal(p.reviewCommand, '/code-review high --comment 7');
    assert.equal(p.security, true);
    assert.equal(p.securityReason, 'critical difficulty');
    assert.equal(p.migrationReview, false);
  });

  it('critical touching supabase/migrations -> migration review', () => {
    for (const path of ['supabase/migrations/20261125_a.sql', 'apps/api/supabase/migrations/x.sql']) {
      const p = plan({ difficulty: 'critical', files: ['src/a.ts', path] });
      assert.equal(p.migrationReview, true, path);
      assert.equal(p.security, true);
    }
  });

  it('migration detection ignores look-alike paths', () => {
    for (const path of ['supabase/seed.sql', 'docs/supabase-migrations.md', 'migrations/a.sql']) {
      assert.equal(plan({ difficulty: 'critical', files: [path] }).migrationReview, false, path);
    }
  });

  it('renamed-from migration path counts', () => {
    const policy = evaluate({
      pr: { title: 'fix: x', body: body('critical'), headRef: 'fix/x', baseRef: 'development', headRepo: 'o/r', baseRepo: 'o/r' },
      files: [{ filename: 'db/old.sql', previous_filename: 'supabase/migrations/old.sql' }],
    });
    const p = reviewPlan({
      eventName: 'pull_request',
      action: 'opened',
      pr: { number: 1, url: PR_URL, state: 'open', draft: false, headRepo: 'o/r', baseRepo: 'o/r' },
      policy,
      files: [{ filename: 'db/old.sql', previous_filename: 'supabase/migrations/old.sql' }],
      config: CONFIGURED,
    });
    assert.equal(p.migrationReview, true);
  });
});

describe('review plan: docs', () => {
  it('docs PRs use the LOW tier whatever the declared difficulty', () => {
    for (const difficulty of ['low', 'medium', 'high', 'critical']) {
      const p = plan({ title: 'docs: update readme', headRef: 'docs/readme', difficulty, files: ['README.md'] });
      assert.equal(p.tier, 'low', difficulty);
      assert.equal(p.model, 'model-low');
      assert.equal(p.level, 'low');
      assert.equal(p.security, false);
      assert.equal(p.migrationReview, false);
    }
  });

  it('notes when a docs PR declared more than low', () => {
    const p = plan({ title: 'docs: update readme', headRef: 'docs/readme', difficulty: 'high', files: ['README.md'] });
    assert.ok(p.notes.some((n) => /docs PR/.test(n)));
  });
});

describe('review plan: missing or invalid difficulty', () => {
  it('missing difficulty and no sensitive path -> medium, with a note', () => {
    const p = plan({ difficulty: null });
    assert.equal(p.difficulty, 'medium');
    assert.equal(p.tier, 'high');
    assert.equal(p.level, 'low');
    assert.ok(p.notes.some((n) => /using medium/.test(n)));
  });

  it('invalid difficulty -> medium, with a note', () => {
    const p = plan({ difficulty: 'huge' });
    assert.equal(p.difficulty, 'medium');
    assert.ok(p.notes.some((n) => /No valid "Difficulty:" line/.test(n)));
  });

  it('missing difficulty on a sensitive path -> path floor (high)', () => {
    const p = plan({ difficulty: null, files: ['.github/workflows/ci.yml'] });
    assert.equal(p.difficulty, 'high');
    assert.equal(p.level, 'medium');
    assert.equal(p.security, true);
    assert.ok(p.notes.some((n) => /sensitive-path floor \(high\)/.test(n)));
  });

  it('a declared difficulty adds no note', () => {
    assert.deepEqual(plan({ difficulty: 'medium' }).notes, []);
  });
});

describe('review plan: skips', () => {
  it('skips release PRs (development -> main, same repo)', () => {
    const p = plan({ title: 'release: 2026-11-25', headRef: 'development', baseRef: 'main' });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /release PR/);
  });

  it('does not skip a feature branch into main or a sub-PR into a feature branch', () => {
    assert.equal(plan({ headRef: 'fix/x', baseRef: 'main' }).skip, false);
    assert.equal(plan({ headRef: 'fix/part-1', baseRef: 'feature/big-thing' }).skip, false);
  });

  it('skips drafts', () => {
    const p = plan({ draft: true });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /draft/);
  });

  it('skips the closed action and closed PRs', () => {
    assert.match(plan({ action: 'closed' }).skipReason, /"closed" event/);
    assert.match(plan({ state: 'closed' }).skipReason, /closed/);
  });

  it('skips fork PRs before checking configuration', () => {
    const p = plan({ headRepo: 'someone/app', config: { hasToken: false, modelLow: '', modelHigh: '' } });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /fork/);
    assert.equal(p.warning, '');
  });

  it('skips a fork whose repository was deleted', () => {
    const p = plan({ headRepo: null });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /fork/);
  });

  it('skips non pull_request events', () => {
    const p = plan({ eventName: 'push' });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /not a pull_request event/);
  });

  it('skips runs triggered by bots', () => {
    const p = plan({ actor: 'dependabot[bot]' });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /bot/);
  });

  it('skips a PR that changes the calling workflow, with a status comment', () => {
    // MDI-798: claude-code-action refuses to run when the caller workflow differs from the default branch.
    const p = plan({ files: ['src/a.ts', '.github/workflows/claude-review.yml'] });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /this PR changes the review workflow \(\.github\/workflows\/claude-review\.yml\)/);
    assert.match(p.statusComment, /^review skipped: this PR changes the review workflow/);
    assert.equal(p.warning, '');
  });

  it('detects a renamed caller workflow and a caller with another name', () => {
    const renamed = reviewPlan({
      eventName: 'pull_request',
      action: 'synchronize',
      pr: { number: 7, url: PR_URL, state: 'open', draft: false, headRepo: 'o/r', baseRepo: 'o/r' },
      policy: { outputs: { type: 'feature', difficulty: 'medium', sensitive: 'false', is_release: 'false' }, declaredDifficulty: 'medium' },
      files: [{ filename: '.github/workflows/review.yml', previous_filename: '.github/workflows/ai.yml' }],
      config: CONFIGURED,
      workflowPath: '.github/workflows/ai.yml',
    });
    assert.equal(renamed.skip, true);
    assert.equal(plan({ files: ['.github/workflows/ci.yml'] }).skip, false);
    assert.equal(plan({ files: ['.github/workflows/claude-review.yml'], workflowPath: '' }).skip, false);
  });

  it('reports a missing configuration before a workflow change', () => {
    const p = plan({ files: ['.github/workflows/claude-review.yml'], config: { ...CONFIGURED, hasToken: false } });
    assert.match(p.skipReason, /not configured/);
    assert.equal(p.statusComment, '');
  });

  it('other skips and reviews carry no status comment', () => {
    assert.equal(plan({ draft: true }).statusComment, '');
    assert.equal(plan().statusComment, '');
  });

  it('reviews every push, even when Claude already commented', () => {
    const p = plan({ action: 'synchronize' });
    assert.equal(p.skip, false);
    assert.equal(p.resolveThreads, true);
    assert.equal(plan({ action: 'opened' }).resolveThreads, false);
    assert.equal(plan({ action: 'reopened' }).resolveThreads, false);
    assert.equal(plan({ action: 'ready_for_review' }).resolveThreads, false);
  });
});

describe('review plan: follow-ups and the review limit', () => {
  const after = (reviews, difficulty = 'medium') => ({ reviews, difficulty });

  it('follow-ups run at the low level on the same tier', () => {
    for (const [difficulty, tier] of [['low', 'low'], ['medium', 'high'], ['high', 'high'], ['critical', 'high']]) {
      const p = plan({ difficulty, action: 'synchronize', history: after(1, difficulty) });
      assert.equal(p.review, true, difficulty);
      assert.equal(p.followUp, true);
      assert.equal(p.tier, tier);
      assert.equal(p.level, 'low');
      assert.equal(p.reviewCommand, '/code-review low --comment 7');
      assert.equal(p.reviewNumber, 2);
      assert.equal(reviewLabel(p), 'follow-up 1 of 2');
    }
  });

  it('follow-ups keep the security and migration reviews', () => {
    const p = plan({ difficulty: 'critical', action: 'synchronize', files: ['supabase/migrations/1.sql'], history: after(2, 'critical') });
    assert.equal(p.level, 'low');
    assert.equal(p.security, true);
    assert.equal(p.migrationReview, true);
    assert.equal(reviewLabel(p), 'follow-up 2 of 2');
  });

  it('no history is a first review', () => {
    const p = plan({ difficulty: 'high', action: 'synchronize' });
    assert.equal(p.followUp, false);
    assert.equal(p.level, 'medium');
    assert.equal(reviewLabel(p), 'first review');
  });

  it('after the first review and 2 follow-ups, no review runs; threads still resolve on a push', () => {
    const p = plan({ difficulty: 'critical', action: 'synchronize', files: ['supabase/migrations/1.sql'], history: after(MAX_REVIEWS, 'critical') });
    assert.equal(p.skip, false);
    assert.equal(p.review, false);
    assert.equal(p.limitReached, true);
    assert.equal(p.resolveThreads, true);
    assert.equal(p.reviewCommand, '');
    assert.equal(p.security, false);
    assert.equal(p.migrationReview, false);
    assert.equal(p.model, 'model-high');
    assert.match(p.statusComment, /review limit reached: 3 reviews.*`claude-review:again`/);
    assert.match(formatReviewSummary(p), /no review, review limit reached/);
    assert.equal(reviewLabel(p), 'none (limit reached after 3 reviews)');
  });

  it('the claude-review:again label allows one more review', () => {
    const p = plan({ difficulty: 'medium', action: 'synchronize', labels: ['bug', AGAIN_LABEL], history: after(3) });
    assert.equal(p.review, true);
    assert.equal(p.againLabel, true);
    assert.equal(p.level, 'low');
    assert.equal(p.reviewNumber, 4);
    assert.equal(reviewLabel(p), 'extra follow-up 3');
    assert.ok(p.notes.some((n) => /label allows one more/.test(n)));
  });

  it('a difficulty above every earlier review allows one more review', () => {
    const raised = plan({ difficulty: 'critical', action: 'synchronize', history: after(3, 'high') });
    assert.equal(raised.review, true);
    assert.equal(raised.level, 'low');
    assert.ok(raised.notes.some((n) => /difficulty raised to critical/.test(n)));
    assert.equal(plan({ difficulty: 'high', action: 'synchronize', history: after(3, 'high') }).review, false);
    assert.equal(plan({ difficulty: 'medium', action: 'synchronize', history: after(4, 'critical') }).review, false);
  });

  it('adding the claude-review:again label starts a review; other labels are skipped', () => {
    const again = plan({ action: 'labeled', label: AGAIN_LABEL, labels: [AGAIN_LABEL], history: after(3) });
    assert.equal(again.skip, false);
    assert.equal(again.review, true);
    assert.equal(again.resolveThreads, false);
    const other = plan({ action: 'labeled', label: 'difficulty:high', labels: ['difficulty:high'] });
    assert.equal(other.skip, true);
    assert.match(other.skipReason, /not claude-review:again/);
  });

  it('drafts are never reviewed, also when the label is added', () => {
    const p = plan({ draft: true, action: 'labeled', label: AGAIN_LABEL, labels: [AGAIN_LABEL], history: after(3) });
    assert.equal(p.skip, true);
    assert.match(p.skipReason, /draft/);
  });

  it('maxDifficulty keeps the higher valid difficulty', () => {
    assert.equal(maxDifficulty('', 'medium'), 'medium');
    assert.equal(maxDifficulty('critical', 'high'), 'critical');
    assert.equal(maxDifficulty('low', 'huge'), 'low');
    assert.equal(maxDifficulty('', ''), '');
  });
});

describe('review plan: configuration', () => {
  it('warns and skips when the token is missing, naming the secret', () => {
    const p = plan({ config: { ...CONFIGURED, hasToken: false } });
    assert.equal(p.skip, true);
    assert.match(p.warning, /org secret CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(p.warning, /CLAUDE_REVIEW_MODEL/);
  });

  it('warns and skips when a model variable is missing, naming it', () => {
    const low = plan({ config: { ...CONFIGURED, modelLow: '' } });
    assert.equal(low.skip, true);
    assert.match(low.warning, /CLAUDE_REVIEW_MODEL_LOW/);
    assert.doesNotMatch(low.warning, /CLAUDE_REVIEW_MODEL_HIGH|OAUTH/);
    const high = plan({ config: { ...CONFIGURED, modelHigh: '' } });
    assert.match(high.warning, /CLAUDE_REVIEW_MODEL_HIGH/);
  });

  it('names everything missing at once', () => {
    const p = plan({ config: { hasToken: false, modelLow: '', modelHigh: '' } });
    assert.match(p.warning, /CLAUDE_CODE_OAUTH_TOKEN.*CLAUDE_REVIEW_MODEL_LOW.*CLAUDE_REVIEW_MODEL_HIGH/);
    assert.match(p.warning, /advisory/);
  });

  it('release, draft and fork skips win over a missing configuration', () => {
    const none = { hasToken: false, modelLow: '', modelHigh: '' };
    assert.equal(plan({ draft: true, config: none }).warning, '');
    assert.equal(plan({ title: 'release: x', headRef: 'development', baseRef: 'main', config: none }).warning, '');
  });
});

describe('review threads', () => {
  const thread = (over = {}) => ({
    id: 'T1',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 10,
    originalLine: 9,
    resolvedBy: null,
    comments: {
      nodes: [
        {
          author: { login: 'claude' },
          body: '**Bug:** `x` can be null here\n\nMore detail.',
          url: 'https://github.com/o/r/pull/1#discussion_r1',
          createdAt: '2026-11-25T10:00:00Z',
          originalCommit: { oid: 'aaa' },
        },
      ],
    },
    ...over,
  });
  const by = (login, extra = {}) => ({
    comments: { nodes: [{ ...thread().comments.nodes[0], author: { login }, ...extra }] },
  });

  it('normalizes the bot login', () => {
    assert.equal(normalizeLogin('claude[bot]'), 'claude');
    assert.equal(normalizeLogin('Claude'), 'claude');
    assert.equal(normalizeLogin(undefined), '');
  });

  it('keeps unresolved Claude threads as open, ignores other authors', () => {
    const { open, resolvedByPeople } = classifyThreads([
      thread(),
      thread({ id: 'T2', ...by('claude[bot]') }),
      thread({ id: 'T3', ...by('alice') }),
      thread({ id: 'T4', comments: { nodes: [] } }),
    ]);
    assert.deepEqual(open.map((t) => t.id), ['T1', 'T2']);
    assert.equal(resolvedByPeople.length, 0);
    assert.equal(open[0].summary, 'Bug: x can be null here');
    assert.equal(open[0].line, 10);
  });

  it('splits resolved Claude threads by who resolved them', () => {
    const { open, resolvedByPeople } = classifyThreads([
      thread({ id: 'P', isResolved: true, resolvedBy: { login: 'alice' } }),
      thread({ id: 'C', isResolved: true, resolvedBy: { login: 'claude' } }),
      thread({ id: 'X', isResolved: true, resolvedBy: { login: 'bob' }, ...by('bob') }),
    ]);
    assert.equal(open.length, 0);
    assert.deepEqual(resolvedByPeople.map((t) => [t.id, t.resolvedBy]), [['P', 'alice']]);
  });

  it('falls back to the original line for outdated threads', () => {
    const { open } = classifyThreads([thread({ line: null, isOutdated: true })]);
    assert.equal(open[0].line, 9);
    assert.equal(open[0].outdated, true);
  });

  it('finds the commit of the latest Claude thread', () => {
    const { lastReviewedSha } = classifyThreads([
      thread(),
      thread({ id: 'T2', ...by('claude', { createdAt: '2026-11-25T12:00:00Z', originalCommit: { oid: 'bbb' } }) }),
      thread({ id: 'T3', ...by('alice', { createdAt: '2026-11-26T12:00:00Z', originalCommit: { oid: 'ccc' } }) }),
    ]);
    assert.equal(lastReviewedSha, 'bbb');
  });

  it('honours a custom bot login', () => {
    const { open } = classifyThreads([thread(), thread({ id: 'T2', ...by('my-app[bot]') })], 'my-app[bot]');
    assert.deepEqual(open.map((t) => t.id), ['T2']);
  });

  it('oneLine strips markup, control characters and code fences, and truncates', () => {
    assert.equal(oneLine('```ts\ncode\n```\n## Title `x`\nrest'), 'Title x');
    assert.equal(oneLine('a\u0007b'), 'a b');
    assert.equal(oneLine('x'.repeat(200), 20).length, 20);
    assert.equal(oneLine(''), '');
  });
});

describe('workflow path from GITHUB_WORKFLOW_REF', () => {
  it('strips the repository and the ref', () => {
    assert.equal(
      workflowPathFromRef('Mdivani-Agency/talvio-web-app/.github/workflows/claude-review.yml@refs/pull/314/merge', 'Mdivani-Agency/talvio-web-app'),
      '.github/workflows/claude-review.yml',
    );
    assert.equal(workflowPathFromRef('o/r/.github/workflows/x.yml@refs/heads/main'), '.github/workflows/x.yml');
  });

  it('returns an empty path for a missing ref', () => {
    assert.equal(workflowPathFromRef(undefined), '');
    assert.equal(workflowPathFromRef(''), '');
  });
});

describe('review command', () => {
  it('uses the built-in skill with the level and the PR number, never the plugin, ultra or --fix', () => {
    for (const difficulty of ['low', 'medium', 'high', 'critical']) {
      const p = plan({ difficulty });
      assert.match(p.reviewCommand, /^\/code-review (low|medium|high) --comment 7$/, difficulty);
      assert.doesNotMatch(p.reviewCommand, /code-review:code-review|ultra|--fix/);
    }
    const docs = plan({ title: 'docs: update readme', headRef: 'docs/readme', difficulty: 'critical', files: ['README.md'] });
    assert.equal(docs.reviewCommand, '/code-review low --comment 7');
  });

  it('rejects ultra and unknown levels, and bad PR numbers', () => {
    assert.ok(!REVIEW_LEVELS.includes('ultra'));
    assert.throws(() => reviewCommand('ultra', 7), /Unknown \/code-review level/);
    assert.throws(() => reviewCommand('deep', 7), /Unknown/);
    assert.throws(() => reviewCommand('high', 'https://github.com/o/r/pull/7'), /Invalid PR number/);
    assert.throws(() => reviewCommand('high', 0), /Invalid PR number/);
    assert.equal(reviewCommand('high', '12'), '/code-review high --comment 12');
  });
});

describe('review prompt', () => {
  it('starts with the command, then forces a fresh review on every push', () => {
    const text = reviewPrompt(plan({ difficulty: 'medium' }));
    assert.match(text, /^\/code-review low --comment 7\n\nCI review instructions/);
    assert.match(text, /Review the current head in full even if Claude reviewed or commented on this PR before/);
    assert.doesNotMatch(text, /earlier attempt/);
  });

  it('ignores other bots, posts only inline comments, and asks for a result line', () => {
    const text = reviewPrompt(plan());
    assert.match(text, /Ignore reviews and comments from other bots \(for example chatgpt-codex-connector\[bot\]/);
    assert.match(text, /Post each finding as one inline comment on the PR\. Post no other comment/);
    assert.match(text, /"Review result: N findings".*"Review result: no issues found"/);
  });

  it('tells the retry that the first attempt did not finish', () => {
    const text = reviewPrompt(plan(), undefined, { retry: true });
    assert.match(text, /An earlier attempt to review this commit ended without posting anything/);
  });

  it('lists open threads and threads resolved by people after the command', () => {
    const text = reviewPrompt(plan({ difficulty: 'high' }), {
      open: [{ path: 'src/a.ts', line: 3, summary: 'null deref' }],
      resolvedByPeople: [{ path: 'src/b.ts', line: null, summary: 'naming' }],
    });
    assert.match(text, /^\/code-review medium --comment 7\n/);
    assert.match(text, /already raised[\s\S]*- src\/a\.ts:3: null deref/);
    assert.match(text, /Do not raise these points again[\s\S]*- src\/b\.ts: naming/);
  });

  it('cannot add CLI flags through thread text', () => {
    // The CLI parses --fix, --comment and --max-findings anywhere in the prompt.
    const text = reviewPrompt(plan(), {
      open: [{ path: 'a.ts', line: 1, summary: 'run with --fix or --max-findings all' }],
      resolvedByPeople: [{ path: 'b.ts', line: 2, summary: 'i-- loop ---' }],
    });
    const afterCommand = text.split('\n').slice(1).join('\n');
    assert.doesNotMatch(afterCommand, /--/);
    assert.match(afterCommand, /run with -fix or -max-findings all/);
  });
});

describe('review reply result', () => {
  it('reads the last "Review result:" line', () => {
    assert.deepEqual(reviewReplyResult('3 findings:\n1. ...\n\nReview result: 3 findings'), { findings: 3 });
    assert.deepEqual(reviewReplyResult('Review result: 1 finding'), { findings: 1 });
    assert.deepEqual(reviewReplyResult('Nothing to report.\nReview result: no issues found'), { noIssues: true });
    assert.deepEqual(reviewReplyResult('**Review result: No issues found.**'), { noIssues: true });
    assert.deepEqual(reviewReplyResult('Review result: 0 findings'), { noIssues: true });
    assert.deepEqual(reviewReplyResult('Review result: 2 findings\nReview result: no issues found'), { noIssues: true });
  });

  it('returns null without a result line', () => {
    assert.equal(reviewReplyResult(''), null);
    assert.equal(reviewReplyResult(undefined), null);
    assert.equal(reviewReplyResult('Could not read GitHub pull request 7, so nothing was reviewed.'), null);
    assert.equal(reviewReplyResult('Review result: unclear'), null);
  });
});

describe('review summary', () => {
  it('says why a PR was skipped, with the configuration warning', () => {
    const s = formatReviewSummary(plan({ config: { ...CONFIGURED, modelHigh: '' } }), 'o/r#7');
    assert.match(s, /Claude review: skipped \(o\/r#7\)/);
    assert.match(s, /Reason: not configured: missing org Actions variable CLAUDE_REVIEW_MODEL_HIGH/);
    assert.match(s, /\[!WARNING\]/);
  });

  it('shows tier, level, the command and extras, never a model ID', () => {
    const p = plan({ difficulty: 'critical', files: ['supabase/migrations/a.sql'], action: 'synchronize' });
    const s = formatReviewSummary(p, 'o/r#7', { open: [{}], resolvedByPeople: [] });
    assert.match(s, /high tier, high level/);
    assert.match(s, /Code review \| `\/code-review high --comment 7`/);
    assert.match(s, /Security review \| yes \(critical difficulty\)/);
    assert.match(s, /Migration review \| yes/);
    assert.match(s, /1 open Claude thread/);
    assert.doesNotMatch(s, /model-high|model-low/);
  });
});

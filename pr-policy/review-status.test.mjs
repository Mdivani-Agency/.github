import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RESULTS,
  STATUS_MARKER,
  claudeOutputSince,
  codeReviewText,
  countResolvedByClaude,
  extraReviewText,
  findStatusComment,
  findingStep,
  reviewResult,
  statusCommentBody,
  transcriptSummary,
} from './review-status.mjs';

const SINCE = '2026-11-25T10:00:00Z';
const claude = { login: 'claude[bot]' };
const codex = { login: 'chatgpt-codex-connector[bot]' };

describe('was anything posted', () => {
  it('counts a Claude summary comment posted since the start', () => {
    const out = claudeOutputSince({ issueComments: [{ user: claude, created_at: '2026-11-25T10:05:00Z' }] }, SINCE);
    assert.equal(out.posted, true);
    assert.equal(out.summaries, 1);
    assert.equal(out.findings, 0);
  });

  it('a thread reply alone is not review output', () => {
    const out = claudeOutputSince({ reviewComments: [{ user: claude, created_at: '2026-11-25T10:01:00Z', in_reply_to_id: 1 }] }, SINCE);
    assert.equal(out.posted, false);
    assert.equal(out.replies, 1);
  });

  it('counts Claude inline findings, and thread replies apart', () => {
    const out = claudeOutputSince(
      {
        reviewComments: [
          { user: claude, created_at: '2026-11-25T10:00:00Z' },
          { user: claude, created_at: '2026-11-25T10:01:00Z' },
          { user: claude, created_at: '2026-11-25T10:02:00Z', in_reply_to_id: 1 },
        ],
      },
      SINCE,
    );
    assert.deepEqual(out, { posted: true, findings: 2, byStep: { code: 2, security: 0, migration: 0 }, replies: 1, summaries: 0, reviews: 0 });
  });

  it('counts a Claude review', () => {
    const out = claudeOutputSince({ reviews: [{ user: { login: 'claude' }, submitted_at: '2026-11-25T10:03:00Z' }] }, SINCE);
    assert.equal(out.posted, true);
    assert.equal(out.reviews, 1);
  });

  it('ignores another bot, people and the status comment', () => {
    const out = claudeOutputSince(
      {
        issueComments: [
          { user: codex, created_at: '2026-11-25T10:05:00Z' },
          { user: { login: 'github-actions[bot]' }, created_at: '2026-11-25T10:06:00Z', body: STATUS_MARKER },
          { user: { login: 'dev' }, created_at: '2026-11-25T10:07:00Z' },
        ],
        reviews: [{ user: codex, submitted_at: '2026-11-25T10:05:00Z' }],
        reviewComments: [{ user: codex, created_at: '2026-11-25T10:05:00Z' }],
      },
      SINCE,
    );
    assert.equal(out.posted, false);
  });

  it('ignores Claude output from before the start', () => {
    const out = claudeOutputSince(
      {
        issueComments: [{ user: claude, created_at: '2026-11-25T09:59:59Z' }],
        reviewComments: [{ user: claude, created_at: '2026-11-24T10:00:00Z' }],
        reviews: [{ user: claude, submitted_at: '2026-11-25T09:00:00Z' }, { user: claude, submitted_at: null }],
      },
      SINCE,
    );
    assert.equal(out.posted, false);
  });

  it('nothing posted at all', () => {
    assert.equal(claudeOutputSince({}, SINCE).posted, false);
  });
});

describe('review result', () => {
  it('posted, empty and failed', () => {
    assert.equal(reviewResult({ outcome: 'success', conclusion: 'success', posted: true }), RESULTS.posted);
    assert.equal(reviewResult({ outcome: 'success', conclusion: 'success', posted: false }), RESULTS.empty);
    assert.equal(reviewResult({ outcome: 'failure', conclusion: 'failure', posted: true }), RESULTS.failed);
    assert.equal(reviewResult({ outcome: 'cancelled', posted: false }), RESULTS.failed);
  });

  it('detects the action skipping itself on workflow validation', () => {
    // run.ts returns before setting conclusion or github_token.
    assert.equal(reviewResult({ outcome: 'success', conclusion: '', hasAppToken: false, posted: false }), RESULTS.workflowSkip);
    assert.equal(reviewResult({ outcome: 'success', conclusion: '', hasAppToken: true, posted: false }), RESULTS.empty);
  });

  it('does not fail a PR that was closed or turned into a draft during the run', () => {
    assert.equal(reviewResult({ outcome: 'success', conclusion: 'success', posted: false, reviewable: false }), RESULTS.notReviewable);
  });

  it('counts "no issues" from the reply as a result, not as empty', () => {
    // MDI-800: the built-in skill posts nothing when it finds nothing.
    assert.equal(reviewResult({ outcome: 'success', conclusion: 'success', posted: false, noIssues: true }), RESULTS.noIssues);
    assert.equal(reviewResult({ outcome: 'success', conclusion: 'success', posted: true, noIssues: true }), RESULTS.posted);
    assert.equal(reviewResult({ outcome: 'failure', conclusion: 'failure', posted: false, noIssues: true }), RESULTS.failed);
  });
});

describe('findings by step', () => {
  it('attributes inline findings by the security and migration prefixes', () => {
    assert.equal(findingStep('Security (high): token leaks'), 'security');
    assert.equal(findingStep('**Security (medium):** x'), 'security');
    assert.equal(findingStep('Migration: drops a column'), 'migration');
    assert.equal(findingStep('🔴 Important: off by one'), 'code');
    assert.equal(findingStep(''), 'code');
  });

  it('splits new Claude inline threads per step', () => {
    const at = '2026-11-25T10:05:00Z';
    const out = claudeOutputSince(
      {
        reviewComments: [
          { id: 1, user: claude, created_at: at, body: 'Migration: lock' },
          { id: 2, user: claude, created_at: at, body: 'Migration: RLS' },
          { id: 3, user: claude, created_at: at, body: 'Null deref' },
          { id: 4, user: claude, created_at: at, body: 'Security (high): x' },
          { id: 5, user: claude, created_at: at, body: 'Migration: reply', in_reply_to_id: 1 },
        ],
      },
      SINCE,
    );
    assert.deepEqual(out.byStep, { code: 1, security: 1, migration: 2 });
    assert.equal(out.findings, 4);
  });
});

describe('code-review transcript', () => {
  const started = {
    type: 'system',
    subtype: 'task_started',
    description: '/code-review',
    prompt: 'Review target: `7 CI review instructions`\n\n`high effort → 4 inline angles (bugs + conventions) → dedup (no verify) → ≤10 findings`\n\nYou are reviewing',
  };
  const result = (text, isError = false) => ({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: text });

  it('reads the reply, its result line and the recipe from a JSON array', () => {
    const t = transcriptSummary(JSON.stringify([{ type: 'system', subtype: 'init' }, started, result('No problems.\nReview result: no issues found')]));
    assert.deepEqual(t.replyResult, { noIssues: true });
    assert.equal(t.recipe, 'high effort → 4 inline angles (bugs + conventions) → dedup (no verify) → ≤10 findings');
    assert.equal(t.isError, false);
  });

  it('reads JSON lines too', () => {
    const t = transcriptSummary([started, result('1. a\nReview result: 2 findings')].map((m) => JSON.stringify(m)).join('\n'));
    assert.deepEqual(t.replyResult, { findings: 2 });
  });

  it('does not trust the reply of a run that ended with an error', () => {
    assert.equal(transcriptSummary(JSON.stringify([result('Review result: no issues found', true)])).replyResult, null);
  });

  it('never throws on a missing or broken transcript', () => {
    assert.deepEqual(transcriptSummary(''), { reply: '', isError: false, replyResult: null, recipe: '' });
    assert.equal(transcriptSummary('{not json').replyResult, null);
  });
});

describe('status comment', () => {
  const plan = { tier: 'high', level: 'high', difficulty: 'critical', model: 'model-high' };
  const sha = '0123456789abcdef';
  const CODE = 'Code review (`/code-review high --comment`)';

  it('finds only the workflow\'s own comment with the marker', () => {
    const comments = [
      { id: 1, user: { login: 'dev' }, body: `copy ${STATUS_MARKER}` },
      { id: 2, user: { login: 'github-actions[bot]' }, body: 'other' },
      { id: 3, user: { login: 'github-actions[bot]' }, body: `${STATUS_MARKER}\nold` },
    ];
    assert.equal(findStatusComment(comments).id, 3);
    assert.equal(findStatusComment([]), null);
  });

  it('says "No issues found" with the short SHA and the code review\'s "no issues"', () => {
    const steps = [{ name: CODE, text: codeReviewText(RESULTS.noIssues, 0) }];
    const body = statusCommentBody({ state: 'reviewed', sha, plan, steps, findings: 0, resolved: 2 });
    assert.ok(body.startsWith(STATUS_MARKER));
    assert.match(body, /No issues found on `0123456`/);
    assert.match(body, /HIGH tier, high level \(difficulty critical\)/);
    assert.match(body, /Model \| `model-high`/);
    assert.match(body, /Code review \(`\/code-review high --comment`\) \| no issues \|/);
    assert.match(body, /Threads resolved by the follow-up \| 2/);
  });

  it('reports each step separately', () => {
    const steps = [
      { name: CODE, text: codeReviewText(RESULTS.posted, 3, true) },
      { name: 'Security review', text: extraReviewText('success', 0) },
      { name: 'Migration review', text: extraReviewText('success', 2) },
    ];
    const body = statusCommentBody({ state: 'reviewed', sha, plan, steps, findings: 5, retried: true });
    assert.match(body, /Reviewed `0123456`\*\*: 5 new findings/);
    assert.match(body, /Code review .*\| 3 findings \|/);
    assert.match(body, /Security review \| no issues \|/);
    assert.match(body, /Migration review \| 2 findings \|/);
    assert.match(body, /Retried \| yes/);
  });

  it('omits steps that did not run', () => {
    const steps = [
      { name: CODE, text: codeReviewText(RESULTS.posted, 1) },
      { name: 'Security review', text: extraReviewText('skipped') },
      { name: 'Migration review', text: extraReviewText('') },
    ];
    const body = statusCommentBody({ state: 'reviewed', sha, plan, steps, findings: 1 });
    assert.doesNotMatch(body, /Security review|Migration review/);
    assert.match(body, /1 new finding,/);
  });

  it('names the failed step and still shows the others (MDI-800, PR 319)', () => {
    // Code review empty after the retry, migration review posted 2 findings.
    const steps = [
      { name: CODE, text: codeReviewText(RESULTS.empty, 0, true) },
      { name: 'Security review', text: extraReviewText('success', 0) },
      { name: 'Migration review', text: extraReviewText('success', 2) },
    ];
    const body = statusCommentBody({
      state: 'failed',
      sha,
      plan,
      steps,
      findings: 2,
      retried: true,
      reason: 'the code review produced no output, also after one retry. See the job log, then re-run the job.',
    });
    assert.match(body, /Failed on `0123456`\*\*: the code review produced no output, also after one retry/);
    assert.match(body, /Code review .*\| no output, also after one retry \|/);
    assert.match(body, /Migration review \| 2 findings \|/);
  });

  it('states a skip with the reason and no table', () => {
    const skipped = statusCommentBody({ state: 'skipped', sha, reason: 'review skipped: this PR changes the review workflow' });
    assert.match(skipped, /Skipped on `0123456`\*\*: review skipped: this PR changes the review workflow/);
    assert.doesNotMatch(skipped, /\| Model/);
  });

  it('step texts', () => {
    assert.equal(codeReviewText(RESULTS.posted, 1), '1 finding');
    assert.equal(codeReviewText(RESULTS.posted, 0), 'posted a comment, no inline findings');
    assert.equal(codeReviewText(RESULTS.noIssues, 0, true), 'no issues (on the retry)');
    assert.equal(codeReviewText(RESULTS.empty, 0), 'no output');
    assert.equal(codeReviewText(RESULTS.failed, 0), 'failed');
    assert.equal(extraReviewText('failure'), 'failed');
    assert.equal(extraReviewText('cancelled'), 'cancelled');
    assert.equal(extraReviewText(undefined), null);
  });
});

describe('threads resolved by the follow-up', () => {
  it('counts only threads that were open before and that Claude resolved', () => {
    const threads = [
      { id: 'a', isResolved: true, resolvedBy: { login: 'claude' } },
      { id: 'b', isResolved: true, resolvedBy: { login: 'dev' } },
      { id: 'c', isResolved: false },
      { id: 'd', isResolved: true, resolvedBy: { login: 'claude' } },
    ];
    assert.equal(countResolvedByClaude(['a', 'b', 'c'], threads), 1);
    assert.equal(countResolvedByClaude([], threads), 0);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RESULTS,
  STATUS_MARKER,
  claudeOutputSince,
  countResolvedByClaude,
  findStatusComment,
  reviewResult,
  statusCommentBody,
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
    assert.deepEqual(out, { posted: true, findings: 2, replies: 1, summaries: 0, reviews: 0 });
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
});

describe('status comment', () => {
  const plan = { tier: 'high', depth: 'high', difficulty: 'critical', model: 'model-high' };
  const sha = '0123456789abcdef';

  it('finds only the workflow\'s own comment with the marker', () => {
    const comments = [
      { id: 1, user: { login: 'dev' }, body: `copy ${STATUS_MARKER}` },
      { id: 2, user: { login: 'github-actions[bot]' }, body: 'other' },
      { id: 3, user: { login: 'github-actions[bot]' }, body: `${STATUS_MARKER}\nold` },
    ];
    assert.equal(findStatusComment(comments).id, 3);
    assert.equal(findStatusComment([]), null);
  });

  it('says "No issues found" with the short SHA', () => {
    const body = statusCommentBody({ state: 'reviewed', sha, plan, findings: 0, resolved: 2 });
    assert.ok(body.startsWith(STATUS_MARKER));
    assert.match(body, /No issues found on `0123456`/);
    assert.match(body, /HIGH tier, high depth \(difficulty critical\)/);
    assert.match(body, /Model \| `model-high`/);
    assert.match(body, /Threads resolved by the follow-up \| 2/);
  });

  it('counts findings and lists the extra reviews that ran', () => {
    const body = statusCommentBody({ state: 'reviewed', sha, plan, findings: 3, security: 'success', migration: 'failure', retried: true });
    assert.match(body, /Reviewed `0123456`\*\*: 3 new findings/);
    assert.match(body, /Security review \| ran/);
    assert.match(body, /Migration review \| failed/);
    assert.match(body, /Retried \| yes/);
  });

  it('omits extra reviews that did not run', () => {
    const body = statusCommentBody({ state: 'reviewed', sha, plan, findings: 1, security: 'skipped', migration: '' });
    assert.doesNotMatch(body, /Security review|Migration review/);
    assert.match(body, /1 new finding,/);
  });

  it('states a skip and a failure with the reason', () => {
    const skipped = statusCommentBody({ state: 'skipped', sha, reason: 'review skipped: this PR changes the review workflow' });
    assert.match(skipped, /Skipped on `0123456`\*\*: review skipped: this PR changes the review workflow/);
    assert.doesNotMatch(skipped, /\| Model/);
    const failed = statusCommentBody({ state: 'failed', sha, plan, reason: 'Claude review ran on `0123456` but produced no output; re-run the job.' });
    assert.match(failed, /Failed on `0123456`\*\*: Claude review ran on `0123456` but produced no output; re-run the job\./);
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

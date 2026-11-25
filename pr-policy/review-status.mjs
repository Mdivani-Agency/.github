// Claude review result and status comment for Mdivani-Agency pull requests.
//
// Pure logic only: no network, no environment access. `review-status-main.mjs`
// reads the PR from the GitHub API and calls these functions to decide whether
// the review posted anything, and to write the one status comment per PR.
// Run the tests with `node --test 'pr-policy/*.test.mjs'`.

import { CLAUDE_BOT_LOGIN, normalizeLogin } from './review-plan.mjs';

/** Hidden marker that identifies the status comment. */
export const STATUS_MARKER = '<!-- mdivani-claude-review-status -->';

/** The status comment is written with the workflow's GITHUB_TOKEN, so it is posted as this login. */
export const STATUS_AUTHOR = 'github-actions[bot]';

/** Possible results of one Claude code-review step, as returned by `reviewResult()`. */
export const RESULTS = Object.freeze({
  posted: 'posted', // Claude posted inline comments, a summary or a review
  empty: 'empty', // the step ran and posted nothing
  failed: 'failed', // the step itself failed or timed out
  workflowSkip: 'workflow-skip', // claude-code-action skipped itself: the PR changes the calling workflow
  notReviewable: 'not-reviewable', // the PR was closed or turned into a draft during the run
});

const shortSha = (sha) => String(sha ?? '').slice(0, 7);

function byClaude(item, bot) {
  return normalizeLogin(item?.user?.login) === bot;
}

/**
 * What Claude posted on the PR since `since` (ISO timestamp, second precision).
 *
 * @param {object} input
 * @param {Array} [input.issueComments]  REST "list issue comments" items (PR conversation)
 * @param {Array} [input.reviewComments] REST "list review comments" items (inline)
 * @param {Array} [input.reviews]        REST "list reviews" items
 * @param {string} since
 * @param {string} [botLogin]
 * @returns {{ posted: boolean, findings: number, replies: number, summaries: number, reviews: number }}
 *   `findings` counts new inline threads. Replies to existing threads are counted apart and
 *   do not make `posted` true: the code review never replies, the thread follow-up does.
 */
export function claudeOutputSince({ issueComments = [], reviewComments = [], reviews = [] }, since, botLogin = CLAUDE_BOT_LOGIN) {
  const bot = normalizeLogin(botLogin);
  const after = (at) => Boolean(at) && (!since || at >= since);
  const inline = reviewComments.filter((c) => byClaude(c, bot) && after(c.created_at));
  const findings = inline.filter((c) => !c.in_reply_to_id).length;
  const replies = inline.length - findings;
  const summaries = issueComments.filter((c) => byClaude(c, bot) && after(c.created_at)).length;
  const reviewCount = reviews.filter((r) => byClaude(r, bot) && after(r.submitted_at)).length;
  return {
    posted: findings + summaries + reviewCount > 0,
    findings,
    replies,
    summaries,
    reviews: reviewCount,
  };
}

/**
 * Result of one claude-code-action review step.
 *
 * @param {object} input
 * @param {string} input.outcome      `steps.<id>.outcome` (success, failure, cancelled, skipped)
 * @param {string} [input.conclusion] the action's `conclusion` output; empty when it exited before running Claude
 * @param {boolean} [input.hasAppToken] whether the action's `github_token` output is set; it is empty
 *                                      only when the action skipped itself on workflow validation
 *                                      (or refused a fork, which the plan already skips)
 * @param {boolean} input.posted      `claudeOutputSince(...).posted`
 * @param {boolean} [input.reviewable] the PR is still open and not a draft
 */
export function reviewResult({ outcome, conclusion = '', hasAppToken = true, posted, reviewable = true }) {
  if (outcome !== 'success') return RESULTS.failed;
  if (!conclusion && !hasAppToken) return RESULTS.workflowSkip;
  if (posted) return RESULTS.posted;
  if (!reviewable) return RESULTS.notReviewable;
  return RESULTS.empty;
}

/** The status comment among a PR's issue comments: the workflow's own comment with the marker. */
export function findStatusComment(comments, author = STATUS_AUTHOR) {
  return (comments ?? []).find((c) => c?.user?.login === author && String(c.body ?? '').includes(STATUS_MARKER)) ?? null;
}

/**
 * IDs from `openIds` (Claude threads open before the run) that are now
 * resolved by Claude. `threads` are GraphQL `reviewThreads` nodes.
 */
export function countResolvedByClaude(openIds, threads, botLogin = CLAUDE_BOT_LOGIN) {
  const bot = normalizeLogin(botLogin);
  const before = new Set(openIds ?? []);
  return (threads ?? []).filter((t) => before.has(t.id) && t.isResolved && normalizeLogin(t.resolvedBy?.login) === bot).length;
}

function extraLine(label, outcome) {
  if (!outcome || outcome === 'skipped') return null;
  const text = outcome === 'success' ? 'ran' : outcome === 'failure' ? 'failed' : outcome;
  return `| ${label} | ${text} |`;
}

/**
 * Body of the status comment.
 *
 * @param {object} s
 * @param {'reviewed'|'skipped'|'failed'} s.state
 * @param {string} s.sha            reviewed (head) commit
 * @param {string} [s.reason]       why it was skipped or failed
 * @param {object} [s.plan]         { tier, depth, difficulty, model }
 * @param {number} [s.findings]     new inline findings from all review steps
 * @param {number} [s.resolved]     threads resolved by the follow-up step
 * @param {boolean} [s.retried]     the review was run a second time because the first posted nothing
 * @param {string} [s.security]     outcome of the security review step
 * @param {string} [s.migration]    outcome of the migration review step
 * @param {string} [s.runUrl]
 */
export function statusCommentBody({
  state,
  sha,
  reason = '',
  plan = {},
  findings = 0,
  resolved = 0,
  retried = false,
  security = '',
  migration = '',
  runUrl = '',
}) {
  const at = `\`${shortSha(sha)}\``;
  const lines = [STATUS_MARKER, '### Claude review', ''];
  if (state === 'skipped') {
    lines.push(`**Skipped on ${at}**: ${reason}`);
  } else if (state === 'failed') {
    lines.push(`**Failed on ${at}**: ${reason}`);
  } else if (findings === 0) {
    lines.push(`**No issues found on ${at}.**`);
  } else {
    lines.push(`**Reviewed ${at}**: ${findings} new finding${findings === 1 ? '' : 's'}, posted as inline comments.`);
  }
  if (state !== 'skipped' && plan.tier) {
    lines.push(
      '',
      '| Item | Value |',
      '| --- | --- |',
      `| Commit | ${at} |`,
      `| Tier and depth | ${plan.tier.toUpperCase()} tier, ${plan.depth} depth (difficulty ${plan.difficulty}) |`,
      `| Model | \`${plan.model}\` |`,
      `| New findings | ${findings} |`,
      `| Threads resolved by the follow-up | ${resolved} |`,
    );
    if (retried) lines.push('| Retried | yes: the first attempt posted nothing |');
    for (const row of [extraLine('Security review', security), extraLine('Migration review', migration)]) {
      if (row) lines.push(row);
    }
  }
  lines.push(
    '',
    `<sub>Updated by the Claude review workflow${runUrl ? ` ([run](${runUrl}))` : ''}. This comment names the last commit a review ran for: if it is not the PR's latest commit, that commit's review is missing, so re-run the Claude review job.</sub>`,
  );
  return `${lines.join('\n')}\n`;
}

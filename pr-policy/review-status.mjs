// Claude review result and status comment for Mdivani-Agency pull requests.
//
// Pure logic only: no network, no environment access. `review-status-main.mjs`
// reads the PR from the GitHub API and calls these functions to decide whether
// the review posted anything, and to write the one status comment per PR.
// Run the tests with `node --test 'pr-policy/*.test.mjs'`.

import { DIFFICULTIES } from './policy.mjs';
import { CLAUDE_BOT_LOGIN, normalizeLogin, reviewReplyResult } from './review-plan.mjs';

/** Hidden marker that identifies the status comment. */
export const STATUS_MARKER = '<!-- mdivani-claude-review-status -->';

/**
 * Hidden line in the status comment with the PR's review history: the code
 * reviews that finished and the highest difficulty among them, e.g.
 * `<!-- mdivani-claude-review-history reviews=2 difficulty=high -->`.
 */
const HISTORY_RE = /<!-- mdivani-claude-review-history reviews=(\d+) difficulty=([a-z]*) -->/;

/** The status comment is written with the workflow's GITHUB_TOKEN, so it is posted as this login. */
export const STATUS_AUTHOR = 'github-actions[bot]';

/** Possible results of one Claude code-review step, as returned by `reviewResult()`. */
export const RESULTS = Object.freeze({
  posted: 'posted', // Claude posted inline comments, a summary or a review
  noIssues: 'no-issues', // the review finished, found nothing and posted nothing (the skill posts no summary)
  empty: 'empty', // the step ran and posted nothing, and its reply does not say it found nothing
  failed: 'failed', // the step itself failed or timed out
  workflowSkip: 'workflow-skip', // claude-code-action skipped itself: the PR changes the calling workflow
  notReviewable: 'not-reviewable', // the PR was closed or turned into a draft during the run
});

const shortSha = (sha) => String(sha ?? '').slice(0, 7);

function byClaude(item, bot) {
  return normalizeLogin(item?.user?.login) === bot;
}

/**
 * Which review step posted an inline comment, from the prefix the security and
 * migration prompts require ("Security (<severity>):", "Migration:"). Anything
 * else is the code review's.
 */
export function findingStep(body) {
  const text = String(body ?? '').replace(/^[\s*_>]+/, '');
  if (/^security\s*\(/i.test(text)) return 'security';
  if (/^migration\s*:/i.test(text)) return 'migration';
  return 'code';
}

/**
 * What a claude-code-action transcript (its `execution_file`) says about the
 * code review: the final reply and its "Review result:" line, and the first
 * line of the skill's review instructions, which names the level and recipe the
 * skill ran. Accepts the action's JSON array or JSON lines; never throws.
 *
 * @returns {{ reply: string, isError: boolean, replyResult: null | { noIssues: true } | { findings: number },
 *   recipe: string }}
 */
export function transcriptSummary(text) {
  let messages = [];
  const raw = String(text ?? '').trim();
  try {
    const parsed = JSON.parse(raw);
    messages = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    for (const line of raw.split(/\r?\n/)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // not a message line
      }
    }
  }
  let reply = '';
  let isError = false;
  let recipe = '';
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'result') {
      reply = typeof m.result === 'string' ? m.result : '';
      isError = Boolean(m.is_error);
    }
    if (!recipe && m.type === 'system' && m.subtype === 'task_started' && /code-review/.test(String(m.description ?? ''))) {
      recipe = String(m.prompt ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => /effort/i.test(l)) ?? '';
      recipe = recipe.replace(/`/g, '').slice(0, 200);
    }
  }
  return { reply, isError, replyResult: isError ? null : reviewReplyResult(reply), recipe };
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
 * @returns {{ posted: boolean, findings: number, byStep: { code: number, security: number, migration: number },
 *   replies: number, summaries: number, reviews: number }}
 *   `findings` counts new inline threads, and `byStep` splits them by the step that posted
 *   them (see `findingStep()`). Replies to existing threads are counted apart and do not
 *   make `posted` true: the code review never replies, the thread follow-up does.
 */
export function claudeOutputSince({ issueComments = [], reviewComments = [], reviews = [] }, since, botLogin = CLAUDE_BOT_LOGIN) {
  const bot = normalizeLogin(botLogin);
  const after = (at) => Boolean(at) && (!since || at >= since);
  const inline = reviewComments.filter((c) => byClaude(c, bot) && after(c.created_at));
  const threads = inline.filter((c) => !c.in_reply_to_id);
  const findings = threads.length;
  const byStep = { code: 0, security: 0, migration: 0 };
  for (const c of threads) byStep[findingStep(c.body)] += 1;
  const replies = inline.length - findings;
  const summaries = issueComments.filter((c) => byClaude(c, bot) && after(c.created_at)).length;
  const reviewCount = reviews.filter((r) => byClaude(r, bot) && after(r.submitted_at)).length;
  return {
    posted: findings + summaries + reviewCount > 0,
    findings,
    byStep,
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
 * @param {boolean} [input.noIssues]  the review's reply ends with "Review result: no issues found"
 * @param {boolean} [input.reviewable] the PR is still open and not a draft
 */
export function reviewResult({ outcome, conclusion = '', hasAppToken = true, posted, noIssues = false, reviewable = true }) {
  if (outcome !== 'success') return RESULTS.failed;
  if (!conclusion && !hasAppToken) return RESULTS.workflowSkip;
  if (posted) return RESULTS.posted;
  if (noIssues) return RESULTS.noIssues;
  if (!reviewable) return RESULTS.notReviewable;
  return RESULTS.empty;
}

/**
 * Review history from the status comment body: { reviews, difficulty }. A
 * status comment from before the history line counts as one review when it
 * reports a finished review. No comment: no reviews.
 */
export function readReviewHistory(body) {
  const text = String(body ?? '');
  const m = text.match(HISTORY_RE);
  if (m) return { reviews: Number(m[1]), difficulty: DIFFICULTIES.includes(m[2]) ? m[2] : '' };
  const finished = /\*\*(Reviewed|No issues found on) `/.test(text);
  return { reviews: finished ? 1 : 0, difficulty: '' };
}

export function historyLine({ reviews = 0, difficulty = '' } = {}) {
  const n = Math.max(0, Math.trunc(Number(reviews) || 0));
  return `<!-- mdivani-claude-review-history reviews=${n} difficulty=${DIFFICULTIES.includes(difficulty) ? difficulty : ''} -->`;
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Status-comment text for the code-review step, from its result and its own inline findings. */
export function codeReviewText(result, findings = 0, retried = false) {
  const again = retried ? ', also after one retry' : '';
  if (result === RESULTS.posted) return findings > 0 ? plural(findings, 'finding') : 'posted a comment, no inline findings';
  if (result === RESULTS.noIssues) return `no issues${retried ? ' (on the retry)' : ''}`;
  if (result === RESULTS.empty) return `no output${again}`;
  if (result === RESULTS.failed) return `failed${again}`;
  return '';
}

/**
 * Status-comment text for the security or migration step: findings, "no issues"
 * (these reviews post nothing when they find nothing), failed, or null when the
 * step did not run.
 */
export function extraReviewText(outcome, findings = 0) {
  if (!outcome || outcome === 'skipped') return null;
  if (outcome === 'success') return findings > 0 ? plural(findings, 'finding') : 'no issues';
  if (outcome === 'failure') return 'failed';
  return outcome;
}

/**
 * Body of the status comment.
 *
 * @param {object} s
 * @param {'reviewed'|'skipped'|'failed'|'limit'} s.state  `limit`: not reviewed because the review limit is
 *                                  reached; `reason` says so, and the threads resolved are shown
 * @param {string} s.sha            reviewed (head) commit
 * @param {string} [s.reason]       why it was skipped or failed; names the step that failed
 * @param {object} [s.plan]         { tier, level, difficulty, model, command }
 * @param {Array}  [s.steps]        [{ name, text }]: each review step's result, in run order
 * @param {number} [s.findings]     new inline findings from all review steps
 * @param {number} [s.resolved]     threads resolved by the follow-up step
 * @param {boolean} [s.retried]     the code review was run a second time because the first posted nothing
 * @param {string} [s.runUrl]
 * @param {object} [s.history]      { reviews, difficulty } after this run, kept in a hidden line
 * @param {string} [s.review]       "first review" or "follow-up N of 2"
 */
export function statusCommentBody({
  state,
  sha,
  reason = '',
  plan = {},
  steps = [],
  findings = 0,
  resolved = 0,
  retried = false,
  runUrl = '',
  history = { reviews: 0, difficulty: '' },
  review = '',
}) {
  const at = `\`${shortSha(sha)}\``;
  const lines = [STATUS_MARKER, historyLine(history), '### Claude review', ''];
  if (state === 'limit') {
    lines.push(`**Not reviewed on ${at}**: ${reason}`);
    if (resolved > 0) lines.push('', `Threads resolved by the follow-up: ${resolved}.`);
  } else if (state === 'skipped') {
    lines.push(`**Skipped on ${at}**: ${reason}`);
  } else if (state === 'failed') {
    lines.push(`**Failed on ${at}**: ${reason}`);
  } else if (findings === 0) {
    lines.push(`**No issues found on ${at}.**`);
  } else {
    lines.push(`**Reviewed ${at}**: ${plural(findings, 'new finding')}, posted as inline comments.`);
  }
  if ((state === 'reviewed' || state === 'failed') && plan.tier) {
    lines.push(
      '',
      '| Item | Value |',
      '| --- | --- |',
      `| Commit | ${at} |`,
      ...(review ? [`| Review | ${review} |`] : []),
      `| Tier and level | ${plan.tier.toUpperCase()} tier, ${plan.level} level (difficulty ${plan.difficulty}) |`,
      `| Model | \`${plan.model}\` |`,
    );
    for (const step of steps) {
      if (step?.text) lines.push(`| ${step.name} | ${step.text} |`);
    }
    lines.push(`| Threads resolved by the follow-up | ${resolved} |`);
    if (retried) lines.push('| Retried | yes: the first code-review attempt posted nothing |');
  }
  lines.push(
    '',
    `<sub>Updated by the Claude review workflow${runUrl ? ` ([run](${runUrl}))` : ''}. This comment names the last commit a review ran for: if it is not the PR's latest commit, that commit's review is missing, so re-run the Claude review job.</sub>`,
  );
  return `${lines.join('\n')}\n`;
}

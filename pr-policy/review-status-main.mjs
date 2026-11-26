// Entry point for the result and status steps of the Claude review workflow
// (.github/workflows/claude-review.yml).
//
//   node review-status-main.mjs mark
//     Before the first code-review attempt: writes the step output `since`, the
//     current time by GitHub's clock (the Date header of an API response), so
//     a runner clock that is off cannot count earlier comments as review output.
//
//   node review-status-main.mjs check
//     After a code-review attempt: did Claude post anything on the PR since the
//     attempt started, and if not, does the review's reply (in its transcript)
//     end with "Review result: no issues found"? Writes the step output
//     `result` (see RESULTS in review-status.mjs) and logs the level and recipe
//     the skill reported. Never fails.
//
//   node review-status-main.mjs report
//     At the end of the job: creates or edits the PR's status comment (each
//     step's result: findings, no issues, no output or failed) and fails the
//     step when a review step failed or the code review produced no output.
//     A code review that finished (findings or no issues) adds one to the
//     review history in the status comment and removes the claude-review:again
//     label if the plan saw it. When the review limit was reached (only the
//     thread follow-up ran), it writes that and the threads resolved.
//
// Environment (all): GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL,
// GITHUB_GRAPHQL_URL, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, PR_NUMBER, SINCE,
// CLAUDE_BOT_LOGIN (optional).
// check: STEP_OUTCOME, STEP_CONCLUSION, STEP_HAS_APP_TOKEN ('true'/'false'),
// TRANSCRIPT (the step's execution_file; optional).
// report: RESULT, RETRIED, HEAD_SHA, TIER, LEVEL, DIFFICULTY, MODEL,
// REVIEW_COMMAND, OPEN_THREADS_FILE, SECURITY_OUTCOME, MIGRATION_OUTCOME,
// CODE_REVIEW, REVIEW_LABEL, LIMIT_STATUS, AGAIN_LABEL, PRIOR_REVIEWS,
// PRIOR_DIFFICULTY, GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { annotation, createClient, setOutputs } from './github.mjs';
import { AGAIN_LABEL, CLAUDE_BOT_LOGIN, WORKFLOW_CHANGED_STATUS, maxDifficulty } from './review-plan.mjs';
import {
  RESULTS,
  claudeOutputSince,
  codeReviewText,
  countResolvedByClaude,
  extraReviewText,
  findStatusComment,
  reviewResult,
  statusCommentBody,
  transcriptSummary,
} from './review-status.mjs';

const env = process.env;
const REPO = env.GITHUB_REPOSITORY;
const [OWNER, NAME] = (REPO ?? '').split('/');
const NUMBER = Number(env.PR_NUMBER);
const SINCE = env.SINCE ?? '';
const BOT = env.CLAUDE_BOT_LOGIN || CLAUDE_BOT_LOGIN;
const { gh, paginate, graphql, upsertComment } = createClient({
  token: env.GITHUB_TOKEN,
  api: env.GITHUB_API_URL || undefined,
  graphqlUrl: env.GITHUB_GRAPHQL_URL || undefined,
  repo: REPO,
  userAgent: 'mdivani-claude-review',
});

const CAP = 3000;

async function claudeOutput() {
  const since = SINCE ? `since=${encodeURIComponent(SINCE)}` : '';
  const [issueComments, reviewComments, reviews] = await Promise.all([
    paginate(`/repos/${REPO}/issues/${NUMBER}/comments${since ? `?${since}` : ''}`, CAP),
    paginate(`/repos/${REPO}/pulls/${NUMBER}/comments${since ? `?${since}` : ''}`, CAP),
    paginate(`/repos/${REPO}/pulls/${NUMBER}/reviews`, CAP),
  ]);
  return claudeOutputSince({ issueComments, reviewComments, reviews }, SINCE, BOT);
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved resolvedBy { login } }
      }
    }
  }
}`;

async function fetchThreads() {
  const threads = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await graphql(THREADS_QUERY, { owner: OWNER, name: NAME, number: NUMBER, after });
    const conn = data.repository.pullRequest.reviewThreads;
    threads.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return threads;
}

function summary(text) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
}

async function mark() {
  let date = null;
  try {
    // /rate_limit does not count against the rate limit.
    date = new Date((await gh('/rate_limit')).headers.get('date'));
  } catch (err) {
    annotation('warning', `Could not read GitHub's clock, using the runner's: ${err.message}`);
  }
  if (!date || Number.isNaN(date.getTime())) date = new Date();
  const since = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  setOutputs({ since });
  console.log(`Review output counts from ${since}.`);
  return 0;
}

function readTranscript(file) {
  if (!file || !existsSync(file)) return transcriptSummary('');
  try {
    return transcriptSummary(readFileSync(file, 'utf8'));
  } catch (err) {
    annotation('warning', `Could not read the code-review transcript: ${err.message}`);
    return transcriptSummary('');
  }
}

function describeReply(t) {
  if (t.isError) return 'the review ended with an error';
  if (!t.replyResult) return t.reply ? 'the reply has no "Review result:" line' : 'no reply';
  return t.replyResult.noIssues ? 'the reply says no issues found' : `the reply says ${t.replyResult.findings} finding(s)`;
}

async function check() {
  const [output, pull] = await Promise.all([claudeOutput(), gh(`/repos/${REPO}/pulls/${NUMBER}`).then((r) => r.json())]);
  const transcript = readTranscript(env.TRANSCRIPT);
  const result = reviewResult({
    outcome: env.STEP_OUTCOME,
    conclusion: env.STEP_CONCLUSION ?? '',
    hasAppToken: env.STEP_HAS_APP_TOKEN === 'true',
    posted: output.posted,
    noIssues: Boolean(transcript.replyResult?.noIssues),
    reviewable: pull.state === 'open' && !pull.draft,
  });
  setOutputs({ result });
  summary(
    [
      `Claude code review attempt: ${result} (since ${SINCE || 'job start'}: ${output.findings} inline finding(s), ${output.replies} thread replies, ${output.summaries} PR comment(s), ${output.reviews} review(s) by ${BOT}; ${describeReply(transcript)}).`,
      `Level and recipe the /code-review skill reported: ${transcript.recipe || 'not found in the transcript'}.`,
    ].join('\n\n'),
  );
  return 0;
}

/** Claude threads open before the run (OPEN_THREADS_FILE) that Claude resolved during it. */
async function countResolved() {
  try {
    const file = env.OPEN_THREADS_FILE;
    const openIds = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    return openIds.length ? countResolvedByClaude(openIds, await fetchThreads(), BOT) : 0;
  } catch (err) {
    annotation('warning', `Could not count the resolved threads: ${err.message}`);
    return 0;
  }
}

async function removeAgainLabel() {
  try {
    await gh(`/repos/${REPO}/issues/${NUMBER}/labels/${encodeURIComponent(AGAIN_LABEL)}`, { method: 'DELETE', allow: [404] });
    console.log(`Removed the ${AGAIN_LABEL} label.`);
  } catch (err) {
    annotation('warning', `Could not remove the ${AGAIN_LABEL} label: ${err.message}`);
  }
}

async function report() {
  const prior = { reviews: Number(env.PRIOR_REVIEWS) || 0, difficulty: env.PRIOR_DIFFICULTY ?? '' };
  if (env.CODE_REVIEW !== 'true') return reportLimit(prior);
  const result = env.RESULT || RESULTS.failed;
  const retried = env.RETRIED === 'true';
  const sha = env.HEAD_SHA ?? '';
  const short = sha.slice(0, 7);
  const runUrl = `${env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const plan = { tier: env.TIER, level: env.LEVEL, difficulty: env.DIFFICULTY, model: env.MODEL };
  const command = (env.REVIEW_COMMAND ?? '').replace(/ \d+$/, '');

  let output = { findings: 0, byStep: { code: 0, security: 0, migration: 0 } };
  try {
    output = await claudeOutput();
  } catch (err) {
    annotation('warning', `Could not count Claude's findings: ${err.message}`);
  }
  const resolved = await countResolved();

  let state = 'reviewed';
  const failures = [];
  let reason = '';
  if (result === RESULTS.workflowSkip) {
    state = 'skipped';
    reason = `${WORKFLOW_CHANGED_STATUS}: claude-code-action reported a workflow-validation skip (the calling workflow differs from the default branch).`;
  } else if (result === RESULTS.notReviewable) {
    state = 'skipped';
    reason = 'the PR was closed or turned into a draft during the review.';
  } else {
    if (result === RESULTS.empty) {
      failures.push(`the code review produced no output${retried ? ', also after one retry' : ''}`);
    } else if (result !== RESULTS.posted && result !== RESULTS.noIssues) {
      failures.push('the code-review step failed or timed out');
    }
    if (env.SECURITY_OUTCOME === 'failure') failures.push('the security-review step failed');
    if (env.MIGRATION_OUTCOME === 'failure') failures.push('the migration-review step failed');
    if (failures.length) {
      state = 'failed';
      reason = `${failures.join('; ')}. See the job log, then re-run the job.`;
    }
  }

  const steps = [
    { name: `Code review${command ? ` (\`${command}\`)` : ''}`, text: codeReviewText(result, output.byStep.code, retried) },
    { name: 'Security review', text: extraReviewText(env.SECURITY_OUTCOME, output.byStep.security) },
    { name: 'Migration review', text: extraReviewText(env.MIGRATION_OUTCOME, output.byStep.migration) },
  ];
  // A code review that finished counts towards the limit, whatever the extra steps did.
  const counted = result === RESULTS.posted || result === RESULTS.noIssues;
  const history = counted
    ? { reviews: prior.reviews + 1, difficulty: maxDifficulty(prior.difficulty, env.DIFFICULTY) }
    : prior;
  const body = statusCommentBody({
    state,
    sha,
    reason,
    plan,
    steps,
    findings: output.findings,
    resolved,
    retried,
    runUrl,
    history,
    review: env.REVIEW_LABEL ?? '',
  });
  await upsertComment(NUMBER, body, findStatusComment);
  summary(stripMarkers(body));
  if (counted && env.AGAIN_LABEL === 'true') await removeAgainLabel();

  if (state === 'failed') {
    annotation('error', `Claude review failed on ${short}: ${reason}`);
    return 1;
  }
  if (state === 'skipped') annotation('notice', `Claude review skipped on ${short}: ${reason}`);
  return 0;
}

const stripMarkers = (body) => body.replace(/^(<!--.*-->\n)+/, '');

/** Limit reached: only the thread follow-up ran. The history stays as it was. */
async function reportLimit(history) {
  const resolved = await countResolved();
  const runUrl = `${env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const sha = env.HEAD_SHA ?? '';
  const body = statusCommentBody({ state: 'limit', sha, reason: env.LIMIT_STATUS ?? '', resolved, runUrl, history });
  await upsertComment(NUMBER, body, findStatusComment);
  summary(stripMarkers(body));
  annotation('notice', `Claude review not run on ${sha.slice(0, 7)}: ${env.LIMIT_STATUS ?? 'review limit reached'}`);
  return 0;
}

const commands = { mark, check, report };
const command = commands[process.argv[2]];
if (!command) {
  annotation('error', `Unknown command "${process.argv[2] ?? ''}"; use mark, check or report.`);
  process.exitCode = 1;
} else if (!NUMBER) {
  annotation('error', 'PR_NUMBER is not set.');
  process.exitCode = 1;
} else {
  command().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      annotation('error', `Claude review ${process.argv[2]} could not run: ${err.message}`);
      process.exitCode = 1;
    },
  );
}

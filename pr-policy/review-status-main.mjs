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
//     attempt started? Writes the step output `result` (see RESULTS in
//     review-status.mjs). Never fails.
//
//   node review-status-main.mjs report
//     At the end of the job: creates or edits the PR's status comment (reviewed,
//     skipped or failed) and fails the step when the review failed or posted
//     nothing.
//
// Environment (both): GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL,
// GITHUB_GRAPHQL_URL, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, PR_NUMBER, SINCE,
// CLAUDE_BOT_LOGIN (optional).
// check: STEP_OUTCOME, STEP_CONCLUSION, STEP_HAS_APP_TOKEN ('true'/'false').
// report: RESULT, RETRIED, HEAD_SHA, TIER, DEPTH, DIFFICULTY, MODEL,
// OPEN_THREADS_FILE, SECURITY_OUTCOME, MIGRATION_OUTCOME, GITHUB_SERVER_URL,
// GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { annotation, createClient, setOutputs } from './github.mjs';
import { CLAUDE_BOT_LOGIN, WORKFLOW_CHANGED_STATUS } from './review-plan.mjs';
import {
  RESULTS,
  claudeOutputSince,
  countResolvedByClaude,
  findStatusComment,
  reviewResult,
  statusCommentBody,
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

async function check() {
  const [output, pull] = await Promise.all([claudeOutput(), gh(`/repos/${REPO}/pulls/${NUMBER}`).then((r) => r.json())]);
  const result = reviewResult({
    outcome: env.STEP_OUTCOME,
    conclusion: env.STEP_CONCLUSION ?? '',
    hasAppToken: env.STEP_HAS_APP_TOKEN === 'true',
    posted: output.posted,
    reviewable: pull.state === 'open' && !pull.draft,
  });
  setOutputs({ result });
  summary(
    `Claude review attempt: ${result} (since ${SINCE || 'job start'}: ${output.findings} inline finding(s), ${output.replies} thread replies, ${output.summaries} PR comment(s), ${output.reviews} review(s) by ${BOT}).`,
  );
  return 0;
}

async function report() {
  const result = env.RESULT || RESULTS.failed;
  const sha = env.HEAD_SHA ?? '';
  const short = sha.slice(0, 7);
  const runUrl = `${env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const plan = { tier: env.TIER, depth: env.DEPTH, difficulty: env.DIFFICULTY, model: env.MODEL };

  let state = 'reviewed';
  let reason = '';
  let fail = false;
  if (result === RESULTS.workflowSkip) {
    state = 'skipped';
    reason = `${WORKFLOW_CHANGED_STATUS}: claude-code-action reported a workflow-validation skip (the calling workflow differs from the default branch).`;
  } else if (result === RESULTS.notReviewable) {
    state = 'skipped';
    reason = 'the PR was closed or turned into a draft during the review.';
  } else if (result === RESULTS.empty) {
    state = 'failed';
    reason = `Claude review ran on \`${short}\` but produced no output${env.RETRIED === 'true' ? ', also after one retry' : ''}; re-run the job.`;
    fail = true;
  } else if (result !== RESULTS.posted) {
    state = 'failed';
    reason = 'the Claude code-review step failed or timed out; see the job log, then re-run the job.';
    fail = true;
  }

  let findings = 0;
  let resolved = 0;
  try {
    findings = (await claudeOutput()).findings;
    const file = env.OPEN_THREADS_FILE;
    const openIds = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    if (openIds.length) resolved = countResolvedByClaude(openIds, await fetchThreads(), BOT);
  } catch (err) {
    annotation('warning', `Could not count Claude's findings and resolved threads: ${err.message}`);
  }

  const body = statusCommentBody({
    state,
    sha,
    reason,
    plan,
    findings,
    resolved,
    retried: env.RETRIED === 'true',
    security: env.SECURITY_OUTCOME,
    migration: env.MIGRATION_OUTCOME,
    runUrl,
  });
  await upsertComment(NUMBER, body, findStatusComment);
  summary(body.replace(/^<!--.*-->\n/, ''));

  if (fail) {
    annotation('error', `Claude review ${state} on ${short}: ${reason}`);
    return 1;
  }
  if (state === 'skipped') annotation('notice', `Claude review skipped on ${short}: ${reason}`);
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

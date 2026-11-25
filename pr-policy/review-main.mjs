// Entry point for the plan step of the Claude review workflow
// (.github/workflows/claude-review.yml).
//
// Reads the pull request from the GitHub API (never from checked-out PR code),
// recomputes the effective difficulty with the PR policy (the difficulty label
// may not exist yet, because PR policy runs at the same time), builds the
// review plan, reads Claude's review threads, and writes step outputs (among
// them the code-review prompts for the first attempt and the retry), the IDs
// of Claude's open threads for the status step, and the job summary. When the
// PR changes the calling workflow, it writes the skip to the PR's status
// comment.
//
// Never fails on misconfiguration: a missing secret or variable is a warning
// and the plan says skip.
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH,
// GITHUB_EVENT_NAME, GITHUB_ACTOR, GITHUB_WORKFLOW_REF, GITHUB_SERVER_URL,
// GITHUB_API_URL, GITHUB_GRAPHQL_URL, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
// GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, RUNNER_TEMP,
// HAS_CLAUDE_TOKEN ('true'/'false'), CLAUDE_REVIEW_MODEL_LOW,
// CLAUDE_REVIEW_MODEL_HIGH, CLAUDE_BOT_LOGIN (optional).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { annotation, createClient, setOutputs } from './github.mjs';
import { FILES_API_CAP, evaluate } from './policy.mjs';
import {
  CLAUDE_BOT_LOGIN,
  classifyThreads,
  formatReviewSummary,
  reviewPlan,
  reviewPrompt,
  workflowPathFromRef,
} from './review-plan.mjs';
import { findStatusComment, statusCommentBody } from './review-status.mjs';

const env = process.env;
const REPO = env.GITHUB_REPOSITORY;
const [OWNER, NAME] = (REPO ?? '').split('/');
const { gh, paginate, readConfig, graphql, upsertComment } = createClient({
  token: env.GITHUB_TOKEN,
  api: env.GITHUB_API_URL || undefined,
  graphqlUrl: env.GITHUB_GRAPHQL_URL || undefined,
  repo: REPO,
  userAgent: 'mdivani-claude-review',
});

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          resolvedBy { login }
          comments(first: 1) {
            nodes { author { login } body url createdAt originalCommit { oid } }
          }
        }
      }
    }
  }
}`;

async function fetchThreads(number) {
  const threads = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await graphql(THREADS_QUERY, { owner: OWNER, name: NAME, number, after });
    const conn = data.repository.pullRequest.reviewThreads;
    threads.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return threads;
}

async function main() {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number;
  const config = {
    hasToken: env.HAS_CLAUDE_TOKEN === 'true',
    modelLow: (env.CLAUDE_REVIEW_MODEL_LOW ?? '').trim(),
    modelHigh: (env.CLAUDE_REVIEW_MODEL_HIGH ?? '').trim(),
  };

  let pull = null;
  let files = [];
  let policy = { outputs: { type: '', difficulty: '', sensitive: 'false', is_release: 'false' }, declaredDifficulty: '' };
  if (number) {
    // Fetch fresh: the event payload can be stale on re-runs.
    pull = await (await gh(`/repos/${REPO}/pulls/${number}`)).json();
    [files, policy] = await Promise.all([
      paginate(`/repos/${REPO}/pulls/${number}/files`, FILES_API_CAP),
      readConfig(pull.base.ref),
    ]).then(([f, configText]) => [
      f,
      evaluate({
        pr: {
          title: pull.title,
          body: pull.body,
          headRef: pull.head.ref,
          baseRef: pull.base.ref,
          headRepo: pull.head.repo?.full_name ?? null,
          baseRepo: pull.base.repo.full_name,
          commits: pull.commits,
          changedFiles: pull.changed_files,
        },
        files: f,
        configText,
      }),
    ]);
  }

  const plan = reviewPlan({
    eventName: env.GITHUB_EVENT_NAME,
    action: event.action,
    actor: env.GITHUB_ACTOR ?? '',
    pr: pull && {
      number,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft,
      headRepo: pull.head.repo?.full_name ?? null,
      baseRepo: pull.base.repo.full_name,
    },
    policy,
    files,
    config,
    workflowPath: workflowPathFromRef(env.GITHUB_WORKFLOW_REF, REPO),
  });

  let threads = null;
  let prompt = '';
  let retryPrompt = '';
  let openThreadsFile = '';
  if (!plan.skip) {
    threads = classifyThreads(await fetchThreads(number), env.CLAUDE_BOT_LOGIN || CLAUDE_BOT_LOGIN);
    // The "do not raise again" list goes into the prompt text after the PR
    // number: the skill's review agent reads it there, not in an appended
    // system prompt.
    prompt = reviewPrompt(plan, threads);
    retryPrompt = reviewPrompt(plan, threads, { retry: true });
    const dir = join(env.RUNNER_TEMP || '/tmp', 'claude-review');
    mkdirSync(dir, { recursive: true });
    // The status step counts which of these Claude resolved during the run.
    openThreadsFile = join(dir, 'open-thread-ids.json');
    writeFileSync(openThreadsFile, JSON.stringify(threads.open.map((t) => t.id)));
  }

  // A skip the PR should see (the PR changes the review workflow) goes to the status comment.
  if (plan.skip && plan.statusComment && pull) {
    const runUrl = `${env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
    const body = statusCommentBody({ state: 'skipped', sha: pull.head.sha, reason: plan.statusComment, runUrl });
    try {
      await upsertComment(number, body, findStatusComment);
    } catch (err) {
      annotation('warning', `Could not update the Claude review status comment: ${err.message}`);
    }
  }

  const resolveThreads = Boolean(plan.resolveThreads && threads?.open.length);
  setOutputs({
    skip: String(plan.skip),
    tier: plan.tier,
    model: plan.model,
    level: plan.level,
    difficulty: plan.difficulty,
    security: String(plan.security),
    migration_review: String(plan.migrationReview),
    review_command: plan.reviewCommand,
    review_prompt: prompt,
    retry_prompt: retryPrompt,
    open_threads_file: openThreadsFile,
    pr_number: number ?? '',
    resolve_threads: String(resolveThreads),
    open_threads: resolveThreads ? JSON.stringify(threads.open, null, 2) : '',
    last_reviewed_sha: threads?.lastReviewedSha ?? '',
    pr_url: pull?.html_url ?? '',
    base_ref: pull?.base.ref ?? '',
    head_sha: pull?.head.sha ?? '',
  });

  const summary = formatReviewSummary(plan, number ? `${REPO}#${number}` : '', threads);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!plan.skip) console.log(`Code review command: ${plan.reviewCommand}\n\nFull prompt:\n${prompt}`);
  if (plan.warning) annotation('warning', plan.warning);
  else if (plan.skip) annotation('notice', `Claude review skipped: ${plan.skipReason}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    annotation('error', `Claude review plan could not run: ${err.message}`);
    process.exitCode = 1;
  },
);

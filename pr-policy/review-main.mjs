// Entry point for the plan step of the Claude review workflow
// (.github/workflows/claude-review.yml).
//
// Reads the pull request from the GitHub API (never from checked-out PR code),
// recomputes the effective difficulty with the PR policy (the difficulty label
// may not exist yet, because PR policy runs at the same time), builds the
// review plan, reads Claude's review threads, and writes step outputs, a
// system-prompt file for the review steps, and the job summary.
//
// Never fails on misconfiguration: a missing secret or variable is a warning
// and the plan says skip.
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH,
// GITHUB_EVENT_NAME, GITHUB_ACTOR, GITHUB_SERVER_URL, GITHUB_API_URL,
// GITHUB_GRAPHQL_URL, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, RUNNER_TEMP,
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
  reviewSystemPrompt,
} from './review-plan.mjs';

const env = process.env;
const REPO = env.GITHUB_REPOSITORY;
const [OWNER, NAME] = (REPO ?? '').split('/');
const { gh, paginate, readConfig, graphql } = createClient({
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
  });

  let threads = null;
  let promptFile = '';
  if (!plan.skip) {
    threads = classifyThreads(await fetchThreads(number), env.CLAUDE_BOT_LOGIN || CLAUDE_BOT_LOGIN);
    const dir = join(env.RUNNER_TEMP || '/tmp', 'claude-review');
    mkdirSync(dir, { recursive: true });
    promptFile = join(dir, 'review-system-prompt.md');
    writeFileSync(promptFile, reviewSystemPrompt(plan, threads));
  }

  const resolveThreads = Boolean(plan.resolveThreads && threads?.open.length);
  setOutputs({
    skip: String(plan.skip),
    tier: plan.tier,
    model: plan.model,
    depth: plan.depth,
    difficulty: plan.difficulty,
    security: String(plan.security),
    migration_review: String(plan.migrationReview),
    review_command: plan.reviewCommand,
    review_prompt_file: promptFile,
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

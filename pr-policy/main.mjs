// Entry point for the PR policy workflow (.github/workflows/pr-policy.yml).
//
// Reads the pull request from the GitHub API (never from checked-out PR code),
// evaluates it with policy.mjs, writes step outputs and the job summary, syncs
// the difficulty:<level> label, and exits 1 when the policy fails.
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH,
// GITHUB_EVENT_NAME, GITHUB_API_URL, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.

import { appendFileSync, readFileSync } from 'node:fs';
import { annotation, createClient, setOutputs } from './github.mjs';
import { COMMITS_API_CAP, FILES_API_CAP, evaluate, formatSummary } from './policy.mjs';

const env = process.env;
const REPO = env.GITHUB_REPOSITORY;
const { gh, paginate, readConfig } = createClient({
  token: env.GITHUB_TOKEN,
  api: env.GITHUB_API_URL || undefined,
  graphqlUrl: env.GITHUB_GRAPHQL_URL || undefined,
  repo: REPO,
});

const LABEL_COLORS = { critical: 'b60205', high: 'd93f0b', medium: 'fbca04', low: '0e8a16' };

async function syncLabel(number, difficulty) {
  const want = difficulty ? `difficulty:${difficulty}` : null;
  const current = await paginate(`/repos/${REPO}/issues/${number}/labels`, 1000);
  for (const { name } of current) {
    if (name.startsWith('difficulty:') && name !== want) {
      await gh(`/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        allow: [404],
      });
    }
  }
  if (!want || current.some(({ name }) => name === want)) return;
  await gh(`/repos/${REPO}/labels`, {
    method: 'POST',
    body: {
      name: want,
      color: LABEL_COLORS[difficulty],
      description: `Effective PR difficulty (set by PR policy)`,
    },
    allow: [422], // already exists
  });
  await gh(`/repos/${REPO}/issues/${number}/labels`, { method: 'POST', body: { labels: [want] } });
}

async function main() {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number;
  if (!number) {
    if (env.GITHUB_EVENT_NAME === 'merge_group') {
      console.log('merge_group event: the PR was already checked; nothing to do.');
      setOutputs({ type: '', difficulty: '', sensitive: 'false', is_release: 'false' });
      return 0;
    }
    annotation(
      'error',
      `PR policy needs a pull_request event (got "${env.GITHUB_EVENT_NAME}"). Call it from a workflow triggered by pull_request.`,
    );
    return 1;
  }

  // Fetch the PR fresh so re-runs see the current title and description.
  const pull = await (await gh(`/repos/${REPO}/pulls/${number}`)).json();
  const [commits, files, configText] = await Promise.all([
    paginate(`/repos/${REPO}/pulls/${number}/commits`, COMMITS_API_CAP),
    paginate(`/repos/${REPO}/pulls/${number}/files`, FILES_API_CAP),
    readConfig(pull.base.ref),
  ]);

  const result = evaluate({
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
    commits,
    files,
    configText,
  });

  setOutputs(result.outputs);
  const summary = formatSummary(result, `${REPO}#${number}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);

  try {
    await syncLabel(number, result.outputs.difficulty);
  } catch (err) {
    // Fork PRs get a read-only token; labels are best effort.
    annotation('warning', `Could not update the difficulty label: ${err.message}`);
  }

  for (const n of result.notes) annotation('notice', n);
  for (const e of result.errors) annotation('error', e);
  if (result.errors.length) {
    console.log(`PR policy failed with ${result.errors.length} problem(s); all are listed above.`);
    return 1;
  }
  console.log('PR policy passed.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    annotation('error', `PR policy could not run: ${err.message}`);
    process.exitCode = 1;
  },
);

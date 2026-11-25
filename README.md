# .github

Org-wide defaults for Mdivani-Agency repositories:

- [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md): the default PR template for every repo that has no template of its own.
- [`.github/workflows/pr-policy.yml`](.github/workflows/pr-policy.yml): the **PR policy** check. Its logic is in [`pr-policy/policy.mjs`](pr-policy/policy.mjs) and is unit-tested in [`pr-policy/policy.test.mjs`](pr-policy/policy.test.mjs).
- [`.github/workflows/claude-review.yml`](.github/workflows/claude-review.yml): the advisory **Claude review**, sized by the PR's effective difficulty. Its plan is in [`pr-policy/review-plan.mjs`](pr-policy/review-plan.mjs) and is unit-tested in [`pr-policy/review-plan.test.mjs`](pr-policy/review-plan.test.mjs). See [Claude review](#claude-review).

## PR template

```markdown
## Changes
<!-- What changed and why -->

## Affected areas
<!-- Pages, services, tables, jobs touched -->

## Difficulty
<!-- One of: critical | high | medium | low -->
Difficulty: medium
```

## PR policy rules

The `PR policy` job fails unless every rule below holds. It reports all failures at once, as error annotations, in the job log and in the job summary. Each message says what to change.

| Rule | Passes | Fails |
| --- | --- | --- |
| Title matches `^(feature\|fix\|hotfix\|docs\|ci): .+` | `fix: refresh expired sessions` | `feat: add login`, `fix(api): x`, `Fix: x`, `chore: bump` |
| Head branch matches `^(feature\|fix\|hotfix\|docs\|ci)/.+` | `fix/session-refresh` | `session-refresh`, `feat/login` |
| Branch type equals title type | `fix: ...` from `fix/...` | `fix: ...` from `feature/...` |
| `## Changes` and `## Affected areas` are present and not empty | text under each heading | heading missing, or only the template's HTML comment under it |
| Exactly one valid `Difficulty: <level>` line, level one of `critical`, `high`, `medium`, `low` (case-insensitive) | `Difficulty: high` | no line, `Difficulty: huge`, two different values, a line inside `<!-- -->` |
| A `docs` PR changes only `**/*.md` and `docs/**` (plus the repo's `docs_paths`) | `README.md`, `docs/img/a.png` | `docs: ...` that also edits `src/a.ts` |
| No merge commits (a commit with more than one parent) | rebased branch | `Merge branch 'development' into fix/x` |

Notes:

- HTML comments and whitespace do not count as section content. Headings match case-insensitively, at any level (`##` is the convention).
- For renames, both the old and the new path count (docs-only and sensitive paths).
- The GitHub API lists at most 250 commits and 3000 files of a PR. A PR with more than 250 commits fails (merge commits cannot be ruled out). A PR with more than 3000 files is treated as touching sensitive paths, and as a `docs` PR it fails.
- The check runs on every PR, including PRs into feature branches. It is made a required check only for PRs into `main` and `development` (via an org ruleset).
- PR data (title, description, commits, files) is read from the GitHub API, fresh on every run, so re-running the job after editing the PR sees the edit. PR code is never checked out.
- **After editing the title or description, re-run the check.** Where `PR policy` is required by the org ruleset, editing the PR does not start a new run (tested on 2026-11-25, even though the workflow lists `edited`). Open the failed `PR policy` check and choose "Re-run jobs", or push a commit. A failing run ends with a notice that says this.

### Release PRs

A PR whose head is `development` and base is `main` in the same repository is a release PR (`is_release=true`):

- the title must be `release: <summary>`, e.g. `release: 2026-11-25`;
- branch-name and merge-commit checks are skipped;
- `## Changes` and `## Affected areas` are still required;
- `Difficulty:` is optional (if present, it must be valid). The path floor still applies.

A `release: ...` title on any other PR fails.

### Path floor and difficulty label

If the PR touches a sensitive path, the effective difficulty is the higher of the declared difficulty and `high` (so `critical` stays `critical`). If no valid difficulty is declared on such a PR, the effective difficulty is `high` (and, outside release PRs, the missing line still fails the check).

The job sets a `difficulty:<effective level>` label on the PR, creates the label in the repo if it is missing, and removes other `difficulty:*` labels. Labeling is best effort: if the token cannot write labels (for example on a PR from a fork), the job logs a warning and does not fail for that reason.

Org default sensitive paths (`DEFAULT_SENSITIVE_PATHS` in [`pr-policy/policy.mjs`](pr-policy/policy.mjs)):

| Area | Globs |
| --- | --- |
| Database | `**/supabase/migrations/**`, `**/supabase/schemas/**`, `**/rls/**`, `**/rls*.sql`, `**/*{_,-,.}rls.sql`, `**/*{_,-,.}rls{_,-,.}*.sql`, `**/policies/**/*.sql` |
| Auth and access | `**/auth/**`, `**/proxy.{ts,js,mjs}`, `**/middleware.{ts,js,mjs}`, `**/middleware/**`, `**/middlewares/**`, `**/authorizer*`, `**/authorizer/**`, `**/session.{ts,js}`, `**/session/**`, `**/sessions/**` |
| Money | `**/billing/**`, `**/payments/**`, `**/credits/**`, `**/stripe/**` |
| Pipeline and infra | `.github/workflows/**`, `.github/actions/**`, `.github/pr-policy.yml`, `**/*.tf`, `**/*.tfvars` |

Glob syntax: globs match the full repo-relative path, case-sensitively. `*` matches within one path segment (dotfiles included), `**` matches any number of segments including none (so `**/auth/**` also matches `auth/x.ts` at the root), `?` matches one character, `{a,b}` matches either alternative.

## Outputs

The job (and the reusable workflow) exposes:

| Output | Values |
| --- | --- |
| `type` | `feature`, `fix`, `hotfix`, `docs`, `ci`, or `release`; empty if the title is invalid |
| `difficulty` | effective difficulty: `low`, `medium`, `high`, `critical`; empty if none was declared and no sensitive path was touched |
| `sensitive` | `true` if a sensitive path was touched, else `false` |
| `is_release` | `true` for a `development` -> `main` release PR, else `false` |

Outputs are set even when the check fails.

## Per-repo config

A repo can add to the defaults with `.github/pr-policy.yml`. It can only add globs, never remove org defaults.

```yaml
# .github/pr-policy.yml
sensitive_paths:            # added to the org default sensitive paths
  - "src/lib/repositories/**"
  - "serverless.ts"
docs_paths:                 # added to **/*.md and docs/** for docs PRs
  - "website/content/**"
```

- The file is read from the PR's **base** branch, not from the PR. A PR cannot weaken its own floor, and a change to the config takes effect only after it is merged. Editing the file is itself a sensitive change.
- Supported syntax is a small YAML subset: comments, blank lines, the two keys above, each followed by a list of `- "glob"` items or an empty `[]`. Quote globs (a value starting with `*` must be quoted, as in real YAML). Unknown keys and other syntax fail the check with the offending line number; the org defaults are still applied for that run.

## Using the policy in a repo

Org ruleset (planned): add `Mdivani-Agency/.github` -> `.github/workflows/pr-policy.yml` as a required workflow for PRs into `main` and `development`. The check is then named `PR policy`.

Reusable workflow, for a repo that wants it now or wants the outputs:

```yaml
# .github/workflows/pr-policy.yml in the target repo
name: PR policy
on:
  pull_request:
    types: [opened, edited, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  policy:
    uses: Mdivani-Agency/.github/.github/workflows/pr-policy.yml@main
    # with:
    #   policy-ref: main   # optional: ref of this repo to load the script from
  after:
    needs: policy
    if: needs.policy.outputs.sensitive == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "difficulty is ${{ needs.policy.outputs.difficulty }}"
```

- The calling workflow must grant `pull-requests: write` and `issues: write` for the label; with read-only permissions the check still runs and only labeling is skipped.
- Called this way, the check name is `<caller job> / PR policy` (`policy / PR policy` above), not `PR policy`. Use that name if you make it a required status check in branch protection.
- The workflow checks out this repo (`ref: main`, or `policy-ref`) to get the script, so the target repo needs no copy of it. In this repo itself it uses the PR's own version of the script, so policy changes test themselves.

## Claude review

The `Claude review` job reviews every PR with [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) and posts its findings as inline comments. How deep it goes depends on the PR's effective difficulty. It is **advisory**: it is not a required check, a missing secret or variable makes it warn and pass, and its findings never block a merge.

It runs on `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`) and as a reusable workflow (`workflow_call`). It runs on every PR, including sub-PRs into feature branches, and **on every push**: a PR that Claude already commented on is reviewed again at the new head. Draft PRs do not start the job (`if: github.event.pull_request.draft != true`); they are reviewed when marked ready.

Advisory does not mean silent. Every run that should review ends in one of three states, shown on the PR in the status comment (below): reviewed (findings, or "No issues found"), skipped with a reason, or failed. A failed review also fails the job.

### Difficulty and the review matrix

The plan step recomputes the effective difficulty with the PR policy module (same rules, same per-repo config, PR read fresh from the API). It does not read the `difficulty:*` label, because PR policy runs at the same time and the label may not exist yet. With no valid `Difficulty:` line, the plan uses the path floor (`high`) if a sensitive path is touched, otherwise `medium`, and says so in the job summary.

| Effective difficulty | Model tier | Review | Extra |
| --- | --- | --- | --- |
| `low`, and every `docs` PR | LOW | code review, medium depth | none |
| `medium` | HIGH | code review, medium depth | none |
| `high` | HIGH | code review, high depth | `/security-review` if a sensitive path is touched |
| `critical` | HIGH | code review, high depth | `/security-review` always; a migration review if `supabase/migrations/**` is touched |

- **Code review** is the `code-review` plugin from the `claude-code-plugins` marketplace (`https://github.com/anthropics/claude-code.git`), run as `/code-review:code-review --comment <PR URL>`. The plugin has no depth flags (its only flag is `--comment`), so the depth is set with an extra system prompt: at high depth its bug agents may read the code around the diff to confirm an issue. The model tier is the main difference between levels.
- **Security review** is Claude Code's built-in `/security-review`, run in its own step with the same OAuth token (not the standalone security-review action, which needs an API key). It posts each finding as an inline comment starting with `Security (<severity>):`.
- **Migration review** is a fixed prompt that checks the changed Supabase migrations for data loss, locking, RLS, `SECURITY DEFINER` functions, ordering and deploy compatibility. Comments start with `Migration:`.
- All steps of one run use the same tier's model.
- The plugin chooses its own sub-agent models (Haiku, Sonnet and an Opus bug agent). On the LOW tier the workflow sets `CLAUDE_CODE_SUBAGENT_MODEL` to the LOW model with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, so every sub-agent runs on the LOW model. On the HIGH tier the plugin keeps its own mix, with the main session on the HIGH model.

### Re-review and thread resolution

The code-review plugin normally stops when Claude has already commented on the PR. The workflow tells it to ignore that condition (and not to skip a PR as trivial), so each push gets a fresh review of the current head. It also passes the open Claude threads, so the same issue is not posted twice.

On a push (`synchronize`), a step before the review follows up on Claude's own threads:

1. The plan step lists the PR's review threads with GraphQL and keeps the ones started by `claude[bot]` (the login the Claude GitHub App posts as) that are still unresolved.
2. Claude, with no skill and at the review's model tier, reads the code at the new head and the commits since its last review. If a thread's issue is fixed, it replies with one line saying what fixed it and resolves the thread (`resolveReviewThread`). If not, or only partly, it leaves the thread open and may reply with what is still missing. Its only GitHub access is `gh api graphql`.
3. Threads a person resolved are never touched. Their location and a one-line summary go to the review step with the instruction not to raise those points again.

If this step fails, the review still runs.

### Status comment and empty runs

The workflow keeps **one status comment per PR**. It is written with the workflow's `GITHUB_TOKEN` (author `github-actions[bot]`, not Claude), found by the hidden marker `<!-- mdivani-claude-review-status -->` and edited on every run. It shows:

- the reviewed commit (short SHA), tier and depth, model, the number of new findings, and the threads the follow-up step resolved;
- whether the security and migration reviews ran (or failed), and whether the review was retried;
- "No issues found on `<sha>`" when there were no findings.

If the comment does not name the PR's latest commit, the review for that commit is missing: re-run the job.

After the code-review step, the workflow checks that Claude (`claude[bot]`) posted something on the PR since the review started: an inline comment, a PR comment or a review. Replies in existing threads do not count, and the start time comes from GitHub's clock. If nothing was posted, it runs the review **once more** with an extra instruction to post a summary. If that also posts nothing, the status comment says "Claude review ran on `<sha>` but produced no output; re-run the job" and the job fails. A code-review step that errors or times out also fails the job, after the status comment is updated. If the PR was closed or turned into a draft during the run, the status comment says so and the job passes.

The CI system prompt also closes the plugin's early exits: it ignores reviews and comments from other bots (for example `chatgpt-codex-connector[bot]`), stops early only for a closed or draft PR, and always finishes with inline comments or one summary comment.

### Transcripts

Each Claude step's transcript (`claude-execution-output.json`) is uploaded as the artifact `claude-review-transcripts-<attempt>`, kept for 7 days, so a review that posted nothing can be debugged. Before the upload, a transcript that contains the OAuth token, the workflow token, or a token-shaped string (`sk-ant-…`, `ghp_`/`ghs_`/… , `github_pat_…`) is dropped and the job warns. The transcripts contain the PR's code and Claude's tool output; artifacts have the same access as the repo.

### Skips

The job passes without reviewing, and says why in the job summary, for:

- release PRs (head `development` into base `main`, same repo);
- draft PRs (they are reviewed when marked ready) and closed PRs;
- PRs from forks (secrets are not available there);
- runs triggered by a bot (claude-code-action does not run for bot actors);
- missing configuration (below): a `::warning::` names exactly what to set;
- PRs that change the calling workflow (the file in `GITHUB_WORKFLOW_REF`; in a target repo, its own `claude-review.yml`). `claude-code-action` refuses to run while that file differs from the default branch. The plan step detects it from the changed files and the workflow also catches the action's own workflow-validation skip. Both write "review skipped: this PR changes the review workflow" to the status comment and pass with a notice. The review works again once the change is merged.

Only the last skip is written to the status comment; drafts never start the job.

### Configuration

| Name | Kind | Value |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | org secret | Claude Code OAuth token |
| `CLAUDE_REVIEW_MODEL_LOW` | org Actions variable | the LOW-tier model ID from the MDI-784 matrix |
| `CLAUDE_REVIEW_MODEL_HIGH` | org Actions variable | the HIGH-tier model ID from the MDI-784 matrix |

Comments are posted by the Claude GitHub App (`claude[bot]`), which must be installed on the repo; the action gets its token through GitHub OIDC (`id-token: write`).

### Tool versions

Claude Code and Bun are installed once per run, not by each Claude step. Each Claude step gets their paths through `path_to_claude_code_executable` and `path_to_bun_executable`, so the action skips its own installs. The `code-review` plugin is still installed by the code-review step, the only step that uses it.

- The versions are pinned in the job `env` of [`claude-review.yml`](.github/workflows/claude-review.yml): `CLAUDE_CODE_VERSION` and `BUN_VERSION`. A check step fails the job if the installed binaries report other versions.
- The binaries are cached with `actions/cache`. The key contains the runner OS, the architecture and both versions. On a hit nothing is downloaded. The cache is saved right after the install, so it is kept even when a later review step fails.
- GitHub scopes caches to the repo and branch. The workflow runs only on PRs, so a PR's first run downloads the tools and saves a cache for that PR. Later pushes to the same PR use the cache. A cache that is not used for 7 days is removed.
- With a custom executable the action no longer starts the session in auto permission mode by default. Each Claude step passes `--permission-mode auto` itself.

**To bump the versions:** read the versions that `anthropics/claude-code-action@v1` installs. Claude Code is `claudeCodeVersion` in [`src/entrypoints/run.ts`](https://github.com/anthropics/claude-code-action/blob/v1/src/entrypoints/run.ts). Bun is `bun-version` in the action's [`action.yml`](https://github.com/anthropics/claude-code-action/blob/v1/action.yml). Set `CLAUDE_CODE_VERSION` and `BUN_VERSION` to those values. The cache key changes with them, so the next run installs the new versions. Keep the versions equal to the action's: an older Claude Code can lack a feature the action relies on.

### Using the review in a repo

Prefer the reusable workflow below. An org ruleset can also run `Mdivani-Agency/.github` -> `.github/workflows/claude-review.yml` as a required workflow, but that makes it a required check: skips and missing configuration still pass, but a review run that errors would block the merge.

Reusable workflow:

```yaml
# .github/workflows/claude-review.yml in the target repo
name: Claude review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  issues: read
  id-token: write
jobs:
  review:
    uses: Mdivani-Agency/.github/.github/workflows/claude-review.yml@main
    secrets: inherit           # passes CLAUDE_CODE_OAUTH_TOKEN
    # with:
    #   policy-ref: main       # optional: ref of this repo to load the plan script from
```

- The caller must grant the four permissions above.
- The workflow checks out this repo (`ref: main`, or `policy-ref`) to get the plan script, then checks out the PR head so Claude can read it. Nothing from the PR is executed. In this repo itself it uses the PR's own version of the script.

## Development

```bash
node --test 'pr-policy/*.test.mjs'
```

Node 22, no dependencies. CI runs the tests on every PR and on pushes to `main` ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

Files in [`pr-policy/`](pr-policy): `policy.mjs` (PR policy rules), `review-plan.mjs` (Claude review plan, prompts and thread handling) and `review-status.mjs` (was anything posted, status comment), all pure and tested; `github.mjs` (API client shared by the entry points); `main.mjs`, `review-main.mjs` and `review-status-main.mjs` (workflow entry points).

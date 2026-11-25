# .github

Org-wide defaults for Mdivani-Agency repositories:

- [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md): the default PR template for every repo that has no template of its own.
- [`.github/workflows/pr-policy.yml`](.github/workflows/pr-policy.yml): the **PR policy** check. Its logic is in [`pr-policy/policy.mjs`](pr-policy/policy.mjs) and is unit-tested in [`pr-policy/policy.test.mjs`](pr-policy/policy.test.mjs).

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

## Development

```bash
node --test 'pr-policy/*.test.mjs'
```

Node 22, no dependencies. CI runs the tests on every PR and on pushes to `main` ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

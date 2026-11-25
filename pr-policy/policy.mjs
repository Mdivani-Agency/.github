// PR policy rules for Mdivani-Agency repositories.
//
// Pure logic only: no network, no environment access. `main.mjs` gathers the
// pull request data from the GitHub API and calls `evaluate()`.
// Run the tests with `node --test pr-policy/`.

/** PR types. The title prefix and the branch prefix must both be one of these. */
export const PR_TYPES = ['feature', 'fix', 'hotfix', 'docs', 'ci'];

/** Difficulty levels, lowest first. */
export const DIFFICULTIES = ['low', 'medium', 'high', 'critical'];

/** A PR that touches a sensitive path has at least this difficulty. */
export const SENSITIVE_FLOOR = 'high';

/** Path of the optional per-repo config, read from the PR's base branch. */
export const CONFIG_PATH = '.github/pr-policy.yml';

/**
 * Org default sensitive paths. Touching any of them raises the effective
 * difficulty to at least `high`. A repo can add globs in `.github/pr-policy.yml`
 * (`sensitive_paths:`) but cannot remove these.
 *
 * Glob syntax: matched against the full repo-relative path, case-sensitive.
 * `*` matches within one path segment (dotfiles included), `**` matches any
 * number of segments (including none), `?` one character, `{a,b}` alternatives.
 */
export const DEFAULT_SENSITIVE_PATHS = Object.freeze([
  // Database: migrations, declarative schema, RLS policies
  '**/supabase/migrations/**',
  '**/supabase/schemas/**',
  '**/rls/**',
  '**/rls*.sql',
  '**/*{_,-,.}rls.sql',
  '**/*{_,-,.}rls{_,-,.}*.sql',
  '**/policies/**/*.sql',
  // Auth and access: auth code, Next.js proxy/middleware, authorizers, sessions
  '**/auth/**',
  '**/proxy.{ts,js,mjs}',
  '**/middleware.{ts,js,mjs}',
  '**/middleware/**',
  '**/middlewares/**',
  '**/authorizer*',
  '**/authorizer/**',
  '**/session.{ts,js}',
  '**/session/**',
  '**/sessions/**',
  // Money: billing, payments, credits
  '**/billing/**',
  '**/payments/**',
  '**/credits/**',
  '**/stripe/**',
  // Pipeline and infra: CI workflows, composite actions, Terraform, this policy's config
  '.github/workflows/**',
  '.github/actions/**',
  '.github/pr-policy.yml',
  '**/*.tf',
  '**/*.tfvars',
]);

/** Files a `docs` PR may change. A repo can add globs with `docs_paths:`. */
export const DEFAULT_DOCS_PATHS = Object.freeze(['**/*.md', 'docs/**']);

/** GitHub API caps on the list endpoints used by main.mjs. */
export const COMMITS_API_CAP = 250;
export const FILES_API_CAP = 3000;

const TITLE_PATTERN = `^(${PR_TYPES.join('|')}): .*\\S`;
const BRANCH_PATTERN = `^(${PR_TYPES.join('|')})/.+`;
const TITLE_RE = new RegExp(TITLE_PATTERN);
const BRANCH_RE = new RegExp(BRANCH_PATTERN);
const RELEASE_TITLE_RE = /^release: .*\S/;
const TYPE_LIST = PR_TYPES.join(', ');
const DIFFICULTY_LIST = DIFFICULTIES.join(', ');
const MAX_LISTED = 20;

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

/** Expand `{a,b}` groups (not nested) into separate patterns. */
export function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  const close = glob.indexOf('}', open);
  if (close === -1) return [glob];
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  return glob
    .slice(open + 1, close)
    .split(',')
    .flatMap((alt) => expandBraces(head + alt + tail));
}

function escapeRegExp(ch) {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/** Convert one brace-free glob into an anchored RegExp. */
export function globToRegExp(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      const next = glob[i + 2];
      if (atSegmentStart && next === '/') {
        re += '(?:[^/]*/)*'; // `**/`: zero or more directories
        i += 3;
        continue;
      }
      if (atSegmentStart && next === undefined) {
        re += '.*'; // trailing `**`: everything below
        i += 2;
        continue;
      }
      re += '[^/]*'; // `**` inside a segment behaves like `*`
      i += 2;
      continue;
    }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRegExp(c);
    i += 1;
  }
  return new RegExp(`${re}$`);
}

function normalizePath(p) {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Compile globs into a predicate `(path) => matchedGlob | null`. */
export function compileGlobs(globs) {
  const compiled = globs.flatMap((glob) =>
    expandBraces(normalizePath(glob)).map((g) => ({ glob, re: globToRegExp(g) })),
  );
  return (path) => {
    const p = normalizePath(path);
    const hit = compiled.find(({ re }) => re.test(p));
    return hit ? hit.glob : null;
  };
}

export function matchesGlob(path, glob) {
  return compileGlobs([glob])(path) !== null;
}

// ---------------------------------------------------------------------------
// Per-repo config (.github/pr-policy.yml)
// ---------------------------------------------------------------------------

const CONFIG_KEYS = ['sensitive_paths', 'docs_paths'];

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(text);
    if (!m) throw new Error(`line ${lineNo}: unterminated or malformed double-quoted string`);
    return m[1].replace(/\\(.)/g, '$1');
  }
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
    if (!m) throw new Error(`line ${lineNo}: unterminated or malformed single-quoted string`);
    return m[1].replace(/''/g, "'");
  }
  const value = text.replace(/\s+#.*$/, '').trim();
  if (/^[*&!{}[\]|>@`%,]/.test(value)) {
    throw new Error(`line ${lineNo}: quote the value (${value} starts with a YAML special character), e.g. - "${value}"`);
  }
  return value;
}

/**
 * Parse the per-repo config. Supported YAML subset: comments, blank lines,
 * top-level keys `sensitive_paths:` and `docs_paths:`, each followed by a block
 * list of strings (`- "glob"`) or an empty flow list (`[]`).
 * Throws an Error whose message names the offending line.
 */
export function parseConfig(text) {
  const config = { sensitive_paths: [], docs_paths: [] };
  if (text == null) return config;
  let currentKey = null;
  const seen = new Set();
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/^\s*(#.*)?$/.test(line)) return;
    if (/^\t/.test(line)) throw new Error(`line ${lineNo}: tabs are not allowed for indentation; use spaces`);
    const key = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (key) {
      const [, name, rest] = key;
      if (!CONFIG_KEYS.includes(name)) {
        throw new Error(`line ${lineNo}: unknown key "${name}"; allowed keys: ${CONFIG_KEYS.join(', ')}`);
      }
      if (seen.has(name)) throw new Error(`line ${lineNo}: duplicate key "${name}"`);
      seen.add(name);
      const value = rest.replace(/\s+#.*$/, '').trim();
      if (value === '') currentKey = name;
      else if (value === '[]') currentKey = null;
      else throw new Error(`line ${lineNo}: "${name}" must be a list, written as "${name}:" followed by "  - \\"glob\\"" lines`);
      return;
    }
    const item = /^\s*-\s+(.*)$/.exec(line) ?? /^\s*-$/.exec(line);
    if (item) {
      if (!currentKey) throw new Error(`line ${lineNo}: list item outside of a list key (${CONFIG_KEYS.join(', ')})`);
      const value = parseScalar(item[1] ?? '', lineNo);
      if (!value) throw new Error(`line ${lineNo}: empty glob in "${currentKey}"`);
      config[currentKey].push(value);
      return;
    }
    throw new Error(`line ${lineNo}: unsupported syntax; only "key:" lines and "  - \\"glob\\"" list items are supported`);
  });
  return config;
}

// ---------------------------------------------------------------------------
// PR description
// ---------------------------------------------------------------------------

export function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, '');
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const DIFFICULTY_LINE_RE = /^\s*difficulty\s*:\s*(.*?)\s*$/i;

/**
 * Parse a PR body. Returns:
 *  - sections: Map(lowercased heading text -> content with comments and
 *    Difficulty lines removed, trimmed); first occurrence wins
 *  - difficulties: raw values of every `Difficulty: <value>` line
 */
export function parseBody(body) {
  const lines = stripHtmlComments(body ?? '').split(/\r?\n/);
  const sections = new Map();
  const difficulties = [];
  // Open sections, outermost first. A heading closes every open section of
  // the same or a deeper level, so text under `### Bug fix` inside
  // `## Changes` still counts toward Changes.
  const open = [];
  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const name = heading[2].trim().toLowerCase();
      while (open.length > 0 && open[open.length - 1].level >= level) open.pop();
      const section = { level, lines: [] };
      if (!sections.has(name)) sections.set(name, section);
      open.push(section);
      continue;
    }
    const diff = DIFFICULTY_LINE_RE.exec(line);
    if (diff) {
      difficulties.push(diff[1]);
      continue;
    }
    for (const section of open) section.lines.push(line);
  }
  const contents = new Map();
  for (const [name, s] of sections) contents.set(name, s.lines.join('\n').trim());
  return { sections: contents, difficulties };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function maxDifficulty(a, b) {
  return DIFFICULTIES.indexOf(a) >= DIFFICULTIES.indexOf(b) ? a : b;
}

function listItems(items) {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

function listFiles(paths) {
  return listItems(paths.map((p) => `\`${p}\``));
}

function titleHint(title) {
  const m = /^([A-Za-z]+)(\([^)]*\))?(!)?:/.exec(title);
  if (!m) return '';
  const [, type, scope, bang] = m;
  const lower = type.toLowerCase();
  if (scope || bang) {
    const suggested = lower === 'feat' ? 'feature' : lower;
    return ` PR titles take no scope or "!": write "${suggested}: ..." instead of "${m[0]} ...".`;
  }
  if (lower === 'feat') return ' Use "feature", not "feat".';
  if (PR_TYPES.includes(lower) && lower !== type) return ` Use lowercase "${lower}".`;
  if (!PR_TYPES.includes(lower)) {
    return ` "${type}" is not a PR type; pick the closest of ${TYPE_LIST} (refactors, chores and tests usually go under "fix" or "feature").`;
  }
  return '';
}

function checkTitle(title, isRelease, errors) {
  if (isRelease) {
    if (!RELEASE_TITLE_RE.test(title)) {
      errors.push(
        `Title: a release PR (development -> main) must be titled "release: <summary>", e.g. "release: 2026-11-25". Current title: "${title}". Edit the PR title.`,
      );
    }
    return 'release';
  }
  const m = TITLE_RE.exec(title);
  if (m) return m[1];
  if (/^release:/i.test(title)) {
    errors.push(
      `Title: "release: ..." is only for PRs from development into main. Retitle this PR as "<type>: <summary>" with type one of ${TYPE_LIST}.`,
    );
    return '';
  }
  errors.push(
    `Title: "${title}" does not match "<type>: <summary>" (regex ${TITLE_PATTERN}). Edit the PR title to start with one of ${TYPE_LIST}, then ": " and a summary, e.g. "fix: handle expired session token".${titleHint(title)}`,
  );
  return '';
}

function checkBranch(headRef, titleType, errors) {
  const m = BRANCH_RE.exec(headRef);
  if (!m) {
    const suggested = `${titleType || 'feature'}/${headRef.replace(/^[^/]*\//, '') || 'short-name'}`;
    errors.push(
      `Branch: head branch "${headRef}" does not match "<type>/<name>" (regex ${BRANCH_PATTERN}). Rename the branch (e.g. to "${suggested}"; renaming on GitHub retargets this PR) or open a new PR from a correctly named branch.`,
    );
    return;
  }
  if (titleType && m[1] !== titleType) {
    errors.push(
      `Branch/title mismatch: the title type is "${titleType}" but the branch "${headRef}" has type "${m[1]}". They must be the same: retitle the PR to "${m[1]}: ..." or move the work to a "${titleType}/..." branch.`,
    );
  }
}

function checkSections(sections, errors) {
  for (const [key, label, hint] of [
    ['changes', 'Changes', 'what changed and why'],
    ['affected areas', 'Affected areas', 'the pages, services, tables or jobs touched'],
  ]) {
    if (!sections.has(key)) {
      errors.push(
        `Description: the "## ${label}" section is missing. Add a "## ${label}" heading to the PR description followed by ${hint} (use the PR template).`,
      );
    } else if (!sections.get(key)) {
      errors.push(
        `Description: the "## ${label}" section is empty (HTML comments and whitespace do not count). Write ${hint} under "## ${label}".`,
      );
    }
  }
}

function checkDifficulty(values, required, errors) {
  if (values.length === 0) {
    if (required) {
      errors.push(
        `Difficulty: no "Difficulty: <level>" line found. Add a line "Difficulty: medium" (one of ${DIFFICULTY_LIST}) on its own line in the PR description, outside HTML comments, under "## Difficulty".`,
      );
    }
    return '';
  }
  const normalized = values.map((v) => v.toLowerCase());
  const invalid = values.filter((v, i) => !DIFFICULTIES.includes(normalized[i]));
  if (invalid.length) {
    errors.push(
      `Difficulty: "${invalid[0]}" is not a valid level. Write exactly "Difficulty: <level>" with level one of ${DIFFICULTY_LIST}, e.g. "Difficulty: medium".`,
    );
    return '';
  }
  const distinct = [...new Set(normalized)];
  if (distinct.length > 1) {
    errors.push(
      `Difficulty: found conflicting lines (${distinct.join(', ')}). Keep exactly one "Difficulty: <level>" line in the PR description.`,
    );
    return '';
  }
  return distinct[0];
}

function filePaths(file) {
  return [file.filename, file.previous_filename].filter(Boolean);
}

/**
 * Evaluate a pull request against the policy.
 *
 * @param {object} input
 * @param {object} input.pr  { title, body, headRef, baseRef, headRepo, baseRepo,
 *                             commits (count), changedFiles (count) }
 * @param {Array}  input.commits  GitHub "list PR commits" items ({ sha, parents, commit.message })
 * @param {Array}  input.files    GitHub "list PR files" items ({ filename, previous_filename })
 * @param {string|null} input.configText  `.github/pr-policy.yml` from the base branch, or null
 * @returns {{ errors: string[], notes: string[], outputs: object, declaredDifficulty: string,
 *            sensitiveFiles: Array<{path: string, glob: string}> }}
 */
export function evaluate({ pr, commits = [], files = [], configText = null }) {
  const errors = [];
  const notes = [];
  const title = (pr.title ?? '').trim();
  const headRef = pr.headRef ?? '';
  const baseRef = pr.baseRef ?? '';

  let config;
  try {
    config = parseConfig(configText);
  } catch (err) {
    errors.push(
      `Config: ${CONFIG_PATH} on base branch "${baseRef}" is invalid (${err.message}). Fix it on "${baseRef}" (see the README of Mdivani-Agency/.github for the format); org defaults were used for this run.`,
    );
    config = parseConfig(null);
  }

  const isRelease =
    headRef === 'development' && baseRef === 'main' && (!pr.headRepo || pr.headRepo === pr.baseRepo);

  // Title and branch
  const type = checkTitle(title, isRelease, errors);
  if (!isRelease) checkBranch(headRef, type, errors);

  // Description
  const { sections, difficulties } = parseBody(pr.body);
  checkSections(sections, errors);
  const declaredDifficulty = checkDifficulty(difficulties, !isRelease, errors);

  // Files: path floor and docs-only
  const filesTruncated = typeof pr.changedFiles === 'number' && pr.changedFiles > FILES_API_CAP;
  const isSensitive = compileGlobs([...DEFAULT_SENSITIVE_PATHS, ...config.sensitive_paths]);
  const sensitiveFiles = [];
  for (const file of files) {
    for (const path of filePaths(file)) {
      const glob = isSensitive(path);
      if (glob) {
        sensitiveFiles.push({ path, glob });
        break;
      }
    }
  }
  if (filesTruncated) {
    notes.push(
      `Only ${files.length} of ${pr.changedFiles} changed files could be listed (GitHub API cap ${FILES_API_CAP}); the PR is treated as touching sensitive paths.`,
    );
  }
  const sensitive = sensitiveFiles.length > 0 || filesTruncated;

  let difficulty = declaredDifficulty;
  if (sensitive) {
    difficulty = declaredDifficulty ? maxDifficulty(declaredDifficulty, SENSITIVE_FLOOR) : SENSITIVE_FLOOR;
    const which = sensitiveFiles.length
      ? `Sensitive paths touched: ${listItems(sensitiveFiles.map((f) => `\`${f.path}\` (matches \`${f.glob}\`)`))}.`
      : 'Sensitive paths assumed (file list truncated).';
    if (declaredDifficulty && difficulty !== declaredDifficulty) {
      notes.push(`${which} Effective difficulty raised from ${declaredDifficulty} to ${difficulty}.`);
    } else {
      notes.push(`${which} Effective difficulty is at least ${SENSITIVE_FLOOR}.`);
    }
  }

  if (type === 'docs') {
    if (filesTruncated) {
      errors.push(
        `Docs: this docs PR changes ${pr.changedFiles} files, more than the API can list (${FILES_API_CAP}), so it cannot be verified as docs-only. Split it into smaller PRs.`,
      );
    }
    const isDocs = compileGlobs([...DEFAULT_DOCS_PATHS, ...config.docs_paths]);
    const nonDocs = files.flatMap(filePaths).filter((p) => !isDocs(p));
    if (nonDocs.length) {
      const allowed = [...DEFAULT_DOCS_PATHS, ...config.docs_paths].join(', ');
      errors.push(
        `Docs: a docs PR may only change files matching ${allowed}. These files do not: ${listFiles([...new Set(nonDocs)])}. Move those changes to a separate PR, or retitle the PR and rename the branch to another type (e.g. "fix").`,
      );
    }
  }

  // Merge commits
  if (!isRelease) {
    if (typeof pr.commits === 'number' && pr.commits > COMMITS_API_CAP) {
      errors.push(
        `Commits: the PR has ${pr.commits} commits but the GitHub API lists at most ${COMMITS_API_CAP}, so merge commits cannot be ruled out. Squash or split the PR to ${COMMITS_API_CAP} commits or fewer.`,
      );
    }
    const merges = commits.filter((c) => (c.parents?.length ?? 0) > 1);
    if (merges.length) {
      const listed = merges
        .slice(0, MAX_LISTED)
        .map((c) => `${c.sha.slice(0, 7)} "${(c.commit?.message ?? '').split('\n')[0]}"`)
        .join(', ');
      errors.push(
        `Commits: the PR contains ${merges.length} merge commit(s): ${listed}. Rebase instead of merging: \`git fetch origin && git rebase origin/${baseRef} && git push --force-with-lease\`.`,
      );
    }
  }

  return {
    errors,
    notes,
    declaredDifficulty,
    sensitiveFiles,
    outputs: {
      type,
      difficulty,
      sensitive: String(sensitive),
      is_release: String(isRelease),
    },
  };
}

/** Markdown report for the job summary. */
export function formatSummary(result, prRef = '') {
  const { errors, notes, outputs } = result;
  const lines = [`## PR policy: ${errors.length ? 'FAILED' : 'passed'}${prRef ? ` (${prRef})` : ''}`, ''];
  if (errors.length) {
    lines.push(`${errors.length} problem(s) to fix:`, '');
    errors.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
    lines.push('');
  }
  if (notes.length) {
    lines.push('Notes:', '');
    notes.forEach((n) => lines.push(`- ${n}`));
    lines.push('');
  }
  lines.push('| Output | Value |', '| --- | --- |');
  for (const [k, v] of Object.entries(outputs)) lines.push(`| ${k} | ${v === '' ? '(none)' : `\`${v}\``} |`);
  lines.push('');
  return lines.join('\n');
}

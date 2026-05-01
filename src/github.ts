import { Octokit } from "@octokit/rest";

import type { RepoContext } from "./types.js";

const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

/**
 * Hidden marker embedded in every PR-level summary comment we post. We use it
 * to find prior runs' summary comments so we can minimize them as outdated on
 * the next round, instead of leaving a growing stack of "Cursor automated
 * review" comments at the top of the PR.
 */
export const SUMMARY_COMMENT_MARKER = "<!-- cursor-pr-review:summary -->";

/**
 * Hidden marker for the one-shot notice we post when the Cursor SDK rejects
 * the orchestrator with a plan/account error (e.g. free-plan users hitting
 * Pro-only endpoints). Used to dedupe the notice across re-runs.
 */
export const PLAN_REQUIRED_COMMENT_MARKER =
  "<!-- cursor-pr-review:plan-required -->";

const GITHUB_BOT_LOGIN_SUFFIX = /\[bot\]$/i;

/**
 * GitHub GraphQL often returns `viewer.login` as `github-actions[bot]` while
 * `IssueComment.author.login` on the same token is `github-actions` (Bot type).
 * Compare identities by stripping an optional trailing `[bot]` (case-insensitive)
 * and comparing the base login case-insensitively (GitHub usernames are
 * case-insensitive).
 */
export function githubActorLoginsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null || a === "" || b === "") return false;
  const na = a.replace(GITHUB_BOT_LOGIN_SUFFIX, "").toLowerCase();
  const nb = b.replace(GITHUB_BOT_LOGIN_SUFFIX, "").toLowerCase();
  return na === nb;
}

export function makeOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

export interface PullRequestSnapshot {
  labels: string[];
  title: string;
  body: string;
}

/**
 * Single `pulls.get` call returning the labels, title, and body. We read this
 * once at startup so the orchestrator can decide which steps to run (labels)
 * and feed the format agent (title/body); we don't watch for `unlabeled` /
 * `edited` events mid-run.
 */
export async function getPullRequestSnapshot(
  octokit: Octokit,
  ctx: { owner: string; repo: string; prNumber: number },
): Promise<PullRequestSnapshot> {
  const { data } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  const labels = data.labels
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((n): n is string => Boolean(n));
  return {
    labels,
    title: data.title ?? "",
    body: data.body ?? "",
  };
}

/**
 * Update the PR title and/or body. Thin wrapper around `pulls.update`. Note
 * that `pulls.update` fires the `pull_request: edited` event on GitHub, which
 * this workflow does NOT subscribe to — so this call cannot retrigger the
 * action and create a loop.
 */
export async function updatePullRequestTitleAndBody(
  octokit: Octokit,
  ctx: { owner: string; repo: string; prNumber: number },
  patch: { title?: string; body?: string },
): Promise<void> {
  await octokit.pulls.update({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
  });
}

const DEFAULT_FORMAT_DIFF_MAX_TOTAL_CHARS = 120_000;
const DEFAULT_FORMAT_DIFF_MAX_PATCH_PER_FILE = 25_000;

/**
 * Builds a markdown document of changed files and unified diffs for the format
 * agent. Uses `pulls.listFiles` (same source as the review step). Patches may
 * be missing for binary or very large files; per-file and total size caps
 * avoid blowing the model context.
 */
export async function getPullRequestDiffTextForFormat(
  octokit: Octokit,
  ctx: { owner: string; repo: string; prNumber: number },
  options?: {
    maxTotalChars?: number;
    maxPatchPerFile?: number;
  },
): Promise<string> {
  const maxTotalChars =
    options?.maxTotalChars ?? DEFAULT_FORMAT_DIFF_MAX_TOTAL_CHARS;
  const maxPatchPerFile =
    options?.maxPatchPerFile ?? DEFAULT_FORMAT_DIFF_MAX_PATCH_PER_FILE;

  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    per_page: 100,
  });

  if (files.length === 0) {
    return "(No changed files reported for this PR.)";
  }

  const preamble =
    "PR diff from GitHub API (`pulls.listFiles`). Patch text may be omitted for binary or very large files.\n\n";
  const parts: string[] = [preamble];
  let total = preamble.length;
  let included = 0;

  for (const f of files) {
    let patch = f.patch ?? "";
    if (patch.length > maxPatchPerFile) {
      patch =
        patch.slice(0, maxPatchPerFile) + "\n... [patch truncated for size]\n";
    }
    if (!patch) {
      patch =
        "(No unified diff in API response — e.g. binary, generated, or very large file.)";
    }
    const header = `### ${f.filename}\nstatus: ${f.status ?? "unknown"}, +${f.additions ?? 0} -${f.deletions ?? 0}\n`;
    const block = `${header}\`\`\`diff\n${patch}\n\`\`\`\n\n`;
    if (total + block.length > maxTotalChars) {
      const omitted = files.length - included;
      if (omitted > 0) {
        parts.push(
          `\n... ${omitted} more file(s) omitted (diff size budget exhausted).\n`,
        );
      }
      break;
    }
    parts.push(block);
    total += block.length;
    included++;
  }

  return parts.join("");
}

export async function autoApprove(
  octokit: Octokit,
  ctx: RepoContext,
  body: string,
): Promise<void> {
  await octokit.pulls.createReview({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    event: "APPROVE",
    body,
  });
}

export async function commentOnPR(
  octokit: Octokit,
  ctx: RepoContext,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    body,
  });
}

/** IDs of unresolved review threads whose first comment was authored by the token user (bot). */
export async function listOpenBotReviewThreadIds(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<string[]> {
  const THREADS_QUERY = `
    query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      viewer {
        login
      }
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  interface ThreadNode {
    id: string;
    isResolved: boolean;
    comments: { nodes: Array<{ author: { login: string } | null }> };
  }

  interface ThreadsData {
    viewer: { login: string } | null;
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ThreadNode[];
        };
      } | null;
    } | null;
  }

  const threadIds: string[] = [];
  let after: string | null = null;
  let viewerLogin: string | null = null;

  for (;;) {
    const raw: unknown = await octokit.graphql(THREADS_QUERY, {
      owner: ctx.owner,
      repo: ctx.repo,
      number: ctx.prNumber,
      cursor: after,
    });
    const data = raw as ThreadsData;

    if (viewerLogin === null && data.viewer?.login) {
      viewerLogin = data.viewer.login;
    }

    const pr = data.repository?.pullRequest;
    if (!pr) break;

    const { pageInfo, nodes } = pr.reviewThreads;
    const login = viewerLogin ?? data.viewer?.login;
    if (!login) {
      console.warn("[github] listOpenBotReviewThreadIds: no viewer login; skipping");
      break;
    }

    for (const node of nodes) {
      if (node.isResolved) continue;
      const firstAuthor = node.comments.nodes[0]?.author?.login;
      if (githubActorLoginsMatch(firstAuthor, login)) {
        threadIds.push(node.id);
      }
    }

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }

  return threadIds;
}

export interface ResolveReviewThreadsResult {
  resolved: number;
  failed: number;
}

/** Best-effort: resolve each thread; logs and counts failures without throwing. */
export async function resolveReviewThreads(
  octokit: Octokit,
  threadIds: string[],
): Promise<ResolveReviewThreadsResult> {
  const RESOLVE_MUTATION = `
    mutation ResolveReviewThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }
  `;

  let resolved = 0;
  let failed = 0;

  for (const threadId of threadIds) {
    try {
      await octokit.graphql(RESOLVE_MUTATION, { threadId });
      resolved++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[github] resolve thread ${threadId} failed: ${msg}`);
    }
  }

  return { resolved, failed };
}

/**
 * Node IDs of un-minimized PR-level issue comments authored by the token user
 * whose body contains `marker`. These are the summary comments from prior
 * runs of this action; the orchestrator minimizes them as `OUTDATED` so the
 * PR thread doesn't accumulate stale "Cursor automated review" comments.
 */
export async function listPriorSummaryCommentIds(
  octokit: Octokit,
  ctx: RepoContext,
  marker: string,
): Promise<string[]> {
  const COMMENTS_QUERY = `
    query SummaryComments($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      viewer {
        login
      }
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          comments(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              body
              isMinimized
              author {
                login
              }
            }
          }
        }
      }
    }
  `;

  interface CommentNode {
    id: string;
    body: string | null;
    isMinimized: boolean;
    author: { login: string } | null;
  }

  interface CommentsData {
    viewer: { login: string } | null;
    repository: {
      pullRequest: {
        comments: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: CommentNode[];
        };
      } | null;
    } | null;
  }

  const ids: string[] = [];
  let after: string | null = null;
  let viewerLogin: string | null = null;

  for (;;) {
    const raw: unknown = await octokit.graphql(COMMENTS_QUERY, {
      owner: ctx.owner,
      repo: ctx.repo,
      number: ctx.prNumber,
      cursor: after,
    });
    const data = raw as CommentsData;

    if (viewerLogin === null && data.viewer?.login) {
      viewerLogin = data.viewer.login;
    }

    const pr = data.repository?.pullRequest;
    if (!pr) break;

    const login = viewerLogin ?? data.viewer?.login;
    if (!login) {
      console.warn("[github] listPriorSummaryCommentIds: no viewer login; skipping");
      break;
    }

    for (const c of pr.comments.nodes) {
      if (c.isMinimized) continue;
      if (!githubActorLoginsMatch(c.author?.login, login)) continue;
      if (!c.body || !c.body.includes(marker)) continue;
      ids.push(c.id);
    }

    if (!pr.comments.pageInfo.hasNextPage || !pr.comments.pageInfo.endCursor) {
      break;
    }
    after = pr.comments.pageInfo.endCursor;
  }

  return ids;
}

export interface MinimizeCommentsResult {
  minimized: number;
  failed: number;
}

/**
 * Best-effort: mark each comment node ID as minimized with the given
 * classifier (default `OUTDATED`). Failures are logged and counted, never
 * thrown — a permission glitch on a single comment shouldn't take the whole
 * orchestrator down.
 */
export async function minimizeComments(
  octokit: Octokit,
  commentIds: string[],
  classifier: "OUTDATED" | "RESOLVED" = "OUTDATED",
): Promise<MinimizeCommentsResult> {
  const MINIMIZE_MUTATION = `
    mutation MinimizeComment($id: ID!, $classifier: ReportedContentClassifiers!) {
      minimizeComment(input: { subjectId: $id, classifier: $classifier }) {
        minimizedComment {
          isMinimized
        }
      }
    }
  `;

  let minimized = 0;
  let failed = 0;

  for (const id of commentIds) {
    try {
      await octokit.graphql(MINIMIZE_MUTATION, { id, classifier });
      minimized++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[github] minimize comment ${id} failed: ${msg}`);
    }
  }

  return { minimized, failed };
}

export interface AutofixPrInfo {
  url: string;
  number: number;
  reused: boolean;
}

/**
 * Open an autofix PR for `branch` targeting `ctx.headRef`. The autofix agent's
 * contract is to push the branch; the orchestrator owns PR creation so that a
 * successful push always surfaces as a PR (the agent occasionally skipped the
 * MCP create_pull_request call).
 *
 * Verifies the branch is ahead of the head ref, reuses an existing open PR for
 * the same head/base if one exists, otherwise creates a new PR.
 */
export async function openAutofixPr(
  octokit: Octokit,
  ctx: RepoContext,
  branch: string,
  title: string,
  body: string,
): Promise<AutofixPrInfo> {
  let aheadBy: number;
  try {
    const compare = await octokit.repos.compareCommitsWithBasehead({
      owner: ctx.owner,
      repo: ctx.repo,
      basehead: `${ctx.headRef}...${branch}`,
    });
    aheadBy = compare.data.ahead_by;
  } catch (err) {
    const status = (err as { status?: number }).status;
    const msg = err instanceof Error ? err.message : String(err);
    if (status === 404) {
      throw new Error(
        `autofix branch "${branch}" not found on remote (compare 404). ` +
          `The agent likely failed to push.`,
      );
    }
    throw new Error(
      `compare ${ctx.headRef}...${branch} failed: ${msg}`,
    );
  }

  if (aheadBy === 0) {
    throw new Error(
      `autofix branch "${branch}" has no commits ahead of "${ctx.headRef}"`,
    );
  }

  // Reuse an existing open PR for the same head -> base if one already exists.
  const existing = await octokit.pulls.list({
    owner: ctx.owner,
    repo: ctx.repo,
    head: `${ctx.owner}:${branch}`,
    base: ctx.headRef,
    state: "open",
  });

  if (existing.data.length > 0) {
    const pr = existing.data[0]!;
    return { url: pr.html_url, number: pr.number, reused: true };
  }

  const created = await octokit.pulls.create({
    owner: ctx.owner,
    repo: ctx.repo,
    head: branch,
    base: ctx.headRef,
    title,
    body,
  });

  return {
    url: created.data.html_url,
    number: created.data.number,
    reused: false,
  };
}

export interface CodeownersAssignment {
  users: string[];
  teams: string[];
}

export async function requestCodeownersReview(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<CodeownersAssignment | null> {
  const codeowners = await loadCodeowners(octokit, ctx);
  if (!codeowners) {
    console.log("[github] no CODEOWNERS file found; skipping explicit request");
    return null;
  }

  const files = await listChangedFiles(octokit, ctx);
  if (files.length === 0) return null;

  const rules = parseCodeowners(codeowners);
  const usersSet = new Set<string>();
  const teamsSet = new Set<string>();

  for (const file of files) {
    const owners = matchOwners(rules, file);
    for (const owner of owners) {
      if (owner.includes("/")) {
        teamsSet.add(owner.split("/").slice(-1)[0]!);
      } else {
        usersSet.add(owner);
      }
    }
  }

  const users = [...usersSet];
  const teams = [...teamsSet];

  if (users.length === 0 && teams.length === 0) {
    console.log("[github] no CODEOWNERS matched changed files");
    return { users, teams };
  }

  try {
    await octokit.pulls.requestReviewers({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.prNumber,
      reviewers: users,
      team_reviewers: teams,
    });
    console.log(
      `[github] requested reviewers users=[${users.join(",")}] teams=[${teams.join(",")}]`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github] requestReviewers failed: ${msg}`);
  }

  return { users, teams };
}

async function loadCodeowners(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const res = await octokit.repos.getContent({
        owner: ctx.owner,
        repo: ctx.repo,
        path,
        ref: ctx.baseRef,
      });
      if (Array.isArray(res.data) || res.data.type !== "file") continue;
      const content = (res.data as { content?: string; encoding?: string })
        .content;
      if (!content) continue;
      return Buffer.from(content, "base64").toString("utf-8");
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[github] CODEOWNERS load (${path}) failed: ${msg}`);
      }
    }
  }
  return null;
}

async function listChangedFiles(
  octokit: Octokit,
  ctx: RepoContext,
): Promise<string[]> {
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    per_page: 100,
  });
  return files.map((f) => f.filename);
}

interface CodeownersRule {
  pattern: string;
  regex: RegExp;
  owners: string[];
}

function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const pattern = tokens[0];
    if (!pattern) continue;
    const owners = tokens
      .slice(1)
      .filter((o) => o.startsWith("@"))
      .map((o) => o.slice(1));
    if (owners.length === 0) continue;
    rules.push({ pattern, regex: codeownersToRegex(pattern), owners });
  }
  return rules;
}

function matchOwners(rules: CodeownersRule[], file: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (rule.regex.test(file)) return rule.owners;
  }
  return [];
}

function codeownersToRegex(pattern: string): RegExp {
  let p = pattern;
  const rooted = p.startsWith("/");
  if (rooted) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);

  let regex = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        regex += ".*";
        i++;
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += "\\" + ch;
    } else {
      regex += ch;
    }
  }

  const prefix = rooted ? "^" : "(^|.*/)";
  const suffix = dirOnly ? "(/.*)?$" : "$";
  return new RegExp(prefix + regex + suffix);
}

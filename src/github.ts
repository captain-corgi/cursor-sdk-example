import { Octokit } from "@octokit/rest";

import type { RepoContext } from "./types.js";

const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

export function makeOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
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

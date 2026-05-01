import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { Octokit } from "@octokit/rest";

import { buildFormatPrompt } from "./format.js";
import { getPullRequestDiffTextForFormat } from "./github.js";
import type { RepoContext } from "./types.js";

const ctx: RepoContext = {
  owner: "octo",
  repo: "demo",
  prNumber: 7,
  prUrl: "https://github.com/octo/demo/pull/7",
  prTitle: "Add feature",
  prBody: "Author body with important context.",
  repoUrl: "https://github.com/octo/demo",
  headRef: "feature",
  baseRef: "main",
  labels: [],
};

// ── buildFormatPrompt ─────────────────────────────────────────────

describe("buildFormatPrompt (Step 0: format)", () => {
  it("embeds the original title and non-empty body verbatim", () => {
    const p = buildFormatPrompt(ctx, "(diff)");
    assert.match(p, /=== ORIGINAL TITLE ===\nAdd feature/);
    assert.match(p, /=== ORIGINAL BODY ===\nAuthor body with important context\./);
    assert.doesNotMatch(p, /=== ORIGINAL BODY ===\n\(empty\)/);
  });

  it("renders '(empty)' for an empty body", () => {
    const p = buildFormatPrompt({ ...ctx, prBody: "" }, "(diff)");
    assert.match(p, /=== ORIGINAL BODY ===\n\(empty\)/);
  });

  it("renders '(empty)' for a whitespace-only body (treated as empty)", () => {
    const p = buildFormatPrompt({ ...ctx, prBody: "   \n\n  " }, "(diff)");
    assert.match(p, /=== ORIGINAL BODY ===\n\(empty\)/);
  });

  it("includes the PR url, owner/repo, head, base, and the diff summary", () => {
    const p = buildFormatPrompt(ctx, "<<DIFF SUMMARY>>");
    assert.match(p, /pull request https:\/\/github\.com\/octo\/demo\/pull\/7/);
    assert.match(p, /octo\/demo, head=feature, base=main/);
    assert.match(p, /<<DIFF SUMMARY>>/);
  });

  it("documents the format JSON schema, sentinels, and the five body sections", () => {
    const p = buildFormatPrompt(ctx, "(diff)");
    assert.match(p, /<<<CURSOR_FORMAT_JSON>>>/);
    assert.match(p, /<<<END_CURSOR_FORMAT_JSON>>>/);
    assert.match(p, /## Summary/);
    assert.match(p, /## Motivation/);
    assert.match(p, /## Changes/);
    assert.match(p, /## Test Plan/);
    assert.match(p, /## Risk/);
    assert.match(p, /"rewritten"/);
    assert.match(p, /"unchanged"/);
  });
});

// ── getPullRequestDiffTextForFormat ───────────────────────────────

interface FakeFile {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

function mockOctokit(files: FakeFile[]): Octokit {
  return {
    paginate: mock.fn(async () => files),
    pulls: { listFiles: () => undefined },
  } as unknown as Octokit;
}

describe("getPullRequestDiffTextForFormat", () => {
  it("returns a placeholder string when no files changed", async () => {
    const octokit = mockOctokit([]);
    const out = await getPullRequestDiffTextForFormat(octokit, {
      owner: "o",
      repo: "r",
      prNumber: 1,
    });
    assert.match(out, /No changed files reported/);
  });

  it("renders one '### filename' block per file with status, additions, deletions, and patch", async () => {
    const octokit = mockOctokit([
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: "@@ -1,1 +1,3 @@\n+a\n+b",
      },
      {
        filename: "src/b.ts",
        status: "added",
        additions: 5,
        deletions: 0,
        patch: "@@ -0,0 +1,5 @@\n+x",
      },
    ]);
    const out = await getPullRequestDiffTextForFormat(octokit, {
      owner: "o",
      repo: "r",
      prNumber: 1,
    });
    assert.match(out, /### src\/a\.ts\nstatus: modified, \+3 -1/);
    assert.match(out, /### src\/b\.ts\nstatus: added, \+5 -0/);
    assert.match(out, /```diff\n@@ -1,1 \+1,3 @@\n\+a\n\+b\n```/);
  });

  it("substitutes a placeholder when patch is missing (binary, generated, etc.)", async () => {
    const octokit = mockOctokit([
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    ]);
    const out = await getPullRequestDiffTextForFormat(octokit, {
      owner: "o",
      repo: "r",
      prNumber: 1,
    });
    assert.match(out, /No unified diff in API response/);
  });

  it("truncates per-file patch when it exceeds maxPatchPerFile", async () => {
    const big = "x".repeat(200);
    const octokit = mockOctokit([
      { filename: "huge.ts", status: "modified", patch: big },
    ]);
    const out = await getPullRequestDiffTextForFormat(
      octokit,
      { owner: "o", repo: "r", prNumber: 1 },
      { maxPatchPerFile: 50 },
    );
    assert.match(out, /\[patch truncated for size\]/);
    // The first 50 'x' chars must be present, but not all 200
    assert.ok(out.includes("x".repeat(50)));
    assert.ok(!out.includes("x".repeat(200)));
  });

  it("stops adding files once the total budget is exhausted and reports the omitted count", async () => {
    const patch = "y".repeat(500);
    const octokit = mockOctokit([
      { filename: "a.ts", patch },
      { filename: "b.ts", patch },
      { filename: "c.ts", patch },
    ]);
    const out = await getPullRequestDiffTextForFormat(
      octokit,
      { owner: "o", repo: "r", prNumber: 1 },
      { maxTotalChars: 800, maxPatchPerFile: 500 },
    );
    assert.match(out, /more file\(s\) omitted/);
    // 'a.ts' should be in, but 'c.ts' should NOT be (budget too small)
    assert.ok(out.includes("a.ts"));
    assert.ok(!out.includes("c.ts"));
  });
});

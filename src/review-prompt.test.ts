import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReviewPrompt } from "./review.js";
import type { RepoContext } from "./types.js";

const ctx: RepoContext = {
  owner: "octo",
  repo: "demo",
  prNumber: 7,
  prUrl: "https://github.com/octo/demo/pull/7",
  prTitle: "Add feature",
  prBody: "",
  repoUrl: "https://github.com/octo/demo",
  headRef: "feature",
  baseRef: "main",
  labels: [],
};

describe("buildReviewPrompt (Step 1: review)", () => {
  it("includes the PR url, owner/repo, head and base refs, and PR number", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /https:\/\/github\.com\/octo\/demo\/pull\/7/);
    assert.match(p, /octo\/demo/);
    assert.match(p, /Head branch: feature/);
    assert.match(p, /Base branch: main/);
    assert.match(p, /PR number: 7/);
  });

  it("instructs the agent to use the github MCP tools and post inline comments", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /github MCP tools/);
    assert.match(p, /create_pull_request_review/);
    assert.match(p, /event: "COMMENT"/);
  });

  it("documents the review JSON schema and sentinels", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /<<<CURSOR_REVIEW_JSON>>>/);
    assert.match(p, /<<<END_CURSOR_REVIEW_JSON>>>/);
    assert.match(p, /"complexity"/);
    assert.match(p, /"findings"/);
    assert.match(p, /"autofixable"/);
  });

  it("defines the autofixable rule and complexity tiers", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /autofixable: true/);
    assert.match(p, /"low"/);
    assert.match(p, /"medium"/);
    assert.match(p, /"high"/);
  });
});

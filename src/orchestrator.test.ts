import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildApprovalBody,
  buildAutofixPrBody,
  buildSummaryCommentBody,
  isSafeToAutoApprove,
} from "./orchestrator-helpers.js";
import type { Finding, RepoContext, ReviewResult } from "./types.js";

const ctx: RepoContext = {
  owner: "octo",
  repo: "demo",
  prNumber: 12,
  prUrl: "https://github.com/octo/demo/pull/12",
  prTitle: "Add feature",
  prBody: "",
  repoUrl: "https://github.com/octo/demo",
  headRef: "feature",
  baseRef: "main",
  labels: ["cursor-review", "cursor-autofix"],
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    file: "src/a.ts",
    line: 5,
    severity: "low",
    title: "unused import",
    description: "remove it",
    autofixable: true,
    ...over,
  };
}

function review(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    complexity: "low",
    summary: "Small change.",
    findings: [],
    ...over,
  };
}

// ── buildApprovalBody ──────────────────────────────────────────────

describe("buildApprovalBody", () => {
  it("includes the summary", () => {
    const body = buildApprovalBody("All good.", { attempted: false });
    assert.match(body, /Automated approval/);
    assert.match(body, /\*\*Summary:\*\* All good\./);
    assert.doesNotMatch(body, /Autofix PR/);
  });

  it("appends an Autofix PR link when one was opened", () => {
    const body = buildApprovalBody("ok", {
      attempted: true,
      fixPrUrl: "https://github.com/octo/demo/pull/13",
    });
    assert.match(body, /Autofix PR: https:\/\/github\.com\/octo\/demo\/pull\/13/);
  });

  it("omits the autofix line when attempted but no PR was opened", () => {
    const body = buildApprovalBody("ok", { attempted: true });
    assert.doesNotMatch(body, /Autofix PR/);
  });
});

// ── buildAutofixPrBody ─────────────────────────────────────────────

describe("buildAutofixPrBody", () => {
  it("renders one bullet per finding with file:line", () => {
    const body = buildAutofixPrBody(ctx, [
      finding({ id: "F1", file: "src/a.ts", line: 5 }),
      finding({ id: "F2", file: "src/b.ts", line: undefined, title: "typo" }),
    ]);
    assert.match(body, /\[F1\] unused import.*src\/a\.ts:5/);
    assert.match(body, /\[F2\] typo.*src\/b\.ts/);
    assert.doesNotMatch(body, /src\/b\.ts:/);
    assert.match(body, /head branch \(`feature`\)/);
  });
});

// ── buildSummaryCommentBody ────────────────────────────────────────

describe("buildSummaryCommentBody", () => {
  it("includes the hidden marker, complexity, finding counts and labels", () => {
    const body = buildSummaryCommentBody(ctx, {
      review: review({
        findings: [finding(), finding({ id: "F2", autofixable: false })],
      }),
      autofix: { attempted: false },
    });
    assert.match(body, /<!-- cursor-pr-review:summary -->/);
    assert.match(body, /\*\*Complexity:\*\* `low`/);
    assert.match(body, /Findings:\*\* 2 \(autofixable: 1, blocking: 1\)/);
    assert.match(body, /`cursor-review`, `cursor-autofix`/);
  });

  it("renders '(none)' when no labels present", () => {
    const body = buildSummaryCommentBody(
      { ...ctx, labels: [] },
      { review: review(), autofix: { attempted: false } },
    );
    assert.match(body, /Labels:\*\* \(none\)/);
  });

  it("shows the autofix PR url when one was opened", () => {
    const body = buildSummaryCommentBody(ctx, {
      review: review(),
      autofix: { attempted: true, fixPrUrl: "https://x/pr/1" },
    });
    assert.match(body, /Autofix PR:\*\* https:\/\/x\/pr\/1/);
  });

  it("shows an autofix failure line when error is set", () => {
    const body = buildSummaryCommentBody(ctx, {
      review: review(),
      autofix: { attempted: true, error: "push rejected" },
    });
    assert.match(body, /Autofix:\*\* failed \(push rejected\)/);
  });

  it("shows 'no PR opened' when attempted but neither url nor error", () => {
    const body = buildSummaryCommentBody(ctx, {
      review: review(),
      autofix: { attempted: true },
    });
    assert.match(body, /Autofix:\*\* no PR opened/);
  });

  it("includes the linear issue url when provided", () => {
    const body = buildSummaryCommentBody(ctx, {
      review: review(),
      autofix: { attempted: false },
      linearUrl: "https://linear.app/team/issue/T-1",
    });
    assert.match(body, /Linear issue:\*\* https:\/\/linear\.app\/team\/issue\/T-1/);
  });
});

// ── isSafeToAutoApprove ────────────────────────────────────────────

describe("isSafeToAutoApprove", () => {
  it("approves low-complexity PRs with zero findings and no autofix attempt", () => {
    assert.equal(
      isSafeToAutoApprove(review({ complexity: "low" }), { attempted: false }),
      true,
    );
  });

  it("approves low-complexity PRs whose only findings were autofixed (PR opened)", () => {
    assert.equal(
      isSafeToAutoApprove(
        review({ complexity: "low", findings: [finding({ autofixable: true })] }),
        { attempted: true, fixPrUrl: "https://x/pr/1" },
      ),
      true,
    );
  });

  it("does NOT approve when complexity is medium or high", () => {
    assert.equal(
      isSafeToAutoApprove(review({ complexity: "medium" }), { attempted: false }),
      false,
    );
    assert.equal(
      isSafeToAutoApprove(review({ complexity: "high" }), { attempted: false }),
      false,
    );
  });

  it("does NOT approve when there are blocking findings", () => {
    assert.equal(
      isSafeToAutoApprove(
        review({
          complexity: "low",
          findings: [finding({ autofixable: false })],
        }),
        { attempted: false },
      ),
      false,
    );
  });

  it("does NOT approve when autofix was attempted but no PR opened", () => {
    assert.equal(
      isSafeToAutoApprove(
        review({ complexity: "low", findings: [finding({ autofixable: true })] }),
        { attempted: true, error: "push failed" },
      ),
      false,
    );
  });
});

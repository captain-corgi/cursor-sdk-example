import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAutofixPrompt, shortId } from "./autofix.js";
import type { Finding, RepoContext } from "./types.js";

const ctx: RepoContext = {
  owner: "octo",
  repo: "demo",
  prNumber: 9,
  prUrl: "https://github.com/octo/demo/pull/9",
  prTitle: "Test",
  prBody: "",
  repoUrl: "https://github.com/octo/demo",
  headRef: "feature",
  baseRef: "main",
  labels: [],
};

const findings: Finding[] = [
  {
    id: "F1",
    file: "src/a.ts",
    line: 5,
    severity: "low",
    title: "unused import",
    description: "remove the import",
    autofixable: true,
  },
  {
    id: "F2",
    file: "src/b.ts",
    severity: "medium",
    title: "missing null check",
    description: "guard against null",
    autofixable: true,
  },
];

// ── shortId ────────────────────────────────────────────────────────

describe("shortId", () => {
  it("strips non-alphanumeric chars and truncates to 8", () => {
    assert.equal(shortId("run_abcdef-12345"), "runabcde");
  });

  it("returns 'run' fallback when input has no alphanumerics", () => {
    assert.equal(shortId("---___"), "run");
  });

  it("returns full id if shorter than 8 chars after sanitizing", () => {
    assert.equal(shortId("abc-12"), "abc12");
  });

  it("handles empty string", () => {
    assert.equal(shortId(""), "run");
  });
});

// ── buildAutofixPrompt ─────────────────────────────────────────────

describe("buildAutofixPrompt (Step 2: autofix)", () => {
  const branch = "cursor/autofix/pr-9-runabcde";

  it("references the PR url, owner/repo, head ref, and target branch", () => {
    const p = buildAutofixPrompt(ctx, findings, branch);
    assert.match(p, /https:\/\/github\.com\/octo\/demo\/pull\/9/);
    assert.match(p, /octo\/demo/);
    assert.match(p, /head branch is "feature"/);
    assert.match(p, /branch named exactly "cursor\/autofix\/pr-9-runabcde"/);
  });

  it("forbids pushing to the head branch and forbids opening a PR", () => {
    const p = buildAutofixPrompt(ctx, findings, branch);
    assert.match(p, /must NOT push to that branch directly/);
    assert.match(p, /Do NOT open a pull request/);
    assert.match(p, /create_pull_request/);
  });

  it("includes git identity setup and the OK / NONE sentinels", () => {
    const p = buildAutofixPrompt(ctx, findings, branch);
    assert.match(p, /git config user\.name "Cursor Autofix"/);
    assert.match(p, /<<<CURSOR_AUTOFIX_STATUS>>>/);
    assert.match(p, /<<<END_CURSOR_AUTOFIX_STATUS>>>/);
    assert.match(p, /\nOK\n/);
    assert.match(p, /\nNONE\n/);
  });

  it("renders one numbered block per finding with id, title, file:line, severity, description", () => {
    const p = buildAutofixPrompt(ctx, findings, branch);
    assert.match(p, /1\. \[F1\] unused import/);
    assert.match(p, /File: src\/a\.ts:5/);
    assert.match(p, /Severity: low/);
    assert.match(p, /Description: remove the import/);

    assert.match(p, /2\. \[F2\] missing null check/);
    assert.match(p, /File: src\/b\.ts$/m); // no :line for F2
    assert.match(p, /Severity: medium/);
  });

  it("references the branch name in the example push command", () => {
    const p = buildAutofixPrompt(ctx, findings, branch);
    assert.match(p, /git push -u origin cursor\/autofix\/pr-9-runabcde/);
  });
});

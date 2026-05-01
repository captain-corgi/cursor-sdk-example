import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractFixStatus, runAutofix } from "./autofix.js";
import type { RepoContext } from "./types.js";

const ctx: RepoContext = {
  owner: "octo",
  repo: "demo",
  prNumber: 9,
  prUrl: "https://github.com/octo/demo/pull/9",
  prTitle: "Test PR",
  prBody: "",
  repoUrl: "https://github.com/octo/demo",
  headRef: "feature",
  baseRef: "main",
  labels: [],
};

// ── extractFixStatus ───────────────────────────────────────────────

describe("extractFixStatus", () => {
  it("returns 'ok' for OK between sentinels", () => {
    const raw = "noise\n<<<CURSOR_AUTOFIX_STATUS>>>\nOK\n<<<END_CURSOR_AUTOFIX_STATUS>>>";
    assert.equal(extractFixStatus(raw), "ok");
  });

  it("returns 'none' for NONE", () => {
    const raw = "<<<CURSOR_AUTOFIX_STATUS>>>NONE<<<END_CURSOR_AUTOFIX_STATUS>>>";
    assert.equal(extractFixStatus(raw), "none");
  });

  it("is case-insensitive", () => {
    const raw = "<<<CURSOR_AUTOFIX_STATUS>>> ok <<<END_CURSOR_AUTOFIX_STATUS>>>";
    assert.equal(extractFixStatus(raw), "ok");
  });

  it("returns undefined when sentinels absent", () => {
    assert.equal(extractFixStatus("no sentinels here"), undefined);
  });

  it("returns undefined when end sentinel missing", () => {
    assert.equal(
      extractFixStatus("<<<CURSOR_AUTOFIX_STATUS>>>OK"),
      undefined,
    );
  });

  it("returns undefined for an unrecognized status body", () => {
    const raw =
      "<<<CURSOR_AUTOFIX_STATUS>>>MAYBE<<<END_CURSOR_AUTOFIX_STATUS>>>";
    assert.equal(extractFixStatus(raw), undefined);
  });

  it("uses the LAST sentinel pair when multiple are present", () => {
    const raw = [
      "<<<CURSOR_AUTOFIX_STATUS>>>NONE<<<END_CURSOR_AUTOFIX_STATUS>>>",
      "<<<CURSOR_AUTOFIX_STATUS>>>OK<<<END_CURSOR_AUTOFIX_STATUS>>>",
    ].join("\n");
    assert.equal(extractFixStatus(raw), "ok");
  });
});

// ── runAutofix (no-findings short-circuit) ─────────────────────────

describe("runAutofix", () => {
  it("returns { attempted: false } and never starts an agent when there are no findings", async () => {
    // No agent is constructed because of the early return — this proves
    // the gate works without needing to mock the @cursor/sdk Agent.
    const result = await runAutofix({
      cursorApiKey: "k",
      githubToken: "t",
      ctx,
      findings: [],
      reviewRunId: "run_abc",
      runtime: "local",
      modelId: "auto",
    });
    assert.deepEqual(result, { attempted: false });
  });
});

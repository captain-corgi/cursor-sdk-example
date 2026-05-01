import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { createLinearIssueForReview } from "./linear.js";
import type { Finding, RepoContext, ReviewResult } from "./types.js";

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

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    file: "src/a.ts",
    line: 10,
    severity: "high",
    title: "missing null check",
    description: "Should guard against null inputs.",
    autofixable: false,
    ...over,
  };
}

function review(findings: Finding[]): ReviewResult {
  return { complexity: "medium", summary: "Test.", findings };
}

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = mock.fn(async (url: string, init: RequestInit) => impl(url, init));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fn;
  return fn;
}

afterEach(() => {
  mock.restoreAll();
});

describe("createLinearIssueForReview", () => {
  it("returns null when no blocking (non-autofixable) findings exist", async () => {
    const fn = mockFetch(() => new Response("", { status: 200 }));
    const result = await createLinearIssueForReview({
      apiKey: "k",
      teamId: "t",
      ctx,
      review: review([finding({ autofixable: true })]),
    });
    assert.equal(result, null);
    assert.equal(fn.mock.callCount(), 0);
  });

  it("creates an issue and returns its url for blocking findings", async () => {
    const fn = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: "iss_1",
                  identifier: "TEAM-42",
                  url: "https://linear.app/team/issue/TEAM-42",
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await createLinearIssueForReview({
      apiKey: "secret",
      teamId: "team-uuid",
      ctx,
      review: review([finding(), finding({ id: "F2", autofixable: true })]),
    });

    assert.deepEqual(result, {
      id: "iss_1",
      identifier: "TEAM-42",
      url: "https://linear.app/team/issue/TEAM-42",
    });

    assert.equal(fn.mock.callCount(), 1);
    const [url, init] = fn.mock.calls[0]!.arguments;
    assert.equal(url, "https://api.linear.app/graphql");
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "secret");
    const body = JSON.parse(init.body as string);
    assert.equal(body.variables.input.teamId, "team-uuid");
    assert.match(body.variables.input.title, /Add feature \(#7\)/);
    // Description should mention the only blocking finding
    assert.match(body.variables.input.description, /\[F1\]/);
    assert.doesNotMatch(body.variables.input.description, /\[F2\]/);
  });

  it("throws on non-2xx HTTP responses", async () => {
    mockFetch(() => new Response("server is down", { status: 500 }));
    await assert.rejects(
      () =>
        createLinearIssueForReview({
          apiKey: "k",
          teamId: "t",
          ctx,
          review: review([finding()]),
        }),
      /Linear HTTP 500/,
    );
  });

  it("throws when GraphQL errors are present", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ errors: [{ message: "team not found" }] }),
          { status: 200 },
        ),
    );
    await assert.rejects(
      () =>
        createLinearIssueForReview({
          apiKey: "k",
          teamId: "t",
          ctx,
          review: review([finding()]),
        }),
      /team not found/,
    );
  });

  it("throws when issueCreate.success is false", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ data: { issueCreate: { success: false } } }),
          { status: 200 },
        ),
    );
    await assert.rejects(
      () =>
        createLinearIssueForReview({
          apiKey: "k",
          teamId: "t",
          ctx,
          review: review([finding()]),
        }),
      /success=false/,
    );
  });
});

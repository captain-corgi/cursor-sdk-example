import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  listPriorSummaryCommentIds,
  minimizeComments,
  resolveReviewThreads,
} from "./github.js";
import type { RepoContext } from "./types.js";

const mockCtx: RepoContext = {
  owner: "test-owner",
  repo: "test-repo",
  prNumber: 42,
  prUrl: "https://github.com/test-owner/test-repo/pull/42",
  prTitle: "Test PR",
  repoUrl: "https://github.com/test-owner/test-repo",
  headRef: "feature",
  baseRef: "main",
};

function mockOctokit(graphqlImpl: (query: string, vars: Record<string, unknown>) => unknown) {
  return { graphql: mock.fn(graphqlImpl) } as unknown as Parameters<typeof resolveReviewThreads>[0];
}

// ── resolveReviewThreads ────────────────────────────────────────────

describe("resolveReviewThreads", () => {
  it("resolves all threads and counts successes", async () => {
    const octokit = mockOctokit(async () => ({
      resolveReviewThread: { thread: { id: "t1", isResolved: true } },
    }));

    const result = await resolveReviewThreads(octokit, ["t1", "t2", "t3"]);

    assert.deepEqual(result, { resolved: 3, failed: 0 });
    assert.equal((octokit.graphql as ReturnType<typeof mock.fn>).mock.callCount(), 3);
  });

  it("counts failures and continues on error", async () => {
    let call = 0;
    const octokit = mockOctokit(async () => {
      call++;
      if (call === 2) throw new Error("boom");
      return { resolveReviewThread: { thread: { id: "ok", isResolved: true } } };
    });

    const result = await resolveReviewThreads(octokit, ["t1", "t2", "t3"]);

    assert.deepEqual(result, { resolved: 2, failed: 1 });
    assert.equal((octokit.graphql as ReturnType<typeof mock.fn>).mock.callCount(), 3);
  });

  it("returns zeros for empty input", async () => {
    const octokit = mockOctokit(async () => ({}));
    const result = await resolveReviewThreads(octokit, []);
    assert.deepEqual(result, { resolved: 0, failed: 0 });
    assert.equal((octokit.graphql as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });
});

// ── minimizeComments ────────────────────────────────────────────────

describe("minimizeComments", () => {
  it("minimizes all comments and counts successes", async () => {
    const octokit = mockOctokit(async () => ({
      minimizeComment: { minimizedComment: { isMinimized: true } },
    }));

    const result = await minimizeComments(octokit, ["c1", "c2"]);

    assert.deepEqual(result, { minimized: 2, failed: 0 });
    assert.equal((octokit.graphql as ReturnType<typeof mock.fn>).mock.callCount(), 2);
  });

  it("passes OUTDATED classifier by default", async () => {
    const octokit = mockOctokit(async (_q, vars) => {
      assert.equal(vars.classifier, "OUTDATED");
      return { minimizeComment: { minimizedComment: { isMinimized: true } } };
    });

    await minimizeComments(octokit, ["c1"]);
  });

  it("passes custom classifier when provided", async () => {
    const octokit = mockOctokit(async (_q, vars) => {
      assert.equal(vars.classifier, "RESOLVED");
      return { minimizeComment: { minimizedComment: { isMinimized: true } } };
    });

    await minimizeComments(octokit, ["c1"], "RESOLVED");
  });

  it("counts failures and continues on error", async () => {
    let call = 0;
    const octokit = mockOctokit(async () => {
      call++;
      if (call === 1) throw new Error("nope");
      return { minimizeComment: { minimizedComment: { isMinimized: true } } };
    });

    const result = await minimizeComments(octokit, ["c1", "c2"]);

    assert.deepEqual(result, { minimized: 1, failed: 1 });
  });

  it("returns zeros for empty input", async () => {
    const octokit = mockOctokit(async () => ({}));
    const result = await minimizeComments(octokit, []);
    assert.deepEqual(result, { minimized: 0, failed: 0 });
    assert.equal((octokit.graphql as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });
});

// ── listPriorSummaryCommentIds ──────────────────────────────────────

describe("listPriorSummaryCommentIds", () => {
  const marker = "<!-- cursor-pr-review:summary -->";

  function queryResponse(comments: Array<{ id: string; body: string; isMinimized: boolean; author: string | null }>, hasNext = false, endCursor: string | null = null) {
    return {
      viewer: { login: "cursor-bot[bot]" },
      repository: {
        pullRequest: {
          comments: {
            pageInfo: { hasNextPage: hasNext, endCursor },
            nodes: comments.map((c) => ({
              id: c.id,
              body: c.body,
              isMinimized: c.isMinimized,
              author: c.author ? { login: c.author } : null,
            })),
          },
        },
      },
    };
  }

  it("returns IDs of un-minimized bot comments containing the marker", async () => {
    const octokit = mockOctokit(async () =>
      queryResponse([
        { id: "c1", body: `hello ${marker} world`, isMinimized: false, author: "cursor-bot[bot]" },
        { id: "c2", body: "unrelated comment", isMinimized: false, author: "cursor-bot[bot]" },
        { id: "c3", body: `${marker} minimized`, isMinimized: true, author: "cursor-bot[bot]" },
      ]),
    );

    const ids = await listPriorSummaryCommentIds(octokit, mockCtx, marker);
    assert.deepEqual(ids, ["c1"]);
  });

  it("skips comments from other authors", async () => {
    const octokit = mockOctokit(async () =>
      queryResponse([
        { id: "c1", body: `${marker}`, isMinimized: false, author: "other-user" },
        { id: "c2", body: `${marker}`, isMinimized: false, author: "cursor-bot[bot]" },
      ]),
    );

    const ids = await listPriorSummaryCommentIds(octokit, mockCtx, marker);
    assert.deepEqual(ids, ["c2"]);
  });

  it("paginates when hasNextPage is true", async () => {
    let call = 0;
    const octokit = mockOctokit(async () => {
      call++;
      if (call === 1) {
        return queryResponse(
          [{ id: "c1", body: `${marker}`, isMinimized: false, author: "cursor-bot[bot]" }],
          true,
          "cursor-abc",
        );
      }
      return queryResponse(
        [{ id: "c2", body: `${marker}`, isMinimized: false, author: "cursor-bot[bot]" }],
      );
    });

    const ids = await listPriorSummaryCommentIds(octokit, mockCtx, marker);
    assert.deepEqual(ids, ["c1", "c2"]);
    assert.equal((octokit.graphql as ReturnType<typeof mock.fn>).mock.callCount(), 2);
  });

  it("returns empty when no viewer login", async () => {
    const octokit = mockOctokit(async () => ({
      viewer: null,
      repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
    }));

    const ids = await listPriorSummaryCommentIds(octokit, mockCtx, marker);
    assert.deepEqual(ids, []);
  });
});

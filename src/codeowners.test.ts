import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { Octokit } from "@octokit/rest";

import {
  codeownersToRegex,
  matchOwners,
  parseCodeowners,
  requestCodeownersReview,
} from "./github.js";
import type { RepoContext } from "./types.js";

const ctx: RepoContext = {
  owner: "octo",
  repo: "demo",
  prNumber: 1,
  prUrl: "https://github.com/octo/demo/pull/1",
  prTitle: "x",
  prBody: "",
  repoUrl: "https://github.com/octo/demo",
  headRef: "feature",
  baseRef: "main",
  labels: [],
};

// ── parseCodeowners ───────────────────────────────────────────────

describe("parseCodeowners", () => {
  it("parses non-empty rules and skips comments / blank lines", () => {
    const text = `
# top-level comment
*       @global-owner

# section
src/    @team/backend @alice
docs/*  @docs-owner   # trailing comment kept as token (not preceded by space-#)
`;
    const rules = parseCodeowners(text);
    assert.equal(rules.length, 3);
    assert.deepEqual(
      rules.map((r) => r.pattern),
      ["*", "src/", "docs/*"],
    );
  });

  it("strips the leading '@' from owners", () => {
    const rules = parseCodeowners("* @alice @org/team");
    assert.deepEqual(rules[0]!.owners, ["alice", "org/team"]);
  });

  it("ignores rules with no @owners", () => {
    const rules = parseCodeowners("/foo  bar");
    assert.equal(rules.length, 0);
  });

  it("returns an empty array for an empty string", () => {
    assert.deepEqual(parseCodeowners(""), []);
  });
});

// ── codeownersToRegex ─────────────────────────────────────────────

describe("codeownersToRegex", () => {
  it("rooted patterns ('/foo') match only at repo root", () => {
    const re = codeownersToRegex("/foo.ts");
    assert.ok(re.test("foo.ts"));
    assert.ok(!re.test("src/foo.ts"));
  });

  it("unrooted patterns match at any depth", () => {
    const re = codeownersToRegex("foo.ts");
    assert.ok(re.test("foo.ts"));
    assert.ok(re.test("src/foo.ts"));
    assert.ok(re.test("a/b/foo.ts"));
  });

  it("trailing slash patterns match the directory and its contents", () => {
    const re = codeownersToRegex("/src/");
    assert.ok(re.test("src/a.ts"));
    assert.ok(re.test("src/sub/x.ts"));
    assert.ok(re.test("src"));
  });

  it("'*' matches a single path segment", () => {
    const single = codeownersToRegex("/src/*.ts");
    assert.ok(single.test("src/a.ts"));
    assert.ok(!single.test("src/sub/a.ts"));
  });

  it("'**' spans one or more directory segments", () => {
    // Note: this implementation compiles '**' to `.*` (then keeps the
    // following literal '/'), so '/src/**/*.ts' requires at least one
    // intermediate directory and does NOT match a top-level 'src/a.ts'.
    const multi = codeownersToRegex("/src/**/*.ts");
    assert.ok(multi.test("src/sub/a.ts"));
    assert.ok(multi.test("src/sub/deep/a.ts"));
    assert.ok(!multi.test("other/sub/a.ts"));
  });

  it("escapes regex metacharacters in literal segments", () => {
    const re = codeownersToRegex("/a.b+c");
    assert.ok(re.test("a.b+c"));
    assert.ok(!re.test("aXbXc"));
  });
});

// ── matchOwners ───────────────────────────────────────────────────

describe("matchOwners", () => {
  const text = `
*           @global
/src/       @backend
/src/auth/  @security @backend
*.md        @docs
`;
  const rules = parseCodeowners(text);

  it("uses the LAST matching rule (CODEOWNERS precedence)", () => {
    assert.deepEqual(matchOwners(rules, "src/foo.ts"), ["backend"]);
    assert.deepEqual(matchOwners(rules, "src/auth/login.ts"), [
      "security",
      "backend",
    ]);
  });

  it("falls back to the global rule when no specific rule matches", () => {
    assert.deepEqual(matchOwners(rules, "Makefile"), ["global"]);
  });

  it("matches '*.md' for markdown files anywhere", () => {
    // README.md matches both `*` and `*.md`; last rule wins.
    assert.deepEqual(matchOwners(rules, "README.md"), ["docs"]);
    assert.deepEqual(matchOwners(rules, "docs/intro.md"), ["docs"]);
  });

  it("returns [] when no rules match (empty rules list)", () => {
    assert.deepEqual(matchOwners([], "anything"), []);
  });
});

// ── requestCodeownersReview (end-to-end with mocked octokit) ──────

interface FakeFile {
  filename: string;
}

function mockOctokit(opts: {
  codeowners?: string;
  files?: FakeFile[];
  requestReviewers?: (args: {
    owner: string;
    repo: string;
    pull_number: number;
    reviewers?: string[];
    team_reviewers?: string[];
  }) => Promise<unknown>;
  getContentError?: { status: number };
}): {
  octokit: Octokit;
  requestReviewersFn: ReturnType<typeof mock.fn>;
} {
  const requestReviewersFn = mock.fn(
    opts.requestReviewers ?? (async () => ({ data: {} })),
  );
  const octokit = {
    paginate: mock.fn(async () => opts.files ?? []),
    pulls: {
      listFiles: () => undefined,
      requestReviewers: requestReviewersFn,
    },
    repos: {
      getContent: mock.fn(async () => {
        if (opts.getContentError) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          throw Object.assign(new Error("not found"), opts.getContentError) as any;
        }
        if (opts.codeowners === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          throw Object.assign(new Error("not found"), { status: 404 }) as any;
        }
        return {
          data: {
            type: "file",
            content: Buffer.from(opts.codeowners, "utf-8").toString("base64"),
            encoding: "base64",
          },
        };
      }),
    },
  } as unknown as Octokit;
  return { octokit, requestReviewersFn };
}

describe("requestCodeownersReview (Step 5: CODEOWNERS path)", () => {
  it("returns null when no CODEOWNERS file is found at any path", async () => {
    const { octokit, requestReviewersFn } = mockOctokit({});
    const result = await requestCodeownersReview(octokit, ctx);
    assert.equal(result, null);
    assert.equal(requestReviewersFn.mock.callCount(), 0);
  });

  it("requests users and teams resolved from CODEOWNERS rules", async () => {
    const codeowners = `
*           @global-fallback
/src/       @backend-team-user
/src/auth/  @org/security @alice
`;
    const { octokit, requestReviewersFn } = mockOctokit({
      codeowners,
      files: [{ filename: "src/auth/login.ts" }, { filename: "README.md" }],
    });

    const result = await requestCodeownersReview(octokit, ctx);
    assert.ok(result);
    // 'org/security' is a team (contains '/'); 'alice' and 'global-fallback' are users.
    assert.deepEqual(result!.teams.sort(), ["security"]);
    assert.deepEqual(result!.users.sort(), ["alice", "global-fallback"]);

    assert.equal(requestReviewersFn.mock.callCount(), 1);
    const args = requestReviewersFn.mock.calls[0]!.arguments[0] as {
      owner: string;
      repo: string;
      pull_number: number;
      reviewers?: string[];
      team_reviewers?: string[];
    };
    assert.equal(args.owner, "octo");
    assert.equal(args.repo, "demo");
    assert.equal(args.pull_number, 1);
    assert.deepEqual([...(args.reviewers ?? [])].sort(), [
      "alice",
      "global-fallback",
    ]);
    assert.deepEqual(args.team_reviewers, ["security"]);
  });

  it("returns null when CODEOWNERS file exists but no changed files match", async () => {
    const { octokit, requestReviewersFn } = mockOctokit({
      codeowners: "/src/  @backend",
      files: [],
    });
    const result = await requestCodeownersReview(octokit, ctx);
    assert.equal(result, null);
    assert.equal(requestReviewersFn.mock.callCount(), 0);
  });

  it("returns empty users/teams (and skips request) when CODEOWNERS exists but matches nothing", async () => {
    const { octokit, requestReviewersFn } = mockOctokit({
      codeowners: "/only-this-path  @nobody",
      files: [{ filename: "totally/different.ts" }],
    });
    const result = await requestCodeownersReview(octokit, ctx);
    assert.deepEqual(result, { users: [], teams: [] });
    assert.equal(requestReviewersFn.mock.callCount(), 0);
  });

  it("swallows errors from requestReviewers and still returns the resolved owners", async () => {
    const { octokit, requestReviewersFn } = mockOctokit({
      codeowners: "*  @alice",
      files: [{ filename: "src/x.ts" }],
      requestReviewers: async () => {
        throw new Error("API down");
      },
    });
    const result = await requestCodeownersReview(octokit, ctx);
    assert.deepEqual(result, { users: ["alice"], teams: [] });
    assert.equal(requestReviewersFn.mock.callCount(), 1);
  });
});

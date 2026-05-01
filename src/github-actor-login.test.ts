import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubActorLoginsMatch } from "./github.js";

describe("githubActorLoginsMatch", () => {
  it("matches github-actions bot login variants", () => {
    assert.equal(
      githubActorLoginsMatch("github-actions", "github-actions[bot]"),
      true,
    );
    assert.equal(
      githubActorLoginsMatch("github-actions[bot]", "github-actions"),
      true,
    );
    assert.equal(
      githubActorLoginsMatch("GITHUB-ACTIONS[bot]", "github-actions"),
      true,
    );
  });

  it("matches app bot login variants", () => {
    assert.equal(
      githubActorLoginsMatch("my-cursor-app", "my-cursor-app[bot]"),
      true,
    );
    assert.equal(
      githubActorLoginsMatch("my-cursor-app[bot]", "my-cursor-app[bot]"),
      true,
    );
  });

  it("matches identical logins", () => {
    assert.equal(githubActorLoginsMatch("octocat", "octocat"), true);
    assert.equal(
      githubActorLoginsMatch("github-actions[bot]", "github-actions[bot]"),
      true,
    );
  });

  it("rejects different actors", () => {
    assert.equal(githubActorLoginsMatch("octocat", "octodog"), false);
    assert.equal(githubActorLoginsMatch("app-a[bot]", "app-b[bot]"), false);
  });

  it("rejects nullish or empty", () => {
    assert.equal(githubActorLoginsMatch(undefined, "x"), false);
    assert.equal(githubActorLoginsMatch("x", null), false);
    assert.equal(githubActorLoginsMatch("", "github-actions[bot]"), false);
    assert.equal(githubActorLoginsMatch("github-actions", ""), false);
  });
});

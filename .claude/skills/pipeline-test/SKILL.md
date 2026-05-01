---
name: pipeline-test
description: Run the PR review orchestrator locally against a target PR. Requires all required env vars to be set.
disable-model-invocation: true
allowed-tools: Read, Bash
---

Run the Cursor PR review orchestrator locally against a PR.

## Prerequisites

All required env vars must be set in the shell or via `.env`:
- `CURSOR_API_KEY` — Cursor API key
- `GITHUB_TOKEN` — GitHub personal access token (or PAT with repo + PR scopes)
- `PR_NUMBER` — Target PR number
- `PR_URL` — Full PR URL (e.g. `https://github.com/owner/repo/pull/123`)
- `PR_TITLE` — Current PR title
- `REPO_FULL_NAME` — `owner/repo`
- `REPO_URL` — Clone URL of the repo
- `HEAD_REF` — Head branch name
- `BASE_REF` — Base branch name

Optional:
- `LINEAR_API_KEY` — To file Linear issues
- `LINEAR_TEAM_ID` — Linear team ID
- `CURSOR_RUNTIME` — `local` (default) or `cloud`

## Steps

1. Verify all required env vars are set. If any are missing, list them and stop.
2. Run `npm test` to validate existing tests pass.
3. Run `tsx src/index.ts` to execute the orchestrator.
4. Report the exit code and any output.

## Arguments

Pass a PR number or URL to auto-populate env vars using `gh`:
```
/pipeline-test 123
/pipeline-test https://github.com/owner/repo/pull/123
```

When a PR number/URL is provided, use `gh pr view` and related commands to fetch `PR_URL`, `PR_TITLE`, `REPO_FULL_NAME`, `REPO_URL`, `HEAD_REF`, and `BASE_REF` automatically.

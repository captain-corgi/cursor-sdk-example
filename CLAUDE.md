# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A GitHub Action that orchestrates Cursor SDK AI agents to automatically review, autofix, and manage PRs. Written in TypeScript (ESM), runs via `tsx` — no build step.

## Commands

```bash
npm install              # Install dependencies (Node >=22)
npm run typecheck        # tsc --noEmit
npm test                 # Run all tests (Node native test runner + tsx)
npm start                # Run tests then execute orchestrator (src/index.ts)
```

**Run a single test file:**
```bash
node --import tsx/esm --test src/github-actor-login.test.ts
```

No linter or formatter is configured in this project.

## Architecture

**Sequential pipeline** in `src/index.ts` — the orchestrator runs 6 steps in order:

| Step | File | What it does | Gate |
|------|------|-------------|------|
| 0 | `src/format.ts` | Rewrite PR title/body from diff | Always-on (opt-out: `cursor-disable-format`) |
| 1 | `src/review.ts` | Review diff, post inline comments | Label: `cursor-review` |
| 2 | `src/autofix.ts` | Push fix commits for autofixable findings | Label: `cursor-autofix` |
| 3 | `src/linear.ts` | File Linear issue for blocking findings | Label: `cursor-autolinear` |
| 4 | `src/index.ts` | Post summary comment | Automatic after review |
| 5 | `src/index.ts` | Auto-approve or request CODEOWNERS review | Automatic after review |

**Key files:**
- `src/github.ts` — All GitHub API interactions via `@octokit/rest` (comments, PRs, review threads, CODEOWNERS parsing, bot comment cleanup)
- `src/parse.ts` — JSON sentinel block parsing from agent output
- `src/types.ts` — Shared types (`RepoContext`, `ReviewResult`, `Finding`, `LABELS`)

**Agent communication protocol:** Each agent emits structured JSON delimited by sentinel strings (e.g., `<<<CURSOR_REVIEW_JSON>>>...<<<END_CURSOR_REVIEW_JSON>>>`). The parse module extracts these from agent stdout.

**Two runtimes:** `CURSOR_RUNTIME=local` (runs on Actions runner) or `cloud` (Cursor-hosted VM). Both use GitHub MCP for API calls.

**Exit codes:** 0=success, 1=permanent startup failure, 2=review run error, 3=review JSON parse failure, 75=transient/retryable error.

## Environment Variables

Required: `CURSOR_API_KEY`, `GITHUB_TOKEN`, `PR_NUMBER`, `PR_URL`, `PR_TITLE`, `REPO_FULL_NAME`, `REPO_URL`, `HEAD_REF`, `BASE_REF`

Optional: `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `CURSOR_RUNTIME` (default: `local`)

## Key Patterns

- **Label gates:** Steps 1–5 are no-ops unless the PR carries `cursor-review`. Steps 2 and 3 require their own labels in addition.
- **Non-blocking failures:** Format, Linear, and cleanup steps log warnings but never block the pipeline.
- **Bot comment cleanup:** Prior bot review threads are resolved and summary comments minimized on each run. Comments are identified by HTML markers (`<!-- cursor-pr-review:summary -->`).
- **Autofix PRs:** Agent pushes commits; orchestrator opens the PR targeting the head branch. Branch naming: `cursor/autofix/pr-{number}-{run-id}`.
- **`await using`** for agent disposal (Cursor SDK disposable pattern).

## Dependencies

- `@cursor/sdk` — Cursor agent creation/execution (local + cloud runtime)
- `@octokit/rest` — GitHub REST + GraphQL API client
- `tsx` — TypeScript execution (dev)

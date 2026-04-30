# Example workflows

Sample GitHub Actions workflows for **downstream repositories** that install the Cursor SDK PR review orchestrator using the [per-repo copy](../USAGE.md#deployment-shape-options) pattern.

These files live under `examples/` so they are **not** picked up as workflows in this repository (GitHub only runs workflows from `.github/workflows/`).

## Files

| File | Purpose |
|------|---------|
| [`cursor-pr-review.yml`](cursor-pr-review.yml) | Drop into `.github/workflows/cursor-pr-review.yml` in your repo after copying `src/`, `package.json`, `package-lock.json`, and `tsconfig.json` from this project. |

## How to use

1. Copy [`cursor-pr-review.yml`](cursor-pr-review.yml) to **your** repo at `.github/workflows/cursor-pr-review.yml` (or another name under `.github/workflows/`).
2. Copy `src/`, `package.json`, `package-lock.json`, and `tsconfig.json` from this project into your repo **root**, next to your own code.
3. In GitHub: add secrets (`CURSOR_API_KEY`, and optionally `LINEAR_API_KEY`) and optionally the `LINEAR_TEAM_ID` variable — see [Usage guideline](../USAGE.md).
4. Open a test PR and confirm the **Cursor PR Review** workflow runs under the **Actions** tab.

## Important: PRs from public forks

This example uses `on: pull_request`. GitHub **does not pass repository secrets** (including `CURSOR_API_KEY` and `LINEAR_API_KEY`) to workflow runs triggered by `pull_request` from a **public fork** — see GitHub's docs on [using secrets in workflows triggered by forks](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions#using-secrets-in-a-workflow). As a result:

- Fork contributors will **not** get a Cursor review on their PRs — the run will fail at the "Run Cursor review orchestrator" step with a missing-secret error.
- The example only reliably works for PRs whose head branch lives in the **same repository** (a developer pushing a topic branch, Dependabot, etc.).
- Private repos can opt into "Send write tokens to workflows from fork pull requests" / "Send secrets and write tokens to workflows from fork pull requests" under **Settings → Actions → General**, but for public repos those toggles are not available.

If you need fork PR coverage you'd need a different trigger such as `pull_request_target` or a `workflow_run` split. **Both require a deliberate security design**: this workflow checks out the PR head and runs `npm ci` against it, which means arbitrary fork code would execute with your secrets attached to the job. Naive `pull_request_target` adoption is a credential-exfiltration risk. See the [fork FAQ in `USAGE.md`](../USAGE.md#faq) for the trade-offs before going down that path.

For prerequisites, runtime choice (`local` vs `cloud`), tuning prompts, and troubleshooting, see **[`USAGE.md`](../USAGE.md)**.

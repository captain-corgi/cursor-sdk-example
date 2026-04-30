# Example workflows

Sample GitHub Actions workflows for **downstream repositories** that install the Cursor SDK PR review orchestrator using the [per-repo copy](../docs/USAGE.md#deployment-shape-options) pattern.

These files live under `examples/` so they are **not** picked up as workflows in this repository (GitHub only runs workflows from `.github/workflows/`).

## Files

| File | Purpose |
|------|---------|
| [`cursor-pr-review.yml`](cursor-pr-review.yml) | Drop into `.github/workflows/cursor-pr-review.yml` in your repo after copying `src/`, `package.json`, `package-lock.json`, and `tsconfig.json` from this project. |

## How to use

1. Copy [`cursor-pr-review.yml`](cursor-pr-review.yml) to **your** repo at `.github/workflows/cursor-pr-review.yml` (or another name under `.github/workflows/`).
2. Copy `src/`, `package.json`, `package-lock.json`, and `tsconfig.json` from this project into your repo **root**, next to your own code.
3. In GitHub: add secrets (`CURSOR_API_KEY`, and optionally `LINEAR_API_KEY`) and optionally the `LINEAR_TEAM_ID` variable — see [Usage guideline](../docs/USAGE.md).
4. Open a test PR and confirm the **Cursor PR Review** workflow runs under the **Actions** tab.

For prerequisites, runtime choice (`local` vs `cloud`), tuning prompts, and troubleshooting, see **[`docs/USAGE.md`](../docs/USAGE.md)**.

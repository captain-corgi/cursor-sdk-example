# Example workflows

These samples live under **`examples/`** only so GitHub does not execute them **in this repository** ([workflows load from `.github/workflows/`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax-for-github-actions#about-yaml-syntax-for-workflows)).

## Prefer the published Action

This project ships **`action.yml` at the repo root** ([composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action)). In downstream repos:

1. Add a workflow file under `.github/workflows/` using the **`pull_request`** trigger (see [`cursor-pr-review.yml`](cursor-pr-review.yml)).
2. Point **`uses:`** at **`YOUR_ORG/THIS_REPO@version`** (semver tag / branch / SHA), where `YOUR_ORG/THIS_REPO` is the fork or upstream that hosts this code.
3. Configure GitHub Secrets / Variables (`CURSOR_API_KEY`, optional Linear, optional `CURSOR_RUNTIME` via the **`cursor-runtime`** input).

The Action runs **`npm ci --omit=dev`** against its **own checkout** (`github.action_path`) and executes the prebuilt **`dist/*.js`** bundle; your workspace stays the **`actions/checkout`** of the consuming repo (`cwd` stays `$GITHUB_WORKSPACE` for **`local`** runtime).

## Fallback: vendor the TypeScript repo

Copy `src/`, `package.json`, `package-lock.json`, `tsconfig.json`, and the older “`npm ci` + `npm start`” workflow if you fork the orchestrator internally and must pin custom prompt logic instead of versioning the Action tags.

See **[`USAGE.md`](../USAGE.md)** for secrets, **`cursor-runtime`** vs cloud, label gates, and fork limitations.

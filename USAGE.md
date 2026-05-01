# Usage Guideline

How to install, configure, operate, and tune the Cursor SDK PR Review Action in your repository.

For the high-level "what it is" and architecture, see the [README](README.md). This document is the operator's guide.

## Table of contents

- [Prerequisites](#prerequisites)
- [Quick start: install in 5 minutes](#quick-start-install-in-5-minutes)
- [What developers see on a PR](#what-developers-see-on-a-pr)
- [Configuring behavior](#configuring-behavior)
- [Operational guidance](#operational-guidance)
- [Troubleshooting](#troubleshooting)
- [Security checklist](#security-checklist)
- [FAQ](#faq)

## Prerequisites

Before you install:

1. **Cursor account with cloud agent access.** The cloud runtime needs the Cursor GitHub App installed on the repo (or org). Without that, the agent cannot clone the repo and the run will fail with a startup error. Install via [https://cursor.com/agents](https://cursor.com/agents) or your team's Cursor admin.
2. **A Cursor API key.** Prefer a **team service-account key** (Team Settings -> Service accounts) over a personal user key — the action runs unattended and shouldn't depend on a single user's credentials.
3. **Repo admin or maintainer access** in GitHub, so you can add secrets, set repo variables, and (optionally) configure branch protection.
4. **Optional: Linear workspace.** Only needed if you want findings filed as Linear issues. You'll need a Linear API key and a team UUID.
5. **Node.js (local development).** Use **22 or newer** (`package.json` `engines`). GitHub Actions workflows in this repo run **`setup-node` with Node 24** and set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` so composite actions align with GitHub’s [Node 20 deprecation on Actions runners](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/).

## Quick start: install in 5 minutes

### 1. Add the workflow (composite Action — recommended)

This repository exposes a **composite GitHub Action** (`action.yml` at the repo root). In **your** repository:

1. Copy this repo’s **`CI & PR review` workflow**: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) merges **verification** (**`check`** job — typecheck, tests, **`dist/` freshness**) with **optional Cursor review** (**`cursor-review`** job after **`check`**). Adapt job names/`on:` as needed. For downstream repos that **`uses:`** a published Action, start from [`examples/cursor-pr-review.yml`](examples/cursor-pr-review.yml) and replace **`YOUR_ORG/cursor-sdk-example`** with the GitHub path and ref (semver tag / branch / SHA).
2. Ensure **`actions/checkout`** runs **before** the Action step so the **`local`** runtime sees the PR’s files in **`$GITHUB_WORKSPACE`**. Fork-friendly checkout is already in that example (**`repository: ${{ github.event.pull_request.head.repo.full_name }}`** with **`head.ref`**).

Consumers do **not** copy **`src/`** or **`package.json`** into every repo anymore; Actions downloads this repo via **`uses:`** and runs **`npm ci --omit=dev`** plus the committed **`dist/`** bundle shipped here.

Vendor fallback (copy **`src/`** + **`npm ci`** + **`npm start`**) stays documented under [Operational guidance](#operational-guidance).

> **Heads up — PRs without `CURSOR_API_KEY` (forks, Dependabot, unset secret).** The bundled job is skipped when `secrets.CURSOR_API_KEY` is empty (`if: secrets != ''`), because GitHub withholds repo secrets for public-fork `pull_request` runs and for Dependabot-triggered runs. See the [fork FAQ](#faq). If you remove that guard, runs fail at the orchestrator with `missing required env: CURSOR_API_KEY`.

### 2. Add secrets

In your repo: **Settings -> Secrets and variables -> Actions -> New repository secret**.

| Secret           | Required | How to obtain                                                                       |
| ---------------- | -------- | ----------------------------------------------------------------------------------- |
| `CURSOR_API_KEY` | yes      | [https://cursor.com/dashboard/cloud-agents](https://cursor.com/dashboard/cloud-agents) (user) or Team Settings -> Service accounts (preferred). |
| `LINEAR_API_KEY` | optional | Linear -> Settings -> API -> Personal API keys. Only needed for Linear integration. |

`GITHUB_TOKEN` is injected automatically by Actions. The workflow already grants it `pull-requests: write`, `issues: write`, `contents: write` (the `contents: write` scope is needed so the `local` runtime can push the autofix branch — see [Choosing a runtime](#choosing-a-runtime)).

### 3. Add variables (only if using Linear)

**Settings -> Secrets and variables -> Actions -> Variables -> New repository variable**:

| Variable         | Required               | Value                                                          |
| ---------------- | ---------------------- | -------------------------------------------------------------- |
| `LINEAR_TEAM_ID` | yes if `LINEAR_API_KEY` set | UUID of the Linear team where issues should be filed (find it in Linear under team settings). |

If either Linear value is missing, the action skips Linear creation and logs a single line — it does **not** fail.

### 4. Add a CODEOWNERS file

For non-auto-approved PRs, the action requests review from owners of the changed files. Without a CODEOWNERS file, no explicit reviewer is added (GitHub's default branch protection rules still apply, if any).

Create `.github/CODEOWNERS`:

```
# Default owners for everything in the repo
*       @your-org/eng-leads

# Specific paths
/src/payments/  @your-org/payments-team @alice
/src/auth/      @your-org/security-team
*.md            @your-org/docs
```

The action's parser supports the common subset: rooted paths (`/foo`), `*` (no slashes), `**` (any depth), trailing `/` for directories, and `?` for a single character. For exotic patterns, treat the action's explicit reviewer request as a hint and rely on branch protection to enforce real CODEOWNERS.

### 5. Open a test PR

Create a small PR in the repo (e.g., a typo fix) and watch the **Cursor PR Review** action run under the **Actions** tab. On success you'll see:

- A summary comment on the PR with complexity, finding counts, and links.
- Inline review comments (if the agent flagged anything).
- An auto-approve, or a CODEOWNERS reviewer assignment.
- Possibly a fix-PR opened against your feature branch.
- Possibly a Linear issue.

## What developers see on a PR

When a PR opens (or is updated), the action runs and produces some combination of:

### A summary comment

```
## Cursor automated review

- Complexity: `low`
- Findings: 2 (autofixable: 1, blocking: 1)
- Autofix PR: https://github.com/your-org/repo/pull/124
- Linear issue: https://linear.app/your-org/issue/ENG-456

Summary: Adds a small validation helper. One missing null check (autofixed) and one
ambiguous error message (filed as Linear issue).
```

### Inline review comments

Posted as a normal GitHub review (`event: COMMENT`). Each addresses a single concrete finding. The agent is instructed to skip praise-only and bikeshed comments.

On every re-run (for example after a new commit), inline review threads from **prior runs by this bot** are auto-resolved, and the PR-level summary comments from prior runs are minimized as outdated, so only the latest round stays expanded in the PR UI. Use **Show resolved** / the "Show outdated" disclosure to see older rounds. Human-authored threads and comments are not changed.

Prior summary comments are identified by a hidden marker (`<!-- cursor-pr-review:summary -->`) embedded in the comment body, so only this action's own summary comments get minimized — any other comment the same bot identity may post is left alone.

### A fix PR (if autofixable findings exist)

Branch name: `cursor/autofix/pr-<original-pr-number>-<short-id>`. PR title: `autofix: review findings for #<original-pr-number>`. PR base: the original feature branch (NOT the default branch). Merging the fix PR pushes commits onto the original PR's head, where they'll be re-reviewed on the next push.

### A Linear issue (if non-autofixable findings exist and Linear is configured)

One issue per PR aggregating all blocking findings as a checklist with file/line references.

### Auto-approval or reviewer request

- **Auto-approval:** approval review with body `Automated approval by Cursor review action.` and a link to the fix PR if any.
- **Reviewer request:** owners parsed from CODEOWNERS for the changed files are added via `pulls.requestReviewers`.

## Configuring behavior

The action's policy lives in code, not config. To tune it, edit these files:

### Choosing a runtime

Both agent calls (review and autofix) can run in either of two runtimes:

- **`local`** (default): the agent runs on the GitHub Actions runner against the workspace **`actions/checkout` already populated** (`$GITHUB_WORKSPACE`). Use for fast/small/private repos — no Cursor GitHub App requirement, no Cursor-hosted VM minutes.
- **`cloud`**: the agent runs in a Cursor-hosted VM that clones the repo via the Cursor GitHub App. Long runs don't consume runner minutes on your Actions job; requires the App on the repo or org.

Comparison:

- **Local:** `git push` for the autofix branch uses the runner's `GITHUB_TOKEN`, so the workflow needs `permissions: contents: write` (already set in the examples). No Cursor GitHub App requirement.
- **Cloud:** commits and PRs happen from the VM using the token you pass to the agent; `contents: write` on the runner token is not strictly required.

How to select it:

- **Published composite Action:** set **`with.cursor-runtime:`** (`local` or `cloud`) on the **`uses:`** step — see [`examples/cursor-pr-review.yml`](examples/cursor-pr-review.yml).
- **Vendored orchestrator:** set **`env: CURSOR_RUNTIME:`** before **`npm start`**.

Only `local` and `cloud` are accepted; anything else fails fast with an env error.

Forks remain unsupported in either runtime: the runner's `GITHUB_TOKEN` cannot push to a fork, and the Cursor App-issued credentials cannot either.

### Change the auto-approve criteria

[`src/index.ts`](src/index.ts), the `safeToAutoApprove` expression:

```typescript
const safeToAutoApprove =
  review.result.complexity === "low" &&
  blocking.length === 0 &&
  (autofix.attempted ? Boolean(autofix.fixPrUrl) : true);
```

Examples of valid tweaks:

- Require complexity to be `low` AND total findings count under a threshold.
- Refuse auto-approval if any finding has severity `high`, even when autofixable.
- Require a label like `auto-approve-ok` on the PR.

### Change the review prompt or rubric

[`src/review.ts`](src/review.ts) -> `buildReviewPrompt`. This is where you encode "what counts as autofixable", "what counts as low complexity", and which dimensions to flag (security, performance, readability, etc.). Keep the JSON sentinel block intact — the parser depends on it.

### Change the autofix policy

[`src/autofix.ts`](src/autofix.ts) -> `buildAutofixPrompt`. The default rule is "fix only mechanical issues; never refactor or change behavior". Tighten or loosen as needed.

### Change Linear issue formatting

[`src/linear.ts`](src/linear.ts) -> `buildDescription`. Change title format, add labels, set priority, etc.

### Change CODEOWNERS resolution

[`src/github.ts`](src/github.ts) -> `requestCodeownersReview`. The default reads the file from the PR's base ref. Adjust paths or matching rules as needed.

### Change triggers

Your workflow's `on:` block — start from [`examples/cursor-pr-review.yml`](examples/cursor-pr-review.yml). The default runs on `opened`, `synchronize`, `reopened`, `labeled`. Add `ready_for_review` if you want to skip drafts.

## Operational guidance

### Deployment shape options

Three common patterns:

1. **Published composite Action (default for consumers).** This repo already ships **`action.yml`** plus a committed **`dist/`** compile; downstream workflows use **`uses: owner/repo@v1`**. Pro: single versioned rollout. Con: you must **`npm run build:action`** and commit **`dist/`** before tagging a release consumers pin to.

2. **Per-repo fork / vendor.** Copy **`src/`**, **`package.json`**, lockfile, **`tsconfig`**, then run **`npm ci` + `npm start`** in the workflow instead of **`uses:`**. Pro: unrestricted fork of prompts/policy. Con: drift across repos.

3. **[Reusable workflow](https://docs.github.com/en/actions/using-workflows/reusing-workflows).** Caller uses **`workflow_call`** and delegates the whole job. Pro: one YAML for callers. Con: less flexible packaging than pinning a semver Action tag.

Prefer **option 1** across multiple repos unless you intentionally fork internals (option **2**) or standardize via org-wide reusable workflows (option **3**).

### Concurrency and cost

- The example workflow [`examples/cursor-pr-review.yml`](examples/cursor-pr-review.yml) uses `concurrency: cursor-pr-review-${{ pr.number }}` with `cancel-in-progress: true` so pushes on the same PR don’t stack parallel agent runs. This repo’s dogfood **`CI & PR review`** workflow merges **`pull_request`** with **`push`-to-main** in [`ci.yml`](.github/workflows/ci.yml) and omitted per-job concurrency there to avoid invalid `pull_request.*` refs on **`push`** events; copy the concurrency block onto **`cursor-review`** if you split workflows or only trigger on pull requests.
- Each PR triggers up to two cloud agent runs (review + autofix). Budget accordingly. To reduce cost, gate by labels (only run on PRs labeled `needs-review`) or by `paths` (only run on `src/**`).

### Permissions

The workflow needs:

- `contents: write` to check out the action source and (for `local` runtime) push the autofix branch back to origin via the runner's `GITHUB_TOKEN`. The bundled workflow defaults to `write` so the local runtime works out of the box; cloud runtime doesn't strictly need it but it doesn't hurt.
- `pull-requests: write` to post reviews, leave comments, and request reviewers.
- `issues: write` to leave PR comments via the issues API.

In `cloud` runtime, the Cursor cloud agent operates on its own clone of your repo. Commits and PR creation happen from inside the cloud VM via the GitHub MCP server using the `GITHUB_TOKEN` you pass to it. In `local` runtime, the agent runs on the Actions runner itself, so the runner's git pushes the autofix branch using its own `GITHUB_TOKEN` (configured by `actions/checkout`'s extraheader) and the GitHub MCP server is only used to open the PR.

### Branch protection interplay

This action **does not** bypass branch protection. If your protection rules require N approving reviews from CODEOWNERS, the action's auto-approve counts as one approval — by the bot identity attached to `GITHUB_TOKEN`. Whether that satisfies your rule depends on whether you allow approvals from the bot. If you don't want bot approvals to satisfy the requirement, switch the action to leave a `COMMENT` review instead of `APPROVE` — change the `event` parameter in [`src/github.ts`](src/github.ts) `autoApprove`.

### Disabling for specific PRs

To skip the action on a given PR, add a `paths-ignore` or a label-based filter to the workflow `on:` block. Or merge with `[skip ci]` in the commit message — but that affects all CI on the merge.

## Troubleshooting

When a run fails, the **Actions log** shows the structured logs from the orchestrator. The first line of every step contains the `agent.agentId` and `run.id` — keep these for support tickets.

### By exit code

| Exit code | Meaning                                            | What to do                                                                                                |
| --------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 0         | Success.                                            | Nothing.                                                                                                  |
| 1         | Permanent startup failure (config, auth, env).      | Check secrets/vars; verify `CURSOR_API_KEY` is correct and the Cursor App has repo access.                |
| 2         | The agent ran but ended in `error` state.           | Inspect the run in the Cursor dashboard using the logged `run.id`. Re-run after fixing.                   |
| 3         | Review output was missing the JSON sentinel block.  | Look at the run transcript — usually the agent ran out of context or strayed off-prompt. Re-run.          |
| 75        | Transient `CursorAgentError` (`isRetryable=true`).  | Re-run the workflow. Usually a brief Cursor backend hiccup.                                               |

### Symptom -> cause

| Symptom                                                       | Likely cause                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `missing required env: CURSOR_API_KEY`                        | Secret not set in the target repo (or set in org-level secrets without exposing to this repo).              |
| `[review] startup failed: ... (retryable=false)`              | API key invalid, Cursor App not installed on the repo, or the repo URL the SDK received is unreachable.    |
| `[autofix] startup failed: ...`                               | Same as above; check that the GitHub PAT used by the GitHub MCP has push and PR-create permissions.        |
| Review never posts inline comments                            | The GitHub MCP can't authenticate with `GITHUB_TOKEN`. The default workflow injects it; verify permissions. |
| Auto-approve fires when you didn't want it                    | Tune `safeToAutoApprove` in `src/index.ts` (e.g., add a label gate).                                        |
| CODEOWNERS reviewer request silently does nothing             | Pattern in CODEOWNERS uses syntax not supported by the simplified parser. Verify branch protection applies. |
| `Linear HTTP 401` or `403`                                    | `LINEAR_API_KEY` missing/expired or the team UUID is wrong.                                                 |
| Fix PR opens but targets `main` instead of the feature branch | Someone changed the prompt in `autofix.ts` and dropped the `base: "${ctx.headRef}"` instruction. Restore it.|

### Logs to look at, in order

1. The Actions run log (top to bottom).
2. The `[review] agent=... run=...` and `[autofix] agent=... run=...` lines.
3. The Cursor dashboard run page using the logged IDs.
4. The original PR's checks/timeline, for the auto-approve or reviewer-request side effects.

## Security checklist

- [ ] `CURSOR_API_KEY` and `LINEAR_API_KEY` live ONLY in GitHub Secrets, never in code or logs. Don't `echo` them.
- [ ] Use a Cursor team service-account key, not a personal user key, so on-/off-boarding doesn't break the action.
- [ ] The Linear API key has scope for **only** the team you intend to file issues into. If your Linear plan supports OAuth or scoped tokens, prefer that over a personal API key.
- [ ] If your repo handles sensitive code, set `cloud.skipReviewerRequest: true` (already set) and verify the Cursor App's permission scope on the repo.
- [ ] Branch protection should still require the human-meaningful approvals you care about; do not rely on the bot's `APPROVE` review as your sole gate.

## FAQ

**Does this work on private repos?**
Yes — but the Cursor GitHub App must be installed on the org/repo, and the API key must belong to a user who has access to that repo (or to a team service account with access).

**Does this work on forks?**
**No, not by default.** On `pull_request`, GitHub does **not** pass repository secrets (including `CURSOR_API_KEY`) for **public forks** ([secrets and forks](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions#using-secrets-in-a-workflow)), so **`secrets.CURSOR_API_KEY` is empty** and the bundled job is **skipped** with `if: ${{ secrets.CURSOR_API_KEY != '' }}` (**Skipped**, not exit 1 — unless that guard was removed).

**Same-repo Dependabot PRs** also **do not receive secrets**, even though the branch lives on the base repo — see [Dependabot and Actions](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions). To run Cursor review, use a workflow where **`CURSOR_API_KEY` exists** for the triggering actor (typically a developer PR from a branch push on your repo).

Private repos can opt into "Send write tokens / secrets to workflows from fork pull requests" under **Settings → Actions → General**, but those toggles are **not** available on public repos; they **do not** change Dependabot’s secret restrictions.

For fork coverage you'd switch the trigger to one of:

- **`pull_request_target`** — runs in the context of the **base** ref (so secrets are exposed), but you must explicitly check out the fork's head ref to actually review the proposed code.
- **`workflow_run`** — splits into a low-privilege run that produces an artifact and a privileged run that consumes it.

**Both require a deliberate security design.** This workflow checks out the PR head and runs `npm ci` (which executes arbitrary lifecycle scripts from the fork's `package.json`/`package-lock.json`) before invoking the orchestrator, with `CURSOR_API_KEY`, `LINEAR_API_KEY`, and a write-scoped `GITHUB_TOKEN` already in the job's environment. Naive `pull_request_target` adoption — checking out `pull_request.head.sha` and running it as-is — is a credential-exfiltration vector: a malicious fork can steal those secrets and push to your default branch. If you do go down this path you should at minimum: (a) require an "ok-to-test"/"safe-to-review" label gated on a maintainer, (b) pin the install step to lockfile-only execution and skip lifecycle scripts (`npm ci --ignore-scripts`), (c) split secrets between the two `workflow_run` jobs so the fork's code never has the raw `CURSOR_API_KEY`, and (d) limit `permissions:` to the minimum each job needs. Fork support is intentionally **out of scope** for the default install in this repo.

**Why not use the Cursor SDK's `autoCreatePR: true` for the fix PR?**
That option opens PRs against the **default branch** of the repo. We need the fix PR to target the original PR's feature branch. The autofix agent uses the GitHub MCP to create the PR explicitly with the right base.

**Can the action approve its own fix PR?**
No — by design. Auto-approval applies only to the PR the action was invoked on (the original PR). The fix PR triggers a separate workflow run and is treated as a normal PR; whether it gets auto-approved depends on its own complexity and findings.

**Why one Linear issue per PR instead of one per finding?**
Configurable choice; the implementation in [`src/linear.ts`](src/linear.ts) aggregates all non-autofixable findings into a single issue. If you prefer one issue per finding, fork `createLinearIssueForReview` to loop and call `issueCreate` per item.

**Can I dry-run this locally?**
Yes — set the env vars from the workflow file (`CURSOR_API_KEY`, `GITHUB_TOKEN`, `PR_NUMBER`, `PR_URL`, `PR_TITLE`, `REPO_FULL_NAME`, `REPO_URL`, `HEAD_REF`, `BASE_REF`, optional Linear vars) and run `npm start` against an existing PR. The agent will post real comments and (if not gated) really auto-approve, so prefer running this in a sandbox repo.

**How do I roll this out to my org?**
Start by enabling on one low-traffic repo for two weeks. Watch for false-positive auto-approvals and irrelevant findings. Tune the prompts in `src/review.ts` based on real signals. Once you're happy, extract into a shared composite action ([Operational guidance](#operational-guidance)) and roll out repo by repo.

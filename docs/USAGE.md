# Usage Guideline

How to install, configure, operate, and tune the Cursor SDK PR Review Action in your repository.

For the high-level "what it is" and architecture, see the [README](../README.md). This document is the operator's guide.

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

## Quick start: install in 5 minutes

### 1. Add the workflow to your repo

Copy `.github/workflows/cursor-pr-review.yml` from this repo into the target repo at the same path, and copy the `src/`, `package.json`, `package-lock.json`, and `tsconfig.json` files alongside it.

A ready-to-copy workflow with inline setup comments lives at [`examples/cursor-pr-review.yml`](../examples/cursor-pr-review.yml).

If you don't want the orchestrator code living in every repo, alternative deployment patterns are listed under [Operational guidance](#operational-guidance).

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

On every re-run (for example after a new commit), inline review threads from **prior runs by this bot** are auto-resolved so only the latest round stays expanded in the PR UI. Use **Show resolved** on the PR to see older rounds. Human-authored threads and the PR-level summary comment are not changed.

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

Both agent calls (review and autofix) can run in either of two runtimes, selected by the `CURSOR_RUNTIME` env var in the workflow:

- `local` (the default): the agent runs on the GitHub Actions runner itself, against the workspace already checked out by `actions/checkout`. Use this for fast/small/private repos that already trust the Actions runner — there's no extra Cursor App requirement, and you don't pay for a Cursor-hosted VM.
- `cloud`: the agent runs in a Cursor-hosted VM that clones the repo via the Cursor GitHub App. Use this for long-running jobs, when you don't want runner minutes burned on agent compute, or when you already have the Cursor GitHub App installed and want the agent's filesystem isolated from the runner.

Comparison:

- **Local:** runs in `$GITHUB_WORKSPACE`. `git push` for the autofix branch uses the runner's `GITHUB_TOKEN`, so the workflow needs `permissions: contents: write` (already set in the bundled workflow). No Cursor GitHub App requirement.
- **Cloud:** runs in a Cursor-hosted VM. The agent clones the repo via the Cursor GitHub App and pushes from inside that VM, so `contents: write` on the runner token is not strictly required. Long runs don't consume runner minutes. Requires the Cursor GitHub App to be installed on the repo or org.

To switch, edit the `CURSOR_RUNTIME` line under the run step's `env:` block in [`.github/workflows/cursor-pr-review.yml`](../.github/workflows/cursor-pr-review.yml). Acceptable values are `local` and `cloud`. Anything else fails fast with an env error.

Forks remain unsupported in either runtime: the runner's `GITHUB_TOKEN` cannot push to a fork, and the Cursor App-issued credentials cannot either.

### Change the auto-approve criteria

[`src/index.ts`](../src/index.ts), the `safeToAutoApprove` expression:

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

[`src/review.ts`](../src/review.ts) -> `buildReviewPrompt`. This is where you encode "what counts as autofixable", "what counts as low complexity", and which dimensions to flag (security, performance, readability, etc.). Keep the JSON sentinel block intact — the parser depends on it.

### Change the autofix policy

[`src/autofix.ts`](../src/autofix.ts) -> `buildAutofixPrompt`. The default rule is "fix only mechanical issues; never refactor or change behavior". Tighten or loosen as needed.

### Change Linear issue formatting

[`src/linear.ts`](../src/linear.ts) -> `buildDescription`. Change title format, add labels, set priority, etc.

### Change CODEOWNERS resolution

[`src/github.ts`](../src/github.ts) -> `requestCodeownersReview`. The default reads the file from the PR's base ref. Adjust paths or matching rules as needed.

### Change triggers

[`.github/workflows/cursor-pr-review.yml`](../.github/workflows/cursor-pr-review.yml). The default runs on `opened`, `synchronize`, `reopened`. Add `ready_for_review` if you want to skip drafts.

## Operational guidance

### Deployment shape options

You have three reasonable choices for where the orchestrator code lives:

1. **Per-repo copy (simplest).** Copy `src/`, the workflow, and the package files into each target repo. Pro: zero coordination. Con: drift across repos.
2. **Shared composite action in your org.** Extract the workflow steps into a `your-org/cursor-pr-review-action` repo and reference it from each repo's workflow with `uses: your-org/cursor-pr-review-action@v1`. Pro: single source of truth. Con: requires versioning discipline.
3. **Reusable workflow.** Move the job into a [reusable workflow](https://docs.github.com/en/actions/using-workflows/reusing-workflows) and reference it with `uses: your-org/.github/.github/workflows/cursor-pr-review.yml@main`. Pro: simpler than a composite action. Con: less ergonomic in the consuming repo's UI.

For a single repo, option 1 is fine. For more than three repos, prefer option 2 or 3.

### Concurrency and cost

- The workflow uses `concurrency: cursor-pr-review-${{ pr.number }}` with `cancel-in-progress: true`, so a quick stack of pushes won't spawn parallel cloud runs on the same PR.
- Each PR triggers up to two cloud agent runs (review + autofix). Budget accordingly. To reduce cost, gate by labels (only run on PRs labeled `needs-review`) or by `paths` (only run on `src/**`).

### Permissions

The workflow needs:

- `contents: write` to check out the action source and (for `local` runtime) push the autofix branch back to origin via the runner's `GITHUB_TOKEN`. The bundled workflow defaults to `write` so the local runtime works out of the box; cloud runtime doesn't strictly need it but it doesn't hurt.
- `pull-requests: write` to post reviews, leave comments, and request reviewers.
- `issues: write` to leave PR comments via the issues API.

In `cloud` runtime, the Cursor cloud agent operates on its own clone of your repo. Commits and PR creation happen from inside the cloud VM via the GitHub MCP server using the `GITHUB_TOKEN` you pass to it. In `local` runtime, the agent runs on the Actions runner itself, so the runner's git pushes the autofix branch using its own `GITHUB_TOKEN` (configured by `actions/checkout`'s extraheader) and the GitHub MCP server is only used to open the PR.

### Branch protection interplay

This action **does not** bypass branch protection. If your protection rules require N approving reviews from CODEOWNERS, the action's auto-approve counts as one approval — by the bot identity attached to `GITHUB_TOKEN`. Whether that satisfies your rule depends on whether you allow approvals from the bot. If you don't want bot approvals to satisfy the requirement, switch the action to leave a `COMMENT` review instead of `APPROVE` — change the `event` parameter in [`src/github.ts`](../src/github.ts) `autoApprove`.

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
The default workflow trigger `pull_request` does NOT receive secrets when run from a fork, so the action will fail with a missing-secret error. For forked PRs, switch to `pull_request_target` and add manual safety gates — but doing this requires care, because `pull_request_target` runs the workflow against the base ref, not the fork's head, and you must explicitly check out the fork. This is out of scope for the default install.

**Why not use the Cursor SDK's `autoCreatePR: true` for the fix PR?**
That option opens PRs against the **default branch** of the repo. We need the fix PR to target the original PR's feature branch. The autofix agent uses the GitHub MCP to create the PR explicitly with the right base.

**Can the action approve its own fix PR?**
No — by design. Auto-approval applies only to the PR the action was invoked on (the original PR). The fix PR triggers a separate workflow run and is treated as a normal PR; whether it gets auto-approved depends on its own complexity and findings.

**Why one Linear issue per PR instead of one per finding?**
Configurable choice; the implementation in [`src/linear.ts`](../src/linear.ts) aggregates all non-autofixable findings into a single issue. If you prefer one issue per finding, fork `createLinearIssueForReview` to loop and call `issueCreate` per item.

**Can I dry-run this locally?**
Yes — set the env vars from the workflow file (`CURSOR_API_KEY`, `GITHUB_TOKEN`, `PR_NUMBER`, `PR_URL`, `PR_TITLE`, `REPO_FULL_NAME`, `REPO_URL`, `HEAD_REF`, `BASE_REF`, optional Linear vars) and run `npm start` against an existing PR. The agent will post real comments and (if not gated) really auto-approve, so prefer running this in a sandbox repo.

**How do I roll this out to my org?**
Start by enabling on one low-traffic repo for two weeks. Watch for false-positive auto-approvals and irrelevant findings. Tune the prompts in `src/review.ts` based on real signals. Once you're happy, extract into a shared composite action ([Operational guidance](#operational-guidance)) and roll out repo by repo.

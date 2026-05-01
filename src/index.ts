import { CursorAgentError } from "@cursor/sdk";

import { runAutofix } from "./autofix.js";
import { runFormat } from "./format.js";
import {
  autoApprove,
  commentOnPR,
  getPullRequestDiffTextForFormat,
  getPullRequestSnapshot,
  listOpenBotReviewThreadIds,
  listPriorSummaryCommentIds,
  makeOctokit,
  minimizeComments,
  openAutofixPr,
  PLAN_REQUIRED_COMMENT_MARKER,
  requestCodeownersReview,
  resolveReviewThreads,
  SUMMARY_COMMENT_MARKER,
  updatePullRequestTitleAndBody,
} from "./github.js";
import { createLinearIssueForReview } from "./linear.js";
import {
  buildApprovalBody,
  buildAutofixPrBody,
  buildSummaryCommentBody,
  isSafeToAutoApprove,
} from "./orchestrator-helpers.js";
import { ReviewParseError } from "./parse.js";
import { runReview, ReviewRunError } from "./review.js";
import { LABELS } from "./types.js";
import type { AutofixOutcome, RepoContext, Runtime } from "./types.js";

const EX_OK = 0;
const EX_STARTUP_FAILURE = 1;
const EX_RUN_ERROR = 2;
const EX_PARSE_ERROR = 3;
const EX_TEMPFAIL = 75;

interface Env {
  cursorApiKey: string;
  githubToken: string;
  linearApiKey?: string;
  linearTeamId?: string;
  ctx: RepoContext;
  runtime: Runtime;
  modelId: string;
}

/**
 * Cursor account/plan errors that the orchestrator can't do anything about
 * (e.g. free-plan users hitting Pro-only endpoints during local model
 * validation). Treat as a clean no-op so the GitHub Action doesn't fail for
 * what is fundamentally a user account issue rather than a workflow bug.
 */
function isAccountPlanError(err: unknown): err is CursorAgentError {
  if (!(err instanceof CursorAgentError)) return false;
  const code = err.code ?? "";
  if (code === "plan_required" || code === "unauthorized" || code === "forbidden") {
    return true;
  }
  return /\[(plan_required|unauthorized|forbidden)\]/i.test(err.message);
}

function buildPlanRequiredCommentBody(detail: string): string {
  return [
    PLAN_REQUIRED_COMMENT_MARKER,
    "## Cursor automated review skipped",
    "",
    "The Cursor SDK rejected this run with a plan/account error, so the orchestrator could not start an agent. This is typically because the configured `CURSOR_API_KEY` belongs to an account without access to the model or runtime the action requested (for example, a free-plan account hitting Pro-only endpoints during local model validation).",
    "",
    `**SDK error:** \`${detail}\``,
    "",
    "Check the subscription tied to the `CURSOR_API_KEY` secret here: https://cursor.com/dashboard",
    "",
    "_The action exited cleanly to avoid failing the workflow. Re-run after upgrading or rotating the key._",
  ].join("\n");
}

/**
 * Post a one-shot PR comment explaining the plan/account error, deduped via
 * a hidden marker so re-runs on the same PR don't spam.
 */
async function notifyPlanRequiredOnce(
  octokit: ReturnType<typeof makeOctokit>,
  ctx: RepoContext,
  err: CursorAgentError,
): Promise<void> {
  try {
    const existing = await listPriorSummaryCommentIds(
      octokit,
      ctx,
      PLAN_REQUIRED_COMMENT_MARKER,
    );
    if (existing.length > 0) {
      console.log(
        `[orchestrator] plan-required notice already posted (${existing.length}); skipping new comment`,
      );
      return;
    }
    await commentOnPR(octokit, ctx, buildPlanRequiredCommentBody(err.message));
    console.log("[orchestrator] posted plan-required notice on PR");
  } catch (commentErr) {
    const msg =
      commentErr instanceof Error ? commentErr.message : String(commentErr);
    console.warn(`[orchestrator] failed to post plan-required notice: ${msg}`);
  }
}

async function main(): Promise<number> {
  const env = readEnv();
  console.log(`[orchestrator] runtime=${env.runtime}`);
  const octokit = makeOctokit(env.githubToken);

  try {
    const snapshot = await getPullRequestSnapshot(octokit, env.ctx);
    env.ctx.labels = snapshot.labels;
    env.ctx.prTitle = snapshot.title;
    env.ctx.prBody = snapshot.body;
    console.log(
      `[orchestrator] pr labels: ${env.ctx.labels.length ? env.ctx.labels.join(", ") : "(none)"
      }`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orchestrator] pr snapshot failed: ${msg}`);
  }

  const hasLabel = (l: string): boolean => env.ctx.labels.includes(l);

  // Step 0 — always-on PR title/body normalization, gated only by the opt-out
  // label and a check for the action's own autofix branches (whose titles are
  // generated deterministically by the orchestrator and shouldn't be rewritten).
  const isAutofixBranch = env.ctx.headRef.startsWith("cursor/autofix/");
  const formatDisabled = hasLabel(LABELS.DISABLE_FORMAT);
  if (formatDisabled) {
    console.log(
      `[orchestrator] '${LABELS.DISABLE_FORMAT}' label present; skipping format step.`,
    );
  } else if (isAutofixBranch) {
    console.log(
      `[orchestrator] head '${env.ctx.headRef}' is an autofix branch; skipping format step.`,
    );
  } else {
    try {
      let diffSummary: string;
      try {
        diffSummary = await getPullRequestDiffTextForFormat(octokit, env.ctx);
        console.log(
          `[orchestrator] format diff context: ${diffSummary.length} chars`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator] format diff fetch failed: ${msg}`);
        diffSummary = `(Failed to load PR diff from GitHub: ${msg})`;
      }

      const fmt = await runFormat({
        cursorApiKey: env.cursorApiKey,
        ctx: env.ctx,
        diffSummary,
        runtime: env.runtime,
        modelId: env.modelId,
      });
      if (fmt.error) {
        console.warn(`[orchestrator] format step error: ${fmt.error}`);
        // Format swallows CursorAgentError into `error`. If it was a
        // plan/account error, notify the PR now and bail out cleanly so the
        // (also-doomed) review step doesn't run and produce a duplicate.
        if (/\[(plan_required|unauthorized|forbidden)\]/i.test(fmt.error)) {
          await notifyPlanRequiredOnce(
            octokit,
            env.ctx,
            new CursorAgentError(fmt.error),
          );
          return EX_OK;
        }
      } else if (fmt.changed && fmt.newTitle !== undefined && fmt.newBody !== undefined) {
        await updatePullRequestTitleAndBody(octokit, env.ctx, {
          title: fmt.newTitle,
          body: fmt.newBody,
        });
        env.ctx.prTitle = fmt.newTitle;
        env.ctx.prBody = fmt.newBody;
        console.log(
          `[orchestrator] format applied: ${fmt.notes ?? "(no notes)"}`,
        );
      } else {
        console.log(
          `[orchestrator] format unchanged: ${fmt.notes ?? "(no notes)"}`,
        );
      }
    } catch (err) {
      // Format must never block the rest of the pipeline.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator] format step failed (continuing): ${msg}`);
    }
  }

  if (!hasLabel(LABELS.REVIEW)) {
    console.log(
      `[orchestrator] '${LABELS.REVIEW}' label missing; skipping (no-op).`,
    );
    return EX_OK;
  }

  let priorThreadIds: string[] = [];
  try {
    priorThreadIds = await listOpenBotReviewThreadIds(octokit, env.ctx);
    console.log(
      `[orchestrator] prior bot review threads: ${priorThreadIds.length}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orchestrator] list prior review threads failed: ${msg}`);
  }

  let priorSummaryCommentIds: string[] = [];
  try {
    priorSummaryCommentIds = await listPriorSummaryCommentIds(
      octokit,
      env.ctx,
      SUMMARY_COMMENT_MARKER,
    );
    console.log(
      `[orchestrator] prior bot summary comments: ${priorSummaryCommentIds.length}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orchestrator] list prior summary comments failed: ${msg}`);
  }

  let review: Awaited<ReturnType<typeof runReview>>;
  try {
    review = await runReview({
      cursorApiKey: env.cursorApiKey,
      githubToken: env.githubToken,
      ctx: env.ctx,
      runtime: env.runtime,
      modelId: env.modelId,
    });
  } catch (err) {
    if (isAccountPlanError(err)) {
      await notifyPlanRequiredOnce(octokit, env.ctx, err);
      return EX_OK;
    }
    throw err;
  }

  if (priorThreadIds.length > 0) {
    try {
      const { resolved, failed } = await resolveReviewThreads(
        octokit,
        priorThreadIds,
      );
      console.log(
        `[orchestrator] resolved prior threads: ${resolved} (failed: ${failed})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator] resolve prior threads failed: ${msg}`);
    }
  }

  console.log(
    `[orchestrator] complexity=${review.result.complexity} findings=${review.result.findings.length}`,
  );

  const autofixable = review.result.findings.filter((f) => f.autofixable);
  const blocking = review.result.findings.filter((f) => !f.autofixable);

  let autofix: AutofixOutcome = { attempted: false };
  if (autofixable.length > 0 && hasLabel(LABELS.AUTOFIX)) {
    autofix = await runAutofix({
      cursorApiKey: env.cursorApiKey,
      githubToken: env.githubToken,
      ctx: env.ctx,
      findings: autofixable,
      reviewRunId: review.runId,
      runtime: env.runtime,
      modelId: env.modelId,
    });

    // The agent's contract is to push the branch; the orchestrator opens the
    // PR. This avoids a class of failure where the agent successfully pushed
    // commits but skipped the MCP create_pull_request call, leaving the fix
    // invisible to the user.
    if (autofix.attempted && autofix.branch && !autofix.error) {
      try {
        const prInfo = await openAutofixPr(
          octokit,
          env.ctx,
          autofix.branch,
          `autofix: review findings for #${env.ctx.prNumber}`,
          buildAutofixPrBody(env.ctx, autofixable),
        );
        autofix.fixPrUrl = prInfo.url;
        console.log(
          `[orchestrator] autofix PR ${prInfo.reused ? "reused" : "opened"}: ${prInfo.url}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator] autofix PR creation failed: ${msg}`);
        autofix.error = `pr creation failed: ${msg}`;
      }
    }
  } else if (autofixable.length > 0) {
    console.log(
      `[orchestrator] '${LABELS.AUTOFIX}' label missing; skipping autofix (${autofixable.length} autofixable findings).`,
    );
  }

  let linearUrl: string | undefined;
  if (
    blocking.length > 0 &&
    hasLabel(LABELS.LINEAR) &&
    env.linearApiKey &&
    env.linearTeamId
  ) {
    try {
      const issue = await createLinearIssueForReview({
        apiKey: env.linearApiKey,
        teamId: env.linearTeamId,
        ctx: env.ctx,
        review: review.result,
      });
      linearUrl = issue?.url;
      if (linearUrl) {
        console.log(`[orchestrator] linear issue created: ${linearUrl}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator] linear issue creation failed: ${msg}`);
    }
  } else if (blocking.length > 0 && !hasLabel(LABELS.LINEAR)) {
    console.log(
      `[orchestrator] '${LABELS.LINEAR}' label missing; skipping Linear issue creation.`,
    );
  } else if (blocking.length > 0) {
    console.log("[orchestrator] linear creds not set; skipping issue creation");
  }

  await postSummaryComment(octokit, env.ctx, {
    review: review.result,
    autofix,
    linearUrl,
  });

  if (priorSummaryCommentIds.length > 0) {
    try {
      const { minimized, failed } = await minimizeComments(
        octokit,
        priorSummaryCommentIds,
      );
      console.log(
        `[orchestrator] minimized prior summary comments: ${minimized} (failed: ${failed})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator] minimize prior summary comments failed: ${msg}`);
    }
  }

  if (isSafeToAutoApprove(review.result, autofix)) {
    await autoApprove(
      octokit,
      env.ctx,
      buildApprovalBody(review.result.summary, autofix),
    );
    console.log("[orchestrator] auto-approved");
  } else {
    await requestCodeownersReview(octokit, env.ctx);
    console.log("[orchestrator] requested CODEOWNERS review");
  }

  return EX_OK;
}

function readEnv(): Env {
  const required = [
    "CURSOR_API_KEY",
    "GITHUB_TOKEN",
    "PR_NUMBER",
    "PR_URL",
    "PR_TITLE",
    "REPO_FULL_NAME",
    "REPO_URL",
    "HEAD_REF",
    "BASE_REF",
  ] as const;

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new EnvError(`missing required env: ${missing.join(", ")}`);
  }

  const repoFull = process.env["REPO_FULL_NAME"]!;
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) {
    throw new EnvError(`REPO_FULL_NAME must be "owner/repo", got "${repoFull}"`);
  }

  const prNumberRaw = process.env["PR_NUMBER"]!;
  const prNumber = Number(prNumberRaw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new EnvError(`PR_NUMBER must be a positive integer, got "${prNumberRaw}"`);
  }

  const runtimeRaw = process.env["CURSOR_RUNTIME"]?.toLowerCase() ?? "local";
  if (runtimeRaw !== "cloud" && runtimeRaw !== "local") {
    throw new EnvError(`CURSOR_RUNTIME must be "cloud" or "local", got "${runtimeRaw}"`);
  }
  const runtime = runtimeRaw as Runtime;

  return {
    cursorApiKey: process.env["CURSOR_API_KEY"]!,
    githubToken: process.env["GITHUB_TOKEN"]!,
    linearApiKey: process.env["LINEAR_API_KEY"] || undefined,
    linearTeamId: process.env["LINEAR_TEAM_ID"] || undefined,
    runtime,
    modelId: process.env["CURSOR_MODEL_ID"] || "auto",
    ctx: {
      owner,
      repo,
      prNumber,
      prUrl: process.env["PR_URL"]!,
      prTitle: process.env["PR_TITLE"]!,
      // Body is fetched from the GitHub API at startup (see
      // getPullRequestSnapshot in main); seed empty here so RepoContext is
      // fully populated before that call returns.
      prBody: "",
      repoUrl: process.env["REPO_URL"]!,
      headRef: process.env["HEAD_REF"]!,
      baseRef: process.env["BASE_REF"]!,
      labels: [],
    },
  };
}

class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

async function postSummaryComment(
  octokit: ReturnType<typeof makeOctokit>,
  ctx: RepoContext,
  data: {
    review: import("./types.js").ReviewResult;
    autofix: AutofixOutcome;
    linearUrl?: string;
  },
): Promise<void> {
  try {
    await commentOnPR(octokit, ctx, buildSummaryCommentBody(ctx, data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orchestrator] summary comment failed: ${msg}`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (isAccountPlanError(err)) {
      // Reachable only if a plan/account error escapes a pipeline step that
      // doesn't have its own notify hook (defense-in-depth — main() already
      // handles the format and review paths explicitly).
      console.warn(
        `[orchestrator] skipping pipeline: Cursor account/plan error: ${err.message}`,
      );
      process.exit(EX_OK);
    }
    if (err instanceof CursorAgentError) {
      console.error(
        `[orchestrator] startup failed: ${err.message} (retryable=${err.isRetryable})`,
      );
      process.exit(err.isRetryable ? EX_TEMPFAIL : EX_STARTUP_FAILURE);
    }
    if (err instanceof ReviewRunError) {
      console.error(`[orchestrator] review run errored: ${err.message}`);
      process.exit(EX_RUN_ERROR);
    }
    if (err instanceof ReviewParseError) {
      console.error(`[orchestrator] review parse error: ${err.message}`);
      process.exit(EX_PARSE_ERROR);
    }
    if (err instanceof EnvError) {
      console.error(`[orchestrator] ${err.message}`);
      process.exit(EX_STARTUP_FAILURE);
    }
    console.error(`[orchestrator] unexpected error:`, err);
    process.exit(EX_STARTUP_FAILURE);
  });

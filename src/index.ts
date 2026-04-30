import { CursorAgentError } from "@cursor/sdk";

import { runAutofix } from "./autofix.js";
import {
  autoApprove,
  commentOnPR,
  makeOctokit,
  requestCodeownersReview,
} from "./github.js";
import { createLinearIssueForReview } from "./linear.js";
import { ReviewParseError } from "./parse.js";
import { runReview, ReviewRunError } from "./review.js";
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
}

async function main(): Promise<number> {
  const env = readEnv();
  console.log(`[orchestrator] runtime=${env.runtime}`);
  const octokit = makeOctokit(env.githubToken);

  const review = await runReview({
    cursorApiKey: env.cursorApiKey,
    githubToken: env.githubToken,
    ctx: env.ctx,
    runtime: env.runtime,
  });

  console.log(
    `[orchestrator] complexity=${review.result.complexity} findings=${review.result.findings.length}`,
  );

  const autofixable = review.result.findings.filter((f) => f.autofixable);
  const blocking = review.result.findings.filter((f) => !f.autofixable);

  let autofix: AutofixOutcome = { attempted: false };
  if (autofixable.length > 0) {
    autofix = await runAutofix({
      cursorApiKey: env.cursorApiKey,
      githubToken: env.githubToken,
      ctx: env.ctx,
      findings: autofixable,
      reviewRunId: review.runId,
      runtime: env.runtime,
    });
  }

  let linearUrl: string | undefined;
  if (blocking.length > 0 && env.linearApiKey && env.linearTeamId) {
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
  } else if (blocking.length > 0) {
    console.log("[orchestrator] linear creds not set; skipping issue creation");
  }

  await postSummaryComment(octokit, env.ctx, {
    review: review.result,
    autofix,
    linearUrl,
  });

  const safeToAutoApprove =
    review.result.complexity === "low" &&
    blocking.length === 0 &&
    (autofix.attempted ? Boolean(autofix.fixPrUrl) : true);

  if (safeToAutoApprove) {
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
    ctx: {
      owner,
      repo,
      prNumber,
      prUrl: process.env["PR_URL"]!,
      prTitle: process.env["PR_TITLE"]!,
      repoUrl: process.env["REPO_URL"]!,
      headRef: process.env["HEAD_REF"]!,
      baseRef: process.env["BASE_REF"]!,
    },
  };
}

class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

function buildApprovalBody(summary: string, autofix: AutofixOutcome): string {
  const lines = [
    "Automated approval by Cursor review action.",
    "",
    `**Summary:** ${summary}`,
  ];
  if (autofix.attempted && autofix.fixPrUrl) {
    lines.push("", `Autofix PR: ${autofix.fixPrUrl}`);
  }
  return lines.join("\n");
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
  const lines = [
    "## Cursor automated review",
    "",
    `- **Complexity:** \`${data.review.complexity}\``,
    `- **Findings:** ${data.review.findings.length} (autofixable: ${
      data.review.findings.filter((f) => f.autofixable).length
    }, blocking: ${data.review.findings.filter((f) => !f.autofixable).length})`,
  ];

  if (data.autofix.attempted) {
    if (data.autofix.fixPrUrl) {
      lines.push(`- **Autofix PR:** ${data.autofix.fixPrUrl}`);
    } else if (data.autofix.error) {
      lines.push(`- **Autofix:** failed (${data.autofix.error})`);
    } else {
      lines.push(`- **Autofix:** no PR opened`);
    }
  }

  if (data.linearUrl) {
    lines.push(`- **Linear issue:** ${data.linearUrl}`);
  }

  lines.push("", `**Summary:** ${data.review.summary}`);

  try {
    await commentOnPR(octokit, ctx, lines.join("\n"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orchestrator] summary comment failed: ${msg}`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
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

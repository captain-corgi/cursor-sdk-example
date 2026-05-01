import { SUMMARY_COMMENT_MARKER } from "./github.js";
import type {
  AutofixOutcome,
  Finding,
  RepoContext,
  ReviewResult,
} from "./types.js";

/**
 * Pure builders shared between `index.ts` (the orchestrator entrypoint) and
 * its unit tests. Importing `index.ts` directly is unsafe in tests because it
 * invokes `main()` at module load.
 */

export function buildApprovalBody(
  summary: string,
  autofix: AutofixOutcome,
): string {
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

export function buildAutofixPrBody(
  ctx: RepoContext,
  autofixable: Finding[],
): string {
  const lines = [
    `Automated autofix for findings on ${ctx.prUrl}.`,
    "",
    `Targets the original PR's head branch (\`${ctx.headRef}\`). Merge this PR to land the fixes; close it (and delete the branch) if you want to ignore the autofix and address the findings manually.`,
    "",
    `## Findings addressed`,
    "",
  ];
  for (const f of autofixable) {
    const lineSuffix = f.line !== undefined ? `:${f.line}` : "";
    lines.push(
      `- **[${f.id}] ${f.title}** (severity: ${f.severity}) — \`${f.file}${lineSuffix}\``,
    );
  }
  lines.push(
    "",
    `Note: the autofix agent may have skipped findings it could not safely apply. Check the commit messages for any \`skipped\` notes.`,
  );
  return lines.join("\n");
}

export function buildSummaryCommentBody(
  ctx: RepoContext,
  data: {
    review: ReviewResult;
    autofix: AutofixOutcome;
    linearUrl?: string;
  },
): string {
  const labelsLine = ctx.labels.length
    ? ctx.labels.map((l) => `\`${l}\``).join(", ")
    : "(none)";

  const lines = [
    SUMMARY_COMMENT_MARKER,
    "## Cursor automated review",
    "",
    `- **Complexity:** \`${data.review.complexity}\``,
    `- **Findings:** ${data.review.findings.length} (autofixable: ${
      data.review.findings.filter((f) => f.autofixable).length
    }, blocking: ${
      data.review.findings.filter((f) => !f.autofixable).length
    })`,
    `- **Labels:** ${labelsLine}`,
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

  return lines.join("\n");
}

/**
 * Auto-approval is safe only on low-complexity changes with no blocking
 * findings, and — when autofix was attempted — only after we successfully
 * opened the autofix PR (otherwise the original PR still has unfixed issues).
 */
export function isSafeToAutoApprove(
  review: ReviewResult,
  autofix: AutofixOutcome,
): boolean {
  const blocking = review.findings.filter((f) => !f.autofixable);
  return (
    review.complexity === "low" &&
    blocking.length === 0 &&
    (autofix.attempted ? Boolean(autofix.fixPrUrl) : true)
  );
}

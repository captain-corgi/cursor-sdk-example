import { Agent, CursorAgentError } from "@cursor/sdk";

import type { AutofixOutcome, Finding, RepoContext } from "./types.js";

const MODEL_ID = "composer-2" as const;
const FIX_PR_URL_START = "<<<CURSOR_FIX_PR_URL>>>";
const FIX_PR_URL_END = "<<<END_CURSOR_FIX_PR_URL>>>";

interface AutofixParams {
  cursorApiKey: string;
  githubToken: string;
  ctx: RepoContext;
  findings: Finding[];
  reviewRunId: string;
}

export async function runAutofix({
  cursorApiKey,
  githubToken,
  ctx,
  findings,
  reviewRunId,
}: AutofixParams): Promise<AutofixOutcome> {
  if (findings.length === 0) {
    return { attempted: false };
  }

  const branch = `cursor/autofix/pr-${ctx.prNumber}-${shortId(reviewRunId)}`;

  try {
    await using agent = await Agent.create({
      apiKey: cursorApiKey,
      model: { id: MODEL_ID },
      cloud: {
        repos: [{ url: ctx.repoUrl, startingRef: ctx.headRef }],
        workOnCurrentBranch: false,
        skipReviewerRequest: true,
        autoCreatePR: false,
      },
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
        },
      },
    });

    const prompt = buildAutofixPrompt(ctx, findings, branch);

    const run = await agent.send(prompt);
    console.log(`[autofix] agent=${agent.agentId} run=${run.id}`);

    let rawOutput = "";
    for await (const event of run.stream()) {
      if (event.type === "status") {
        console.log(`[autofix] status=${event.status}`);
      } else if (event.type === "tool_call" && event.status !== "running") {
        console.log(`[autofix] tool=${event.name} -> ${event.status}`);
      } else if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") rawOutput += block.text;
        }
      }
    }

    const result = await run.wait();
    if (result.status !== "finished") {
      return {
        attempted: true,
        branch,
        error: `autofix run ${result.id} ended as ${result.status}`,
      };
    }

    if (!rawOutput && typeof result.result === "string") {
      rawOutput = result.result;
    }

    const fixPrUrl = extractFixPrUrl(rawOutput);
    if (!fixPrUrl) {
      return {
        attempted: true,
        branch,
        error: "autofix agent did not report a fix PR URL",
      };
    }

    return { attempted: true, branch, fixPrUrl };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(
        `[autofix] startup failed: ${err.message} (retryable=${err.isRetryable})`,
      );
      return {
        attempted: true,
        branch,
        error: `CursorAgentError: ${err.message}`,
      };
    }
    throw err;
  }
}

function buildAutofixPrompt(
  ctx: RepoContext,
  findings: Finding[],
  branch: string,
): string {
  const findingsBlock = findings
    .map((f, i) => {
      const lineSuffix = f.line !== undefined ? `:${f.line}` : "";
      return `${i + 1}. [${f.id}] ${f.title}
   File: ${f.file}${lineSuffix}
   Severity: ${f.severity}
   Description: ${f.description}`;
    })
    .join("\n\n");

  return `You are autofixing review findings on PR ${ctx.prUrl} (${ctx.owner}/${ctx.repo}).
The current head branch is "${ctx.headRef}". You must NOT push to that branch directly.

Goals:
1. Create a new branch named exactly "${branch}" off "${ctx.headRef}".
2. Apply ONLY the fixes listed below. Do not refactor unrelated code, do not change behavior,
   do not address findings that are not in this list.
3. Make one focused commit per finding when reasonable; commit messages should reference the
   finding id (e.g. "fix(F1): remove unused import").
4. Push the branch to the origin remote.
5. Open a pull request via the github MCP tool \`create_pull_request\` with:
   - base: "${ctx.headRef}"
   - head: "${branch}"
   - title: "autofix: review findings for #${ctx.prNumber}"
   - body: a short summary listing each finding id you addressed and the file changed.
6. After the PR is created, emit the PR URL in this exact format at the very end of your
   final message (no extra text after the closing sentinel):

${FIX_PR_URL_START}
https://github.com/${ctx.owner}/${ctx.repo}/pull/<number>
${FIX_PR_URL_END}

If you cannot safely fix a specific finding, skip it and note the skip in the PR body. Never
fabricate fixes. If no fixes can be applied at all, do NOT open a PR; instead end your message
with the sentinels containing the literal string "NONE" between them.

Findings to address:

${findingsBlock}`;
}

function extractFixPrUrl(raw: string): string | undefined {
  const start = raw.lastIndexOf(FIX_PR_URL_START);
  if (start === -1) return undefined;
  const after = start + FIX_PR_URL_START.length;
  const end = raw.indexOf(FIX_PR_URL_END, after);
  if (end === -1) return undefined;
  const body = raw.slice(after, end).trim();
  if (!body || body === "NONE") return undefined;
  if (!/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(body)) return undefined;
  return body;
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "run";
}

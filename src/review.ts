import { Agent, CursorAgentError } from "@cursor/sdk";

import { parseReviewJson } from "./parse.js";
import type { RepoContext, ReviewResult, Runtime } from "./types.js";

const MODEL_ID = "composer-2" as const;

interface ReviewParams {
  cursorApiKey: string;
  githubToken: string;
  ctx: RepoContext;
  runtime: Runtime;
  localCwd?: string;
}

export interface ReviewRun {
  result: ReviewResult;
  agentId: string;
  runId: string;
  rawOutput: string;
}

export async function runReview({
  cursorApiKey,
  githubToken,
  ctx,
  runtime,
  localCwd,
}: ReviewParams): Promise<ReviewRun> {
  const mcpServers = {
    github: {
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
    },
  };

  const agentOptions =
    runtime === "cloud"
      ? {
          apiKey: cursorApiKey,
          model: { id: MODEL_ID },
          cloud: {
            repos: [{ url: ctx.repoUrl, startingRef: ctx.headRef }],
            workOnCurrentBranch: true,
            skipReviewerRequest: true,
            autoCreatePR: false,
          },
          mcpServers,
        }
      : {
          apiKey: cursorApiKey,
          model: { id: MODEL_ID },
          local: { cwd: localCwd ?? process.cwd(), settingSources: [] },
          mcpServers,
        };

  await using agent = await Agent.create(agentOptions);
  console.log(`[review] runtime=${runtime} agent=${agent.agentId}`);

  const prompt = buildReviewPrompt(ctx);

  try {
    const run = await agent.send(prompt);
    console.log(`[review] agent=${agent.agentId} run=${run.id}`);

    let rawOutput = "";
    for await (const event of run.stream()) {
      if (event.type === "status") {
        console.log(`[review] status=${event.status}`);
      } else if (event.type === "tool_call" && event.status !== "running") {
        console.log(`[review] tool=${event.name} -> ${event.status}`);
      } else if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") rawOutput += block.text;
        }
      }
    }

    const finalResult = await run.wait();
    if (finalResult.status !== "finished") {
      throw new ReviewRunError(
        `review run ${finalResult.id} ended as ${finalResult.status}`,
        finalResult.id,
      );
    }

    if (!rawOutput && typeof finalResult.result === "string") {
      rawOutput = finalResult.result;
    }

    const parsed = parseReviewJson(rawOutput);

    return {
      result: parsed,
      agentId: agent.agentId,
      runId: run.id,
      rawOutput,
    };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(
        `[review] startup failed: ${err.message} (retryable=${err.isRetryable})`,
      );
    }
    throw err;
  }
}

export class ReviewRunError extends Error {
  constructor(
    message: string,
    public readonly runId: string,
  ) {
    super(message);
    this.name = "ReviewRunError";
  }
}

function buildReviewPrompt(ctx: RepoContext): string {
  return `You are reviewing pull request ${ctx.prUrl} in ${ctx.owner}/${ctx.repo}.
Head branch: ${ctx.headRef}. Base branch: ${ctx.baseRef}. PR number: ${ctx.prNumber}.

Tasks (do them in order):

1. Use the github MCP tools to read the PR diff (\`get_pull_request\`, \`get_pull_request_files\`).
2. Review the changes for correctness, security, performance, and readability.
3. For each concrete issue, post an inline review comment via \`create_pull_request_review\`
   (\`event: "COMMENT"\`) on the original PR. Skip praise-only or stylistic-bikeshed comments.
4. Classify the overall change complexity:
   - "low": small, mechanical, isolated change. Safe to auto-approve if no findings.
   - "medium": touches non-trivial logic, multiple files, or a public interface.
   - "high": architectural change, touches sensitive areas (auth, billing, infra, migrations),
     or has cross-cutting impact.
5. Mark each finding as \`autofixable: true\` ONLY if it is mechanical and locally fixable
   without changing behavior or design (typos, unused imports, simple refactors, missing null
   checks with obvious fix, lint-style issues). Anything requiring judgment is NOT autofixable.

After completing the review, you MUST emit ONE block at the very end of your final message,
exactly in this format (no extra commentary after the closing sentinel):

<<<CURSOR_REVIEW_JSON>>>
{
  "complexity": "low" | "medium" | "high",
  "summary": "1-3 sentence human summary of the PR and review outcome",
  "findings": [
    {
      "id": "F1",
      "file": "path/from/repo/root.ext",
      "line": 42,
      "severity": "low" | "medium" | "high",
      "title": "short title",
      "description": "what is wrong and why; one paragraph max",
      "autofixable": true
    }
  ]
}
<<<END_CURSOR_REVIEW_JSON>>>

Rules for the JSON block:
- It MUST be valid JSON. No comments, no trailing commas.
- "findings" may be an empty array if there are no issues.
- "line" is optional; omit it if the finding is file-level.
- Do not invent file paths; every "file" must exist in the diff.
- Do not include any text after <<<END_CURSOR_REVIEW_JSON>>>.`;
}

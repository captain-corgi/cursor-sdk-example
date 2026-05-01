var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { Agent, CursorAgentError } from "@cursor/sdk";
import { parseReviewJson } from "./parse.js";
const MODEL_ID = "composer-2";
export async function runReview({ cursorApiKey, githubToken, ctx, runtime, localCwd, }) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const mcpServers = {
            github: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-github"],
                env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
            },
        };
        const agentOptions = runtime === "cloud"
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
        const agent = __addDisposableResource(env_1, await Agent.create(agentOptions), true);
        console.log(`[review] runtime=${runtime} agent=${agent.agentId}`);
        const prompt = buildReviewPrompt(ctx);
        try {
            const run = await agent.send(prompt);
            console.log(`[review] agent=${agent.agentId} run=${run.id}`);
            let rawOutput = "";
            for await (const event of run.stream()) {
                if (event.type === "status") {
                    console.log(`[review] status=${event.status}`);
                }
                else if (event.type === "tool_call" && event.status !== "running") {
                    console.log(`[review] tool=${event.name} -> ${event.status}`);
                }
                else if (event.type === "assistant") {
                    for (const block of event.message.content) {
                        if (block.type === "text")
                            rawOutput += block.text;
                    }
                }
            }
            const finalResult = await run.wait();
            if (finalResult.status !== "finished") {
                throw new ReviewRunError(`review run ${finalResult.id} ended as ${finalResult.status}`, finalResult.id);
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
        }
        catch (err) {
            if (err instanceof CursorAgentError) {
                console.error(`[review] startup failed: ${err.message} (retryable=${err.isRetryable})`);
            }
            throw err;
        }
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        const result_1 = __disposeResources(env_1);
        if (result_1)
            await result_1;
    }
}
export class ReviewRunError extends Error {
    runId;
    constructor(message, runId) {
        super(message);
        this.runId = runId;
        this.name = "ReviewRunError";
    }
}
function buildReviewPrompt(ctx) {
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
//# sourceMappingURL=review.js.map
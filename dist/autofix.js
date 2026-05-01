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
const MODEL_ID = "composer-2";
const FIX_STATUS_START = "<<<CURSOR_AUTOFIX_STATUS>>>";
const FIX_STATUS_END = "<<<END_CURSOR_AUTOFIX_STATUS>>>";
export async function runAutofix({ cursorApiKey, githubToken, ctx, findings, reviewRunId, runtime, localCwd, }) {
    if (findings.length === 0) {
        return { attempted: false };
    }
    const branch = `cursor/autofix/pr-${ctx.prNumber}-${shortId(reviewRunId)}`;
    try {
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
            // For local runtime, the runner's git performs `git push` using the
            // GITHUB_TOKEN extraheader configured by actions/checkout. That token
            // must have `contents: write` in the workflow.
            const agentOptions = runtime === "cloud"
                ? {
                    apiKey: cursorApiKey,
                    model: { id: MODEL_ID },
                    cloud: {
                        repos: [{ url: ctx.repoUrl, startingRef: ctx.headRef }],
                        workOnCurrentBranch: false,
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
            console.log(`[autofix] runtime=${runtime} agent=${agent.agentId}`);
            const prompt = buildAutofixPrompt(ctx, findings, branch);
            const run = await agent.send(prompt);
            console.log(`[autofix] agent=${agent.agentId} run=${run.id}`);
            let rawOutput = "";
            for await (const event of run.stream()) {
                if (event.type === "status") {
                    console.log(`[autofix] status=${event.status}`);
                }
                else if (event.type === "tool_call" && event.status !== "running") {
                    console.log(`[autofix] tool=${event.name} -> ${event.status}`);
                }
                else if (event.type === "assistant") {
                    for (const block of event.message.content) {
                        if (block.type === "text")
                            rawOutput += block.text;
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
            const status = extractFixStatus(rawOutput);
            if (status === "none") {
                return {
                    attempted: true,
                    branch,
                    error: "autofix agent reported no fixes applied (NONE)",
                };
            }
            if (status !== "ok") {
                return {
                    attempted: true,
                    branch,
                    error: "autofix agent did not emit a completion status",
                };
            }
            // Branch is pushed; the orchestrator opens the PR.
            return { attempted: true, branch };
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
    catch (err) {
        if (err instanceof CursorAgentError) {
            console.error(`[autofix] startup failed: ${err.message} (retryable=${err.isRetryable})`);
            return {
                attempted: true,
                branch,
                error: `CursorAgentError: ${err.message}`,
            };
        }
        throw err;
    }
}
function buildAutofixPrompt(ctx, findings, branch) {
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

Goals (do them in order):

1. Configure git identity locally for this run:
     git config user.name "Cursor Autofix"
     git config user.email "cursor-autofix@users.noreply.github.com"
2. Create a new branch named exactly "${branch}" off "${ctx.headRef}".
3. Apply ONLY the fixes listed below. Do not refactor unrelated code, do not change behavior,
   do not address findings that are not in this list.
4. Make one focused commit per finding when reasonable; commit messages should reference the
   finding id (e.g. "fix(F1): remove unused import").
5. Push the branch to the "origin" remote (e.g. \`git push -u origin ${branch}\`).
6. Do NOT open a pull request and do NOT attempt to call the github MCP \`create_pull_request\`
   tool. The orchestrator will open the PR itself after this run finishes by inspecting the
   pushed branch.

After the push succeeds, emit ONE status block at the very end of your final message,
exactly in this format (no extra commentary after the closing sentinel):

${FIX_STATUS_START}
OK
${FIX_STATUS_END}

Edge cases:
- If you can apply some fixes but not others, push the partial set, note the skipped finding
  ids in the LAST commit message body, and still emit "OK".
- If you cannot safely apply ANY of the fixes, do NOT push the branch. Instead emit:

${FIX_STATUS_START}
NONE
${FIX_STATUS_END}

Never fabricate fixes.

Findings to address:

${findingsBlock}`;
}
function extractFixStatus(raw) {
    const start = raw.lastIndexOf(FIX_STATUS_START);
    if (start === -1)
        return undefined;
    const after = start + FIX_STATUS_START.length;
    const end = raw.indexOf(FIX_STATUS_END, after);
    if (end === -1)
        return undefined;
    const body = raw.slice(after, end).trim().toUpperCase();
    if (body === "OK")
        return "ok";
    if (body === "NONE")
        return "none";
    return undefined;
}
function shortId(id) {
    return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "run";
}
//# sourceMappingURL=autofix.js.map
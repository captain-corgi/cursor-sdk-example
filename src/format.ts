import { Agent, CursorAgentError } from "@cursor/sdk";

import { FormatParseError, parseFormatJson } from "./parse.js";
import type { FormatOutcome, RepoContext, Runtime } from "./types.js";

const MODEL_ID = "composer-2" as const;

interface FormatParams {
  cursorApiKey: string;
  githubToken: string;
  ctx: RepoContext;
  runtime: Runtime;
  localCwd?: string;
}

export async function runFormat({
  cursorApiKey,
  ctx,
  runtime,
  localCwd,
}: FormatParams): Promise<FormatOutcome> {
  // No MCP servers: this agent's only output is a JSON block with the
  // rewritten title/body. The orchestrator owns the GitHub write so we keep
  // the agent's surface area minimal and deterministic.
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
        }
      : {
          apiKey: cursorApiKey,
          model: { id: MODEL_ID },
          local: { cwd: localCwd ?? process.cwd(), settingSources: [] },
        };

  try {
    await using agent = await Agent.create(agentOptions);
    console.log(`[format] runtime=${runtime} agent=${agent.agentId}`);

    const prompt = buildFormatPrompt(ctx);

    const run = await agent.send(prompt);
    console.log(`[format] agent=${agent.agentId} run=${run.id}`);

    let rawOutput = "";
    for await (const event of run.stream()) {
      if (event.type === "status") {
        console.log(`[format] status=${event.status}`);
      } else if (event.type === "tool_call" && event.status !== "running") {
        console.log(`[format] tool=${event.name} -> ${event.status}`);
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
        changed: false,
        error: `format run ${result.id} ended as ${result.status}`,
      };
    }

    if (!rawOutput && typeof result.result === "string") {
      rawOutput = result.result;
    }

    const payload = parseFormatJson(rawOutput);

    if (payload.status === "unchanged") {
      return {
        attempted: true,
        changed: false,
        notes: payload.notes,
      };
    }

    // Treat byte-identical output as no-op even if the agent labeled it
    // "rewritten" — avoids needless API writes.
    const titleChanged = payload.title !== ctx.prTitle;
    const bodyChanged = payload.body !== ctx.prBody;
    if (!titleChanged && !bodyChanged) {
      return {
        attempted: true,
        changed: false,
        notes: payload.notes ?? "agent output matched original",
      };
    }

    return {
      attempted: true,
      changed: true,
      newTitle: payload.title,
      newBody: payload.body,
      notes: payload.notes,
    };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(
        `[format] startup failed: ${err.message} (retryable=${err.isRetryable})`,
      );
      return {
        attempted: true,
        changed: false,
        error: `CursorAgentError: ${err.message}`,
      };
    }
    if (err instanceof FormatParseError) {
      return {
        attempted: true,
        changed: false,
        error: `parse error: ${err.message}`,
      };
    }
    throw err;
  }
}

function buildFormatPrompt(ctx: RepoContext): string {
  const originalBody = ctx.prBody.trim().length > 0 ? ctx.prBody : "(empty)";

  return `You are normalizing the title and body of pull request ${ctx.prUrl}
(${ctx.owner}/${ctx.repo}, head=${ctx.headRef}, base=${ctx.baseRef}) to follow
this team's PR standard. You MUST preserve the author's original meaning. Pure
rewording and structuring only — never invent technical claims (test commands
the author did not mention, risks not implied, scope the author did not state).

=== ORIGINAL TITLE ===
${ctx.prTitle}

=== ORIGINAL BODY ===
${originalBody}

=== END ORIGINAL ===

Standard:

1. Title MUST be Conventional Commits:
   <type>(<optional scope>)<optional !>: <short imperative summary>
   - type ∈ feat | fix | chore | docs | refactor | perf | test | build | ci | style | revert
   - Append "!" before ":" only when the author indicated a breaking change.
   - Keep the author's language/tone; do not translate. Title <= 72 chars when possible.

2. Body MUST contain exactly these five top-level sections, in this order, with
   "## " heading prefixes:

   ## Summary
   1-3 sentences rewording the author's "what + why".

   ## Motivation
   Context / problem being solved, drawn from the author's body.

   ## Changes
   Bulleted list of concrete edits the author described. One bullet per logical
   change. Group by area only if the author already grouped them.

   ## Test Plan
   How the change was/will be verified, drawn from the author's body. If the
   author said nothing about testing, write exactly: _None._

   ## Risk
   Blast radius, rollback notes, follow-ups — only what the author implied.
   If nothing is implied, write exactly: _None._

3. Never delete factual content from the original body. If something does not
   fit any other section, put it in Summary. Preserve any links, issue refs,
   and code blocks the author included.

4. If the original title and body ALREADY conform to the standard above and
   no rewording would improve them, set "status": "unchanged" and echo the
   original title and body verbatim.

After you have decided, emit ONE JSON block at the very end of your final
message, exactly in this format (no extra commentary after the closing
sentinel):

<<<CURSOR_FORMAT_JSON>>>
{
  "status": "rewritten" | "unchanged",
  "title": "feat(scope): ...",
  "body": "## Summary\\n...\\n\\n## Motivation\\n...\\n\\n## Changes\\n- ...\\n\\n## Test Plan\\n_None._\\n\\n## Risk\\n_None._",
  "notes": "1 short sentence describing what you changed (for orchestrator logs)"
}
<<<END_CURSOR_FORMAT_JSON>>>

Rules for the JSON block:
- It MUST be valid JSON. No comments, no trailing commas.
- "title" MUST be a non-empty string matching the Conventional Commits shape.
- "body" MUST be a non-empty string containing all five "## " sections in order.
- "notes" is optional; keep it under 120 characters.
- Do not include any text after <<<END_CURSOR_FORMAT_JSON>>>.`;
}

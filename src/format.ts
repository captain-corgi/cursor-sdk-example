import { Agent, CursorAgentError } from "@cursor/sdk";

import { FormatParseError, parseFormatJson } from "./parse.js";
import type { FormatOutcome, RepoContext, Runtime } from "./types.js";

interface FormatParams {
  cursorApiKey: string;
  ctx: RepoContext;
  /** Markdown-ish summary of `pulls.listFiles` patches (from orchestrator). */
  diffSummary: string;
  runtime: Runtime;
  modelId: string;
  localCwd?: string;
}

export async function runFormat({
  cursorApiKey,
  ctx,
  diffSummary,
  runtime,
  modelId,
  localCwd,
}: FormatParams): Promise<FormatOutcome> {
  // No MCP: the orchestrator passes the PR diff text so the agent can ground
  // the description in real changes. Output is still only a JSON block; the
  // orchestrator owns `pulls.update`.
  const agentOptions =
    runtime === "cloud"
      ? {
          apiKey: cursorApiKey,
          model: { id: modelId },
          cloud: {
            repos: [{ url: ctx.repoUrl, startingRef: ctx.headRef }],
            workOnCurrentBranch: true,
            skipReviewerRequest: true,
            autoCreatePR: false,
          },
        }
      : {
          apiKey: cursorApiKey,
          model: { id: modelId },
          local: { cwd: localCwd ?? process.cwd(), settingSources: [] },
        };

  try {
    await using agent = await Agent.create(agentOptions);
    console.log(`[format] runtime=${runtime} agent=${agent.agentId}`);

    const prompt = buildFormatPrompt(ctx, diffSummary);

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

export function buildFormatPrompt(ctx: RepoContext, diffSummary: string): string {
  const originalBody = ctx.prBody.trim().length > 0 ? ctx.prBody : "(empty)";

  return `You are normalizing the title and body of pull request ${ctx.prUrl}
(${ctx.owner}/${ctx.repo}, head=${ctx.headRef}, base=${ctx.baseRef}) to follow
this team's PR standard.

Ground truth for **what changed in code** is the PR DIFF section below — not
guesswork. The author's original title/body is authoritative for intent,
testing notes, links, and risks they stated. **Merge** both: describe real code
changes from the diff, and preserve any meaningful content from the author's
body (re-home it into the right section; do not drop facts, links, issue refs,
or code blocks).

Never invent files, APIs, or behaviors not supported by the diff or the
author's text. Never claim tests were run unless the author said so.

=== ORIGINAL TITLE ===
${ctx.prTitle}

=== ORIGINAL BODY ===
${originalBody}

=== PR DIFF (from GitHub; author text above may omit details present here) ===
${diffSummary}

=== END INPUT ===

Standard:

1. Title — ticket prefix + short summary:
   - If you find a ticket/issue id in the branch name, original title, or body,
     format the title as: [TICKET-ID] Short summary
     Example: [TICKET-001] Add login validation
     Use the SAME id string you found (keep project prefix style as-is, e.g.
     PROJ-123, TICKET-001, ABC_42 if that is what appears).
   - If NO ticket/id is present anywhere reasonable, **omit** brackets — title
     is only the short summary: Example: Add login validation
   - Do NOT invent a ticket id.
   - Strip a redundant ticket prefix from the summary half if the title would
     duplicate it (e.g. avoid "[TICKET-001] TICKET-001 fix foo").
   - Keep the author's language/tone; concise; GitHub title limit ~256 chars.

2. Body — exactly these five "## " sections in order:

   ## Summary
   1–3 sentences: what this PR does and why. Combine author's intent with the
   diff when the body was thin.

   ## Motivation
   Problem/context from the author's body. If they wrote nothing here but the
   diff implies a clear motivation, state it cautiously in one sentence without
   overstating.

   ## Changes
   Bulleted list grounded **primarily in the PR DIFF**: concrete edits per file
   or logical grouping (what was added/removed/changed). If the diff budget was
   truncated, say only what you can see and note that more files may exist.
   Supplement with author bullets if they add nuance that matches the diff.

   ## Test Plan
   From the author's body only. If they said nothing about testing: _None._

   ## Risk
   From the author's implications + reasonable inference from the diff scope
   (e.g. touching auth). If none: _None._

3. If the title and body already match this standard and fully reflect the diff
   plus author content, set "status": "unchanged" and echo title/body verbatim.

After you have decided, emit ONE JSON block at the very end of your final
message, exactly in this format (no extra commentary after the closing
sentinel). The example below is **valid JSON** — copy its shape only; replace
values with your real title/body/notes. Do not use union (\`|\`) syntax or prose
(like "OR ...") inside JSON string values.

<<<CURSOR_FORMAT_JSON>>>
{
  "status": "rewritten",
  "title": "[PROJ-42] Short summary",
  "body": "## Summary\\nWhat changed and why.\\n\\n## Motivation\\nWhy this was needed.\\n\\n## Changes\\n- path/to/file.ts: concrete change\\n\\n## Test Plan\\n_None._\\n\\n## Risk\\n_None._",
  "notes": "One short sentence for orchestrator logs."
}
<<<END_CURSOR_FORMAT_JSON>>>

Rules for the JSON block:
- It MUST be valid JSON. No comments, no trailing commas, no \`|\` unions inside strings.
- "status" MUST be exactly the JSON string \`"rewritten"\` or \`"unchanged"\` (pick one).
- "title" MUST be a non-empty string following the title rules above.
- "body" MUST be a non-empty string containing all five "## " sections in order.
- "notes" is optional; keep it under 120 characters.
- Do not include any text after <<<END_CURSOR_FORMAT_JSON>>>.`;
}

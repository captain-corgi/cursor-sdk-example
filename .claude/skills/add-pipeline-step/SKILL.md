---
name: add-pipeline-step
description: Scaffold a new pipeline step module wired into the orchestrator with label gate and types
---

Scaffold a new pipeline step in the sequential orchestrator pipeline.

## Context

The orchestrator (`src/index.ts`) runs steps sequentially. Each step:
- Lives in its own file under `src/` (e.g. `src/review.ts`, `src/autofix.ts`)
- Has a label gate — the PR must carry a specific label for the step to execute
- Exports an async function that receives the standard config object
- Follows the `await using` pattern for Cursor SDK agent disposal
- Logs with `[step-name]` prefix for all console output

## Steps

Given a step name and description from the user:

1. **Create the module** at `src/<step-name>.ts`:
   - Import types from `./types.js`
   - Export a `run<StepName>` async function
   - Use `await using` for any Cursor agent created via `@cursor/sdk`
   - Return a typed outcome object (see `AutofixOutcome`, `FormatOutcome` patterns)
   - Log all output with `[step-name]` prefix

2. **Add label constant** to `LABELS` in `src/types.ts`:
   - Follow pattern: `LABELS.<UPPER_CASE> = "cursor-<kebab-case>"`

3. **Wire into orchestrator** (`src/index.ts`):
   - Import the new `run<StepName>` function
   - Add the step at the appropriate position in the pipeline
   - Add the label gate check: `if (!hasLabel(LABELS.<NAME>)) { ... skip ... }`
   - Handle errors with try/catch, log warnings but don't block the pipeline (unless the step is critical)

4. **Define the outcome interface** in `src/types.ts` (if needed) following the pattern of `AutofixOutcome` / `FormatOutcome`.

## Arguments

```
/add-pipeline-step <step-name> <description>
```

Example: `/add-pipeline-step notify Send Slack notification for high-severity findings`

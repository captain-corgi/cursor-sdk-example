/**
 * Opt-in PR labels that gate each orchestrator step. A PR must carry the
 * matching label for the corresponding step to run; missing `LABELS.REVIEW`
 * skips the review, autofix, Linear, summary, and approve/request-review path
 * (steps 1–5). Step 0 title/body formatting is not gated by this label and
 * still runs unless the orchestrator skips the format step (e.g.
 * `LABELS.DISABLE_FORMAT`).
 */
export const LABELS = {
    REVIEW: "cursor-review",
    AUTOFIX: "cursor-autofix",
    LINEAR: "cursor-autolinear",
    DISABLE_FORMAT: "cursor-disable-format",
};
//# sourceMappingURL=types.js.map
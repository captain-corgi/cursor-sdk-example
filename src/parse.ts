import type { Complexity, Finding, ReviewResult, Severity } from "./types.js";

const START = "<<<CURSOR_REVIEW_JSON>>>";
const END = "<<<END_CURSOR_REVIEW_JSON>>>";

export class ReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewParseError";
  }
}

export function parseReviewJson(raw: string): ReviewResult {
  if (!raw) {
    throw new ReviewParseError("agent produced no text output");
  }

  const startIdx = raw.lastIndexOf(START);
  if (startIdx === -1) {
    throw new ReviewParseError(
      `missing ${START} sentinel in agent output (length=${raw.length})`,
    );
  }

  const afterStart = startIdx + START.length;
  const endIdx = raw.indexOf(END, afterStart);
  if (endIdx === -1) {
    throw new ReviewParseError(`missing ${END} sentinel in agent output`);
  }

  const jsonText = raw.slice(afterStart, endIdx).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ReviewParseError(`invalid JSON in review block: ${msg}`);
  }

  return validateReviewResult(parsed);
}

function validateReviewResult(value: unknown): ReviewResult {
  if (!isObject(value)) {
    throw new ReviewParseError("review JSON is not an object");
  }

  const complexity = asComplexity(value["complexity"]);
  const summary = asString(value["summary"], "summary");
  const findingsRaw = value["findings"];
  if (!Array.isArray(findingsRaw)) {
    throw new ReviewParseError("findings must be an array");
  }

  const findings: Finding[] = findingsRaw.map((f, i) =>
    validateFinding(f, i),
  );

  return { complexity, summary, findings };
}

function validateFinding(value: unknown, index: number): Finding {
  if (!isObject(value)) {
    throw new ReviewParseError(`finding[${index}] is not an object`);
  }
  const id = asString(value["id"], `finding[${index}].id`);
  const file = asString(value["file"], `finding[${index}].file`);
  const title = asString(value["title"], `finding[${index}].title`);
  const description = asString(
    value["description"],
    `finding[${index}].description`,
  );
  const severity = asSeverity(value["severity"], index);
  const autofixable = value["autofixable"];
  if (typeof autofixable !== "boolean") {
    throw new ReviewParseError(`finding[${index}].autofixable must be boolean`);
  }
  const lineRaw = value["line"];
  let line: number | undefined;
  if (lineRaw !== undefined && lineRaw !== null) {
    if (typeof lineRaw !== "number" || !Number.isFinite(lineRaw)) {
      throw new ReviewParseError(`finding[${index}].line must be a number`);
    }
    line = lineRaw;
  }
  return { id, file, line, severity, title, description, autofixable };
}

function asComplexity(value: unknown): Complexity {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new ReviewParseError(
    `complexity must be "low" | "medium" | "high", got ${JSON.stringify(value)}`,
  );
}

function asSeverity(value: unknown, index: number): Severity {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new ReviewParseError(
    `finding[${index}].severity must be "low" | "medium" | "high"`,
  );
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReviewParseError(`${label} must be a non-empty string`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

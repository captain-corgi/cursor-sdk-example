const START = "<<<CURSOR_REVIEW_JSON>>>";
const END = "<<<END_CURSOR_REVIEW_JSON>>>";
const FORMAT_START = "<<<CURSOR_FORMAT_JSON>>>";
const FORMAT_END = "<<<END_CURSOR_FORMAT_JSON>>>";
export class ReviewParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "ReviewParseError";
    }
}
export class FormatParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "FormatParseError";
    }
}
export function parseReviewJson(raw) {
    if (!raw) {
        throw new ReviewParseError("agent produced no text output");
    }
    const startIdx = raw.lastIndexOf(START);
    if (startIdx === -1) {
        throw new ReviewParseError(`missing ${START} sentinel in agent output (length=${raw.length})`);
    }
    const afterStart = startIdx + START.length;
    const endIdx = raw.indexOf(END, afterStart);
    if (endIdx === -1) {
        throw new ReviewParseError(`missing ${END} sentinel in agent output`);
    }
    const jsonText = raw.slice(afterStart, endIdx).trim();
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ReviewParseError(`invalid JSON in review block: ${msg}`);
    }
    return validateReviewResult(parsed);
}
export function parseFormatJson(raw) {
    if (!raw) {
        throw new FormatParseError("agent produced no text output");
    }
    const startIdx = raw.lastIndexOf(FORMAT_START);
    if (startIdx === -1) {
        throw new FormatParseError(`missing ${FORMAT_START} sentinel in agent output (length=${raw.length})`);
    }
    const afterStart = startIdx + FORMAT_START.length;
    const endIdx = raw.indexOf(FORMAT_END, afterStart);
    if (endIdx === -1) {
        throw new FormatParseError(`missing ${FORMAT_END} sentinel in agent output`);
    }
    const jsonText = raw.slice(afterStart, endIdx).trim();
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new FormatParseError(`invalid JSON in format block: ${msg}`);
    }
    return validateFormatPayload(parsed);
}
function validateFormatPayload(value) {
    if (!isObject(value)) {
        throw new FormatParseError("format JSON is not an object");
    }
    const statusRaw = value["status"];
    if (statusRaw !== "rewritten" && statusRaw !== "unchanged") {
        throw new FormatParseError(`status must be "rewritten" | "unchanged", got ${JSON.stringify(statusRaw)}`);
    }
    const title = asFormatString(value["title"], "title");
    const body = asFormatString(value["body"], "body");
    const notesRaw = value["notes"];
    let notes;
    if (notesRaw !== undefined && notesRaw !== null) {
        if (typeof notesRaw !== "string") {
            throw new FormatParseError("notes must be a string when present");
        }
        notes = notesRaw;
    }
    return { status: statusRaw, title, body, notes };
}
function validateReviewResult(value) {
    if (!isObject(value)) {
        throw new ReviewParseError("review JSON is not an object");
    }
    const complexity = asComplexity(value["complexity"]);
    const summary = asString(value["summary"], "summary");
    const findingsRaw = value["findings"];
    if (!Array.isArray(findingsRaw)) {
        throw new ReviewParseError("findings must be an array");
    }
    const findings = findingsRaw.map((f, i) => validateFinding(f, i));
    return { complexity, summary, findings };
}
function validateFinding(value, index) {
    if (!isObject(value)) {
        throw new ReviewParseError(`finding[${index}] is not an object`);
    }
    const id = asString(value["id"], `finding[${index}].id`);
    const file = asString(value["file"], `finding[${index}].file`);
    const title = asString(value["title"], `finding[${index}].title`);
    const description = asString(value["description"], `finding[${index}].description`);
    const severity = asSeverity(value["severity"], index);
    const autofixable = value["autofixable"];
    if (typeof autofixable !== "boolean") {
        throw new ReviewParseError(`finding[${index}].autofixable must be boolean`);
    }
    const lineRaw = value["line"];
    let line;
    if (lineRaw !== undefined && lineRaw !== null) {
        if (typeof lineRaw !== "number" || !Number.isFinite(lineRaw)) {
            throw new ReviewParseError(`finding[${index}].line must be a number`);
        }
        line = lineRaw;
    }
    return { id, file, line, severity, title, description, autofixable };
}
function asComplexity(value) {
    if (value === "low" || value === "medium" || value === "high") {
        return value;
    }
    throw new ReviewParseError(`complexity must be "low" | "medium" | "high", got ${JSON.stringify(value)}`);
}
function asSeverity(value, index) {
    if (value === "low" || value === "medium" || value === "high") {
        return value;
    }
    throw new ReviewParseError(`finding[${index}].severity must be "low" | "medium" | "high"`);
}
function asFormatString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new FormatParseError(`${label} must be a non-empty string`);
    }
    return value;
}
function asString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new ReviewParseError(`${label} must be a non-empty string`);
    }
    return value;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=parse.js.map
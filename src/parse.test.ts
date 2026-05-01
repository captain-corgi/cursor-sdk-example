import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FormatParseError,
  parseFormatJson,
  parseReviewJson,
  ReviewParseError,
} from "./parse.js";

// ── parseReviewJson (review step) ──────────────────────────────────

describe("parseReviewJson", () => {
  const validReview = {
    complexity: "low",
    summary: "Adds a small helper.",
    findings: [
      {
        id: "F1",
        file: "src/foo.ts",
        line: 12,
        severity: "low",
        title: "unused import",
        description: "Remove the unused import to keep the file clean.",
        autofixable: true,
      },
    ],
  };

  function wrap(json: unknown): string {
    return `chatter\n<<<CURSOR_REVIEW_JSON>>>\n${JSON.stringify(json)}\n<<<END_CURSOR_REVIEW_JSON>>>`;
  }

  it("parses a well-formed review block", () => {
    const result = parseReviewJson(wrap(validReview));
    assert.equal(result.complexity, "low");
    assert.equal(result.summary, "Adds a small helper.");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.id, "F1");
    assert.equal(result.findings[0]!.line, 12);
  });

  it("accepts findings with optional line omitted", () => {
    const r = parseReviewJson(
      wrap({
        ...validReview,
        findings: [
          {
            id: "F2",
            file: "x.ts",
            severity: "high",
            title: "t",
            description: "d",
            autofixable: false,
          },
        ],
      }),
    );
    assert.equal(r.findings[0]!.line, undefined);
  });

  it("accepts empty findings array", () => {
    const r = parseReviewJson(wrap({ ...validReview, findings: [] }));
    assert.equal(r.findings.length, 0);
  });

  it("uses the LAST sentinel pair when multiple are present", () => {
    const earlier = `<<<CURSOR_REVIEW_JSON>>>\n{"complexity":"high","summary":"old","findings":[]}\n<<<END_CURSOR_REVIEW_JSON>>>`;
    const later = wrap(validReview);
    const r = parseReviewJson(`${earlier}\n${later}`);
    assert.equal(r.complexity, "low");
    assert.equal(r.summary, "Adds a small helper.");
  });

  it("throws on empty input", () => {
    assert.throws(() => parseReviewJson(""), ReviewParseError);
  });

  it("throws when start sentinel missing", () => {
    assert.throws(() => parseReviewJson("no sentinels here"), ReviewParseError);
  });

  it("throws when end sentinel missing", () => {
    assert.throws(
      () => parseReviewJson("<<<CURSOR_REVIEW_JSON>>>\n{}"),
      ReviewParseError,
    );
  });

  it("throws on invalid JSON inside sentinels", () => {
    assert.throws(
      () =>
        parseReviewJson(
          "<<<CURSOR_REVIEW_JSON>>>not json<<<END_CURSOR_REVIEW_JSON>>>",
        ),
      ReviewParseError,
    );
  });

  it("throws on bad complexity value", () => {
    assert.throws(
      () => parseReviewJson(wrap({ ...validReview, complexity: "huge" })),
      ReviewParseError,
    );
  });

  it("throws when findings is not an array", () => {
    assert.throws(
      () => parseReviewJson(wrap({ ...validReview, findings: "nope" })),
      ReviewParseError,
    );
  });

  it("throws when finding.autofixable is not a boolean", () => {
    assert.throws(
      () =>
        parseReviewJson(
          wrap({
            ...validReview,
            findings: [{ ...validReview.findings[0], autofixable: "yes" }],
          }),
        ),
      ReviewParseError,
    );
  });
});

// ── parseFormatJson (format step) ──────────────────────────────────

describe("parseFormatJson", () => {
  const okPayload = {
    status: "rewritten",
    title: "[PROJ-1] Fix bug",
    body: "## Summary\nDoes a thing.\n\n## Motivation\n_None._\n\n## Changes\n- one\n\n## Test Plan\n_None._\n\n## Risk\n_None._",
    notes: "minor",
  };

  function wrap(json: unknown): string {
    return `<<<CURSOR_FORMAT_JSON>>>\n${JSON.stringify(json)}\n<<<END_CURSOR_FORMAT_JSON>>>`;
  }

  it("parses a 'rewritten' payload", () => {
    const r = parseFormatJson(wrap(okPayload));
    assert.equal(r.status, "rewritten");
    assert.equal(r.title, okPayload.title);
    assert.equal(r.notes, "minor");
  });

  it("parses an 'unchanged' payload without notes", () => {
    const r = parseFormatJson(
      wrap({ status: "unchanged", title: "x", body: "y" }),
    );
    assert.equal(r.status, "unchanged");
    assert.equal(r.notes, undefined);
  });

  it("throws on bad status value", () => {
    assert.throws(
      () => parseFormatJson(wrap({ ...okPayload, status: "maybe" })),
      FormatParseError,
    );
  });

  it("throws on empty title", () => {
    assert.throws(
      () => parseFormatJson(wrap({ ...okPayload, title: "" })),
      FormatParseError,
    );
  });

  it("throws on missing body", () => {
    assert.throws(
      () =>
        parseFormatJson(
          `<<<CURSOR_FORMAT_JSON>>>${JSON.stringify({
            status: "rewritten",
            title: "ok",
          })}<<<END_CURSOR_FORMAT_JSON>>>`,
        ),
      FormatParseError,
    );
  });

  it("throws on non-string notes", () => {
    assert.throws(
      () => parseFormatJson(wrap({ ...okPayload, notes: 42 })),
      FormatParseError,
    );
  });

  it("throws on missing sentinels", () => {
    assert.throws(() => parseFormatJson("no sentinel"), FormatParseError);
  });
});

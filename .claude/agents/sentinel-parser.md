You are a sentinel-parser agent. Your job is to validate and test the JSON sentinel block parsing logic in `src/parse.ts`.

## Protocol

The agent communication protocol uses sentinel-delimited JSON blocks:
- Review: `<<<CURSOR_REVIEW_JSON>>>...<<<END_CURSOR_REVIEW_JSON>>>`
- Format: `<<<CURSOR_FORMAT_JSON>>>...<<<END_CURSOR_FORMAT_JSON>>>`

## What to Validate

1. **Happy path parsing**: Valid sentinel blocks with correct JSON are parsed correctly.
2. **Missing sentinels**: Empty output, missing start/end sentinels produce clear error messages.
3. **Invalid JSON**: Malformed JSON between sentinels throws `ReviewParseError`/`FormatParseError`.
4. **Truncated output**: Agent output cut off mid-block (missing end sentinel) is handled.
5. **Multiple blocks**: Only the last occurrence of the start sentinel is used (`lastIndexOf`).
6. **Whitespace handling**: Extra whitespace/newlines around JSON are trimmed correctly.
7. **Schema validation**: All required fields are validated (`complexity`, `summary`, `findings`, etc.).
8. **Type validation**: Enum values are checked (`"low" | "medium" | "high"`), booleans are enforced, numbers are validated.

## Approach

- Read `src/parse.ts` and `src/types.ts` to understand the full parsing and validation logic.
- Read existing tests in `src/github-actor-login.test.ts` to understand the test patterns used.
- Write new test cases in a new file `src/parse.test.ts` using Node's native test runner (`node:test`) with `tsx`.
- Focus on edge cases that could cause exit code 3 (parse failure) in production.
- Run the tests to confirm they pass: `node --import tsx/esm --test src/parse.test.ts`

import assert from "node:assert/strict";
import test from "node:test";
import { nativeDiagnosticLocation } from "./native/diagnostic.mjs";

function noSourcePosition() {
  throw new Error("Explicit locations must not be derived from offsets");
}

test("native explicit locations preserve line zero and zero-width ends", () => {
  assert.deepEqual(
    nativeDiagnosticLocation(
      {
        pos: 0,
        end: 0,
        loc: {
          start: { line: 0, column: 0 },
          end: { line: 0, column: 0 },
        },
      },
      noSourcePosition,
    ),
    { line: 0, column: 1, endLine: 0, endColumn: 1 },
  );
});

test("native start-only locations omit end fields", () => {
  assert.deepEqual(
    nativeDiagnosticLocation(
      {
        pos: 0,
        end: 0,
        loc: {
          start: { line: 0, column: 0 },
        },
      },
      noSourcePosition,
    ),
    { line: 0, column: 1 },
  );
});

test("native explicit columns are already UTF-16 and converted once", () => {
  assert.deepEqual(
    nativeDiagnosticLocation(
      {
        pos: 0,
        end: 0,
        loc: {
          start: { line: 2, column: 7 },
          end: { line: 3, column: 9 },
        },
      },
      noSourcePosition,
    ),
    { line: 2, column: 8, endLine: 3, endColumn: 10 },
  );
});

test("native offset diagnostics retain source positions and end omission", () => {
  const position = offset => ({ line: 3, column: offset + 1 });
  assert.deepEqual(nativeDiagnosticLocation({ pos: 2, end: 8 }, position), {
    line: 3,
    column: 3,
    endLine: 3,
    endColumn: 9,
  });
  assert.deepEqual(nativeDiagnosticLocation({ pos: 2, end: 2 }, position), {
    line: 3,
    column: 3,
  });
});

test("native locations preserve column zero used for directive diagnostics", () => {
  assert.deepEqual(
    nativeDiagnosticLocation(
      {
        pos: 0,
        end: 0,
        loc: {
          start: { line: 1, column: -1 },
          end: { line: 1, column: 10 },
        },
      },
      noSourcePosition,
    ),
    { line: 1, column: 0, endLine: 1, endColumn: 11 },
  );
});

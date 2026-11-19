import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createFlags, translateFlags } from "./type-services/flags.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

test("createFlags uses the consumer TypeScript flag layout", () => {
  const source = {
    api: {
      TypeFlags: { Null: 1, Object: 2 },
      ObjectFlags: {},
      SymbolFlags: {},
    },
    ast: { NodeFlags: {}, SyntaxKind: { EndOfFile: 0 } },
  };
  const consumer = {
    TypeFlags: { Null: 8, Object: 1048576 },
    ObjectFlags: {},
    SymbolFlags: {},
    NodeFlags: {},
    SyntaxKind: { EndOfFileToken: 1 },
  };
  const { flags } = createFlags(source, consumer);
  assert.equal(flags.type(1), 8);
  assert.equal(flags.type(2), 1048576);
  assert.equal(flags.type(3), 1048584);
});

test("translateFlags masks ignored bits and still rejects unknown bits", () => {
  const source = { A: 1, B: 2 };
  const target = { A: 16, B: 32 };
  const translate = translateFlags(source, target, "Test", [], 0xc0000000);
  assert.equal(translate(0), 0);
  assert.equal(translate(1), 16);
  assert.equal(translate(1 | 0x40000000), 16);
  assert.equal(translate(2 | 0x80000000), 32);
  assert.equal(translate(0xc0000000), 0);
  // Bits outside the ignored mask still fail loudly.
  assert.throws(() => translate(1 | 0x20000000), /Unsupported tsrs Test bits/u);
  assert.throws(() => translate(4), /Unsupported tsrs Test bits/u);
});

test("ObjectFlags translation accepts tsrs-only memo bits 30-31", () => {
  // The real tsrs SDK sets unnamed cache bits 30-31 on ObjectFlags; the
  // translator must mask them while still rejecting genuinely unknown bits.
  const sdk = {
    api: {
      TypeFlags: ts.TypeFlags,
      ObjectFlags: ts.ObjectFlags,
      SymbolFlags: ts.SymbolFlags,
    },
    ast: {
      NodeFlags: ts.NodeFlags,
      SyntaxKind: { ...ts.SyntaxKind, EndOfFile: ts.SyntaxKind.EndOfFileToken },
    },
  };
  const { flags } = createFlags(sdk);
  const reference = ts.ObjectFlags.Reference;
  assert.equal(flags.object(reference | 0x40000000), reference);
  assert.equal(flags.object(reference | 0x80000000), reference);
  assert.equal(flags.object(reference | 0xc0000000), reference);
  assert.equal(flags.object(0xc0000000), 0);
  assert.throws(
    () => flags.object(reference | 0x20000000),
    /Unsupported tsrs ObjectFlags bits/u,
  );
});

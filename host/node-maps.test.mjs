import assert from "node:assert/strict";
import { test } from "node:test";

import { nodeMaps } from "./type-services/node-maps.mjs";

const SyntaxKind = {
  SourceFile: 0,
  Identifier: 1,
  NumericLiteral: 2,
  ExportKeyword: 3,
  DefaultKeyword: 4,
  Decorator: 5,
};

function node(kind, start, end, children = []) {
  return {
    kind: SyntaxKind[kind],
    pos: start,
    end,
    getStart: () => start,
    forEachChild: visit => children.forEach(visit),
  };
}

function fixture(children, { start = 0, end = 100 } = {}) {
  const rawFile = node("SourceFile", start, end, children);
  rawFile.text = " ".repeat(end);
  let kinds;
  const maps = nodeMaps(
    { text: rawFile.text, visitorKeys: {} },
    rawFile,
    {
      ts: { skipTrivia: (_text, position) => position },
      wrap: value => value,
      prepareFile: value => (kinds = value),
    },
    { ast: { SyntaxKind } },
  );
  return { ...maps, rawFile, kinds };
}

test("range indexes distinguish colliding node kinds and preserve identities", () => {
  const identifier = node("Identifier", 4, 9);
  const literal = node("NumericLiteral", 4, 9);
  const { esTreeNodeToTSNodeMap: forward, tsNodeToESTreeNodeMap: reverse } =
    fixture([identifier, literal]);
  const estreeIdentifier = { type: "Identifier", range: [4, 9] };
  const estreeLiteral = { type: "Literal", range: [4, 9] };
  assert.equal(forward.get(estreeIdentifier), identifier);
  assert.equal(forward.get(estreeLiteral), literal);
  assert.equal(forward.get(estreeIdentifier), identifier);
  assert.equal(reverse.get(identifier), estreeIdentifier);
  assert.equal(reverse.get(literal), estreeLiteral);
});

test("multiple same-kind candidates still reject ambiguous mappings", () => {
  const { esTreeNodeToTSNodeMap: forward } = fixture([
    node("Identifier", 4, 9),
    node("NumericLiteral", 4, 9),
    node("Identifier", 4, 9),
  ]);
  assert.throws(
    () => forward.get({ type: "Identifier", range: [4, 9] }),
    /Cannot map Identifier.*\(2 matches\)/u,
  );
});

test("zero-width ranges and both source-file starts remain addressable", () => {
  const empty = node("Identifier", 8, 8);
  const { esTreeNodeToTSNodeMap: forward, rawFile } = fixture([empty], {
    start: 3,
  });
  assert.equal(forward.get({ type: "Identifier", range: [8, 8] }), empty);
  assert.equal(forward.get({ type: "Program", range: [0, 100] }), rawFile);
  assert.equal(forward.get({ type: "Program", range: [3, 100] }), rawFile);
});

test("duplicate range starts do not create ambiguous entries", () => {
  const exported = node("Identifier", 0, 9);
  exported.modifiers = [
    { kind: SyntaxKind.ExportKeyword, end: 0 },
    { kind: SyntaxKind.DefaultKeyword, end: 0 },
  ];
  const { esTreeNodeToTSNodeMap: forward, rawFile } = fixture([exported]);
  assert.equal(forward.get({ type: "Identifier", range: [0, 9] }), exported);
  assert.equal(forward.get({ type: "Program", range: [0, 100] }), rawFile);
});

test("node-kind indexes keep traversal order and missing lookups stay optional", () => {
  const first = node("Identifier", 2, 4);
  const middle = node("NumericLiteral", 5, 6);
  const last = node("Identifier", 8, 10);
  const { esTreeNodeToTSNodeMap: forward, kinds } = fixture([
    first,
    middle,
    last,
  ]);
  assert.deepEqual([...kinds.get(SyntaxKind.Identifier)], [first, last]);
  assert.equal(forward.has({ type: "Identifier", range: [5, 6] }), false);
  assert.equal(forward.has({ type: "Identifier", range: [50, 60] }), false);
  assert.throws(
    () => forward.get({ type: "Identifier", range: [50, 60] }),
    /\(0 matches\)/u,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueries } from "./type-services/queries.mjs";

function fixture({ adaptive = true } = {}) {
  const reads = [];
  const values = new Map();
  const checker = {
    getTypeAtLocation(input) {
      reads.push(input);
      return Array.isArray(input)
        ? input.map(node => values.get(node))
        : values.get(input);
    },
  };
  const nodes = Array.from({ length: 300 }, (_, index) => ({ kind: 1, index }));
  for (const node of nodes) values.set(node, { name: `type-${node.index}` });
  const previous = process.env.LINTRS_ADAPTIVE_TYPE_QUERIES;
  process.env.LINTRS_ADAPTIVE_TYPE_QUERIES = adaptive ? "1" : "0";
  let queries;
  try {
    queries = createQueries({
      sdk: { api: { TypeFlags: { StringLiteral: 128 } } },
      project: { checker },
      methods: new WeakMap(),
      wrap: value => value,
      unwrap: value => value,
    });
  } finally {
    if (previous === undefined) delete process.env.LINTRS_ADAPTIVE_TYPE_QUERIES;
    else process.env.LINTRS_ADAPTIVE_TYPE_QUERIES = previous;
  }
  queries.prepareFile(new Map([[1, new Set(nodes)]]));
  const read = queries.invoke(
    checker,
    "getTypeAtLocation",
    checker.getTypeAtLocation,
  );
  return { nodes, values, reads, read, queries };
}

test("sparse type queries leave unrelated nodes unread and memoize missing answers", () => {
  const { nodes, values, reads, read, queries } = fixture();
  const selected = nodes[120];
  const first = read(selected);
  assert.equal(first, values.get(selected));
  assert.equal(read(selected), first);
  assert.deepEqual(reads, [selected]);
  const missing = nodes[200];
  values.delete(missing);
  assert.equal(read(missing), undefined);
  assert.equal(read(missing), undefined);
  assert.deepEqual(reads, [selected, missing]);
  const outside = { kind: 1, index: 500 };
  values.set(outside, { name: "outside" });
  assert.equal(read(outside), values.get(outside));
  assert.deepEqual(reads, [selected, missing, outside]);
  const nextFile = { kind: 1, index: 120 };
  values.set(nextFile, { name: "next-file" });
  queries.prepareFile(new Map([[1, new Set([nextFile])]]));
  assert.equal(read(nextFile), values.get(nextFile));
  assert.notEqual(read(nextFile), first);
  assert.equal(read(selected), first);
  assert.deepEqual(reads, [selected, missing, outside, nextFile]);
});

test("dense type queries batch remaining nodes without refetching earlier identities", () => {
  const { nodes, values, reads, read } = fixture();
  const first = read(nodes[0]);
  for (const node of nodes) assert.equal(read(node), values.get(node));
  assert.equal(read(nodes[0]), first);
  assert.ok(reads.some(Array.isArray));
  assert.ok(reads.length < 32);
  const fetched = reads.flat();
  assert.equal(fetched.length, nodes.length);
  assert.equal(new Set(fetched).size, nodes.length);
});

test("type-query adaptation stays opt-in", () => {
  const { nodes, values, reads, read } = fixture({ adaptive: false });
  assert.equal(read(nodes[120]), values.get(nodes[120]));
  assert.ok(reads.every(Array.isArray));
  assert.equal(reads.flat().length, nodes.length);
});

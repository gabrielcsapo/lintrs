import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const enabled = process.env.LINTRS_TYPED_NATIVE === "1";
const binding = enabled
  ? createRequire(import.meta.url)(process.env.LINTRS_IN_PROCESS_BINDING)
  : undefined;

function fixture(
  t,
  source = "export const value: string = 'hello';\n",
  additionalFiles = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "lintrs-typed-native-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "sample.ts");
  writeFileSync(file, source);
  for (const [name, content] of Object.entries(additionalFiles))
    writeFileSync(join(directory, name), content);
  const session = binding.createSession(directory);
  t.after(() => session.close());
  const request = (method, params) =>
    JSON.parse(session.request(method, JSON.stringify(params)));
  const created = request("createSnapshot", {
    createPrograms: [
      { rootFiles: [file], compilerOptions: { strict: true, target: 9 } },
    ],
  });
  return {
    file,
    session,
    request,
    context: {
      snapshot: created.snapshot,
      project: created.operation.createdPrograms[0],
    },
  };
}

test(
  "fused eager symbols preserve SDK responses and compact binary AST headers",
  { skip: !enabled },
  t => {
    const source =
      "// Unicode Ω𐐀\nimport { target as local } from './dependency'; export const value = local; export const literal = 'plain';";
    const { session, request, context, file } = fixture(t, source, {
      "dependency.ts": "// Unicode Ω𐐀\nexport const target = 'hello';",
      "foreign.ts": "export const foreign = 42;",
    });
    const alias = request("getSymbolAtPosition", {
      ...context,
      file,
      position: source.indexOf("local"),
    });
    const value = request("getSymbolAtPosition", {
      ...context,
      file,
      position: source.indexOf("value"),
    });
    const literal = request("getSymbolAtPosition", {
      ...context,
      file,
      position: source.indexOf("literal"),
    });
    const offset = (handle, amount) => {
      const separator = handle.indexOf(".");
      return `${Number(handle.slice(0, separator)) + amount}${handle.slice(separator)}`;
    };
    const locations = [
      offset(alias.declarations[0], 2),
      offset(value.declarations[0], 1),
      offset(literal.declarations[0], 2),
    ];
    const expected = locations.map(location =>
      request("getSymbolAtLocation", { ...context, location }),
    );
    assert.equal(expected[0].name, "local");
    assert.equal(expected[2], null);
    const aliased = request("getAliasedSymbol", {
      ...context,
      symbol: alias.reference,
    });
    assert.equal(aliased.name, "target");
    const call = overrides =>
      session.requestValue("lintrsGetSymbolFacts", {
        ...context,
        locations,
        ...overrides,
      });
    const minimal = call();
    assert.deepEqual(
      minimal.results,
      expected.map(symbol => ({ symbol })),
    );
    const fused = call({ resolveAliases: true });
    assert.deepEqual(fused.results, [
      { symbol: expected[0], alias: aliased },
      { symbol: expected[1] },
      { symbol: null },
    ]);
    const aliasFacts = session.requestValue("lintrsGetAliasedSymbolFacts", {
      ...context,
      symbol: alias.reference,
    });
    assert.deepEqual(aliasFacts.symbol, aliased);
    assert.deepEqual(
      call({ resolveAliases: true, includeDeclarations: false }),
      { results: fused.results, declarations: [] },
    );
    assert.deepEqual(call({ includeDeclarations: false }), {
      results: minimal.results,
      declarations: [],
    });
    assert.deepEqual(
      session.requestValue("lintrsGetAliasedSymbolFacts", {
        ...context,
        symbol: alias.reference,
        includeDeclarations: false,
      }),
      { symbol: aliased, declarations: [] },
    );
    const binaries = new Map();
    const verifyHeaders = headers => {
      const ids = new Set();
      for (const header of headers) {
        assert.equal(ids.has(header.id), false);
        ids.add(header.id);
        const firstDot = header.id.indexOf(".");
        const secondDot = header.id.indexOf(".", firstDot + 1);
        const path = header.id.slice(secondDot + 1);
        let binary = binaries.get(path);
        if (binary === undefined) {
          binary = session.request(
            "getSourceFile",
            JSON.stringify({ ...context, file: path }),
          );
          binaries.set(path, binary);
        }
        const record =
          binary.readUInt32LE(40) + Number(header.id.slice(0, firstDot)) * 28;
        assert.deepEqual(
          {
            kind: header.kind,
            pos: header.pos,
            end: header.end,
            flags: header.flags,
          },
          {
            kind: binary.readUInt32LE(record),
            pos: binary.readUInt32LE(record + 4),
            end: binary.readUInt32LE(record + 8),
            flags: binary.readUInt32LE(record + 24),
          },
        );
      }
      assert.ok(ids.size > 0);
    };
    verifyHeaders(minimal.declarations);
    verifyHeaders(fused.declarations);
    verifyHeaders(aliasFacts.declarations);
    assert.deepEqual(call({ locations: [] }), {
      results: [],
      declarations: [],
    });
    const repeated = call({
      locations: Array(256).fill(locations[0]),
      resolveAliases: true,
    });
    assert.equal(repeated.results.length, 256);
    assert.deepEqual(repeated.declarations, [
      ...minimal.declarations.filter(header =>
        alias.declarations.includes(header.id),
      ),
      ...aliasFacts.declarations,
    ]);
    for (const overrides of [
      { locations: Array(257).fill(locations[0]) },
      { locations: [locations[0], "invalid-node"] },
      { locations: null },
      { locations: [12] },
      { resolveAliases: "yes" },
      { includeDeclarations: "yes" },
      { unknown: true },
      { project: "missing-project" },
      { snapshot: context.snapshot + 1_000_000 },
    ])
      assert.throws(() => call(overrides));
    const stale = {
      ...alias.reference,
      file: { ...alias.reference.file, contentHash: "stale" },
    };
    for (const symbol of [
      stale,
      { ...alias.reference, id: 9_007_199_254_740_991 },
    ])
      assert.throws(() =>
        session.requestValue("lintrsGetAliasedSymbolFacts", {
          ...context,
          symbol,
        }),
      );
    const unrelated = request("createSnapshot", {
      createPrograms: [
        {
          rootFiles: [join(file, "../foreign.ts")],
          compilerOptions: { strict: true, target: 9 },
        },
      ],
    });
    const foreignContext = {
      snapshot: unrelated.snapshot,
      project: unrelated.operation.createdPrograms[0],
    };
    assert.throws(() => call(foreignContext));
    assert.throws(() =>
      session.requestValue("lintrsGetAliasedSymbolFacts", {
        ...foreignContext,
        symbol: alias.reference,
      }),
    );
    assert.throws(() =>
      session.requestValue("lintrsGetAliasedSymbolFacts", {
        ...context,
        symbol: alias.reference,
        unknown: true,
      }),
    );
    assert.throws(() =>
      session.requestValue("lintrsGetAliasedSymbolFacts", {
        ...context,
        symbol: alias.reference,
        includeDeclarations: "yes",
      }),
    );
    assert.deepEqual(call({ resolveAliases: true }), fused);
    request("release", { snapshot: context.snapshot });
    assert.throws(() => call());
    assert.throws(() =>
      session.requestValue("lintrsGetAliasedSymbolFacts", {
        ...context,
        symbol: alias.reference,
      }),
    );
  },
);

test(
  "contextual type batches match scalar responses and validate ownership before computing",
  { skip: !enabled },
  t => {
    const source =
      "export const typed: string = 'hello'; export const inferred = 42;";
    const { session, request, file } = fixture(t, source);
    const foreign = `${file}.foreign.ts`;
    writeFileSync(foreign, "export const foreign: number = 42;");
    const created = request("createSnapshot", {
      createPrograms: [file, foreign].map(root => ({
        rootFiles: [root],
        compilerOptions: { strict: true, target: 9 },
      })),
    });
    const context = {
      snapshot: created.snapshot,
      project: created.operation.createdPrograms[0],
    };
    const handle = request("getSymbolAtPosition", {
      ...context,
      file,
      position: source.indexOf("typed"),
    }).declarations[0];
    const offset = (value, amount) => {
      const separator = value.indexOf(".");
      return `${Number(value.slice(0, separator)) + amount}${value.slice(separator)}`;
    };
    const inferred = request("getSymbolAtPosition", {
      ...context,
      file,
      position: source.indexOf("inferred"),
    }).declarations[0];
    const locations = [
      offset(handle, 3),
      offset(inferred, 2),
      offset(handle, 1),
    ];
    const expected = locations.map(location =>
      request("getContextualType", { ...context, location }),
    );
    assert.notEqual(expected[0], null);
    assert.equal(expected[1], null);
    assert.ok(session.typedMethods().includes("lintrsGetContextualTypes"));
    const batch = overrides =>
      session.requestValue("lintrsGetContextualTypes", {
        ...context,
        locations,
        ...overrides,
      });
    assert.deepEqual(batch(), expected);
    assert.deepEqual(batch({ locations: [] }), []);
    assert.deepEqual(
      batch({ locations: Array(256).fill(locations[0]) }),
      Array(256).fill(expected[0]),
    );
    for (const overrides of [
      { locations: Array(257).fill(locations[0]) },
      { locations: [locations[0], "invalid-node"] },
      { locations: [12] },
      { locations: undefined },
      { locations: null },
      { unknown: true },
      { project: "missing-project" },
      { snapshot: context.snapshot + 1_000_000 },
    ])
      assert.throws(() => batch(overrides));
    const foreignHandle = request("getSymbolAtPosition", {
      snapshot: context.snapshot,
      project: created.operation.createdPrograms[1],
      file: foreign,
      position: 14,
    }).declarations[0];
    assert.throws(() => batch({ locations: [foreignHandle] }));
    const sourceFile = offset(handle, 1 - Number(handle.split(".")[0]));
    assert.throws(
      () => batch({ locations: [sourceFile, "invalid-node"] }),
      error => !error.message.includes("panic"),
    );
    assert.deepEqual(batch(), expected);
    request("release", { snapshot: context.snapshot });
    assert.throws(() => batch());
    session.close();
    assert.throws(() => batch(), /closed/u);
  },
);

test(
  "typed native queries match protocol results and retain snapshot checks",
  { skip: !enabled },
  t => {
    const { session, request, context } = fixture(t);
    assert.ok(session.typedMethods().includes("getStringType"));
    assert.ok(session.typedMethods().includes("lintrsIsTypeAssignableToMany"));
    assert.equal(session.typedMethods().includes("createSnapshot"), false);
    assert.equal(session.typedMethods().includes("typeToTypeNode"), false);
    const string = session.requestValue("getStringType", context);
    const number = session.requestValue("getNumberType", context);
    assert.deepEqual(string, request("getStringType", context));
    assert.deepEqual(number, request("getNumberType", context));
    const batch = {
      ...context,
      source: string.id,
      targets: [string.id, number.id],
    };
    assert.deepEqual(
      session.requestValue("lintrsIsTypeAssignableToMany", batch),
      [true, false],
    );
    assert.throws(() =>
      session.requestValue("lintrsIsTypeAssignableToMany", {
        ...batch,
        source: 4_294_967_295,
      }),
    );
    assert.throws(() =>
      session.requestValue("lintrsIsTypeAssignableToMany", {
        ...batch,
        targets: [4_294_967_295],
      }),
    );
    assert.throws(() =>
      session.requestValue("lintrsIsTypeAssignableToMany", {
        ...batch,
        targets: Array(65).fill(string.id),
      }),
    );
    assert.throws(
      () =>
        session.requestValue("lintrsIsTypeAssignableToMany", {
          ...batch,
          unknown: true,
        }),
      /Unknown/u,
    );
    assert.deepEqual(
      session.requestValue("lintrsIsTypeAssignableToMany", batch),
      [true, false],
    );
    assert.throws(
      () => session.requestValue("createSnapshot", {}),
      /not implemented/u,
    );
    request("release", { snapshot: context.snapshot });
    assert.throws(() => session.requestValue("getStringType", context));
    session.close();
    assert.throws(
      () => session.requestValue("getStringType", context),
      /closed/u,
    );
  },
);

test(
  "typed conversion omits undefined fields and rejects unsupported inputs safely",
  { skip: !enabled },
  t => {
    const { session, context } = fixture(t);
    const expected = session.requestValue("getStringType", context);
    assert.deepEqual(
      session.requestValue("getStringType", { ...context, omitted: undefined }),
      expected,
    );
    assert.deepEqual(
      session.requestValue(
        "getStringType",
        Object.assign(Object.create(null), context),
      ),
      expected,
    );
    assert.deepEqual(
      session.requestValue("getStringType", {
        ...context,
        values: [undefined, , null],
      }),
      expected,
    );
    const cycle = {};
    cycle.self = cycle;
    for (const bad of [
      cycle,
      NaN,
      Infinity,
      () => {},
      Symbol("bad"),
      1n,
      new Date(),
      new Map(),
      new Uint32Array([1]),
      "\ud800",
    ])
      assert.throws(() =>
        session.requestValue("getStringType", { ...context, bad }),
      );
    assert.throws(
      () => session.requestValue("getStringType", []),
      /plain object/u,
    );
    assert.throws(
      () => session.requestValue.call({}, "getStringType", context),
      /receiver/u,
    );
    assert.deepEqual(session.requestValue("getStringType", context), expected);
  },
);

test(
  "typed conversion preserves short and long UTF-16 strings across buffer boundaries",
  { skip: !enabled },
  t => {
    const names = [
      "a".repeat(254),
      "b".repeat(255),
      "c".repeat(256),
      "d".repeat(254) + "𐐀".repeat(128),
      "Ω".repeat(1024),
    ];
    const source = names.map(name => `const ${name} = 0;`).join("\n");
    const { session, request, context } = fixture(t, source);
    for (const name of names) {
      const params = { ...context, name, meaning: 2 };
      const value = session.requestValue("resolveName", params);
      assert.equal(value.name, name);
      assert.deepEqual(value, request("resolveName", params));
    }
    for (const prefix of [0, 254, 255, 256, 1024]) {
      assert.throws(
        () =>
          session.requestValue("getStringType", {
            ...context,
            extra: "a".repeat(prefix) + "\ud800",
          }),
        /surrogates/u,
      );
    }
    assert.throws(
      () =>
        session.requestValue("getStringType", {
          ...context,
          ["a".repeat(255) + "\ud800"]: true,
        }),
      /surrogates/u,
    );
  },
);

test(
  "nodeFacts returns lazy handles and objectProperty retrieves only requested fields",
  { skip: !enabled },
  t => {
    const { session, request, context, file } = fixture(t);
    const expectedSymbol = request("getSymbolAtPosition", {
      ...context,
      file,
      position: 14,
    });
    const declarationIndex = Number(
      expectedSymbol.declarations[0].split(".")[0],
    );
    // This fixture's variable declaration visits its identifier as its first child.
    const index = declarationIndex + 1;
    const facts = session.nodeFacts(
      context.snapshot,
      context.project,
      file,
      new Uint32Array([index]),
      7,
    );
    assert.deepEqual(Object.keys(facts), [
      "types",
      "symbols",
      "contextualTypes",
    ]);
    assert.deepEqual(Object.keys(facts.types[0]).sort(), ["flags", "id"]);
    assert.deepEqual(Object.keys(facts.symbols[0]).sort(), [
      "flags",
      "reference",
    ]);
    assert.equal(facts.contextualTypes[0], null);
    const type = facts.types[0];
    const symbol = facts.symbols[0];
    const property = (kind, handle, name) =>
      session.objectProperty(
        context.snapshot,
        context.project,
        kind,
        handle,
        name,
      );
    const hydrated = property("symbol", symbol.reference, "__hydrate");
    assert.deepEqual(hydrated, expectedSymbol);
    assert.equal(property("symbol", symbol.reference, "name"), hydrated.name);
    assert.deepEqual(
      property("symbol", symbol.reference, "declarations"),
      hydrated.declarations,
    );
    assert.equal(
      property("symbol", symbol.reference, "unrecognizedProperty"),
      undefined,
    );
    assert.equal(property("type", type.id, "flags"), type.flags);
    assert.equal(property("type", type.id, "__hydrate").id, type.id);
    assert.equal(property("type", type.id, "unrecognizedProperty"), undefined);
    for (const nodes of [
      [0],
      new Uint8Array([0]),
      new Uint32Array(257),
      new Uint32Array([1, 4_294_967_295]),
      new Uint32Array(new SharedArrayBuffer(4)),
    ])
      assert.throws(() =>
        session.nodeFacts(context.snapshot, context.project, file, nodes, 1),
      );
    const detached = new Uint32Array([1]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    assert.throws(() =>
      session.nodeFacts(context.snapshot, context.project, file, detached, 1),
    );
    assert.throws(() =>
      session.nodeFacts(
        context.snapshot,
        context.project,
        file,
        new Uint32Array([index]),
        8,
      ),
    );
    assert.throws(() => property("type", 4_294_967_295, "flags"));
    assert.deepEqual(
      session.nodeFacts(
        context.snapshot,
        context.project,
        file,
        new Uint32Array([index]),
        1,
      ).types,
      facts.types,
    );
    request("release", { snapshot: context.snapshot });
    assert.throws(() =>
      session.nodeFacts(
        context.snapshot,
        context.project,
        file,
        new Uint32Array([index]),
        1,
      ),
    );
    assert.throws(() => property("symbol", symbol.reference, "name"));
  },
);

test(
  "nodeFactsPlanned fuses only validated symbol properties and checks snapshot release",
  { skip: !enabled },
  t => {
    const { session, request, context, file } = fixture(t);
    const symbol = request("getSymbolAtPosition", {
      ...context,
      file,
      position: 14,
    });
    const index = Number(symbol.declarations[0].split(".")[0]) + 1;
    const nodes = new Uint32Array([index]);
    const fields = ["name", "declarations", "valueDeclaration", "checkFlags"];
    const planned = symbolFields =>
      session.nodeFactsPlanned(
        context.snapshot,
        context.project,
        file,
        nodes,
        7,
        symbolFields,
      );
    const regular = session.nodeFacts(
      context.snapshot,
      context.project,
      file,
      nodes,
      7,
    );
    const fused = planned(fields);
    assert.deepEqual(fused.types, regular.types);
    assert.deepEqual(fused.contextualTypes, regular.contextualTypes);
    assert.deepEqual(fused.symbols[0].reference, regular.symbols[0].reference);
    assert.equal(fused.symbols[0].flags, regular.symbols[0].flags);
    for (const field of fields) {
      const expected = session.objectProperty(
        context.snapshot,
        context.project,
        "symbol",
        regular.symbols[0].reference,
        field,
      );
      assert.deepEqual(fused.symbols[0].properties[field], expected);
      assert.equal(
        Object.hasOwn(fused.symbols[0].properties, field),
        expected !== undefined,
      );
    }
    assert.deepEqual(planned([]).symbols[0].properties, {});
    assert.deepEqual(Object.keys(planned(["name"]).symbols[0].properties), [
      "name",
    ]);
    for (const invalid of [
      ["flags"],
      ["__hydrate"],
      ["name", "name"],
      [...fields, "name"],
      [undefined],
      [1],
      "name",
      {},
    ])
      assert.throws(() => planned(invalid), /symbol fields/u);
    assert.deepEqual(planned(fields), fused);
    request("release", { snapshot: context.snapshot });
    assert.throws(() => planned(fields));
  },
);

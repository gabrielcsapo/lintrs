import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { fixture, run, oracle } from "./test-support/fixture.mjs";

const require = createRequire(import.meta.url);

test("batched location queries retain identities, missing symbols, and file isolation", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source: `${Array.from(
      { length: 300 },
      (_, index) => `export const value${index}: number = ${index};`,
    ).join("\n")}\nmissing;\n`,
    extraConfig: `{plugins: {probe: {rules: {locations: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {Identifier(node) {
          const raw = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getTypeAtLocation(raw);
          const symbol = checker.getSymbolAtLocation(raw);
          if (checker.getTypeAtLocation(raw) !== type || checker.getSymbolAtLocation(raw) !== symbol)
            throw new Error('Location query identity changed');
          context.report({node, message: node.name + ': ' + checker.typeToString(type) + ' / ' + (symbol?.name ?? 'missing')});
        }};
      }
    }}}}, rules: {'probe/locations': 'error'}}`,
  });
  const second = join(f.dir, "second.ts");
  writeFileSync(
    second,
    "export const value0: string = 'different';\nmissing;\n",
  );
  const profile = join(f.dir, "type-profile.json");
  const actual = run(f, [second], { LINTRS_TYPE_PROFILE: profile });
  assert.equal(actual.status, 1, actual.stderr);
  const timing = JSON.parse(readFileSync(profile, "utf8"));
  if (process.env.LINTRS_LAZY_OBJECTS === "1") {
    const facts =
      timing.native.lintrsNodeFacts +
      (timing.native.lintrsNodeFactsPlanned ?? 0);
    if (process.env.LINTRS_LAZY_PREFETCH === "1") assert.ok(facts < 606);
    else assert.equal(facts, 606);
    if (process.env.LINTRS_ADAPTIVE_FACTS === "1")
      assert.ok(timing.native["lintrsProperty:symbol:name"] <= 301);
    else assert.equal(timing.native["lintrsProperty:symbol:name"], 301);
  } else {
    assert.ok(timing.api.totals.requestCount < 100, JSON.stringify(timing));
  }
  const eslint = new ESLint({ cwd: f.dir, overrideConfigFile: f.config });
  const expected = await eslint.lintFiles([f.file, second]);
  assert.deepEqual(
    JSON.parse(actual.stdout),
    expected.sort((a, b) => a.filePath.localeCompare(b.filePath)),
  );
});

test(
  "lazy handles preserve identities without loading unread symbol properties",
  {
    skip: process.env.LINTRS_LAZY_OBJECTS !== "1",
  },
  async t => {
    const f = fixture(t, {
      typed: true,
      rules: {},
      source:
        "export const selected: string = 'hello';\nexport const unread = 123;\n",
      extraConfig: `{plugins: {probe: {rules: {lazy: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {"Identifier[name='selected']"(node) {
          const raw = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getTypeAtLocation(raw);
          const symbol = checker.getSymbolAtLocation(raw);
          if (checker.getTypeAtLocation(raw) !== type || checker.getSymbolAtLocation(raw) !== symbol)
            throw new Error('Lazy identity changed');
          if (symbol.getFlags() !== symbol.flags || type.getFlags() !== type.flags)
            throw new Error('Flag reads changed');
          checker.getBaseConstraintOfType(type);
          context.report({node, message: 'type flags: ' + type.flags + ' / symbol flags: ' + symbol.flags});
        }};
      }
    }}}}, rules: {'probe/lazy': 'error'}}`,
    });
    const profile = join(f.dir, "lazy-profile.json");
    const actual = run(f, [], { LINTRS_TYPE_PROFILE: profile });
    assert.equal(actual.status, 1, actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
    const timing = JSON.parse(readFileSync(profile, "utf8"));
    assert.ok(
      timing.lazy.every(
        project => project.properties === 0 && project.hydrations === 0,
      ),
    );
    if (process.env.LINTRS_LAZY_PREFETCH !== "1") {
      assert.equal(timing.native.lintrsNodeFacts, 2);
      assert.equal(timing.lazy[0].symbols, 1);
    }
  },
);

test(
  "learned rule plans fuse later files and preserve fresh declarations and fallback fields",
  {
    skip: process.env.LINTRS_ADAPTIVE_FACTS !== "1",
  },
  async t => {
    const source = prefix =>
      Array.from(
        { length: 12 },
        (_, index) => `export const ${prefix}${index} = ${index};`,
      ).join("\n");
    const f = fixture(t, {
      typed: true,
      rules: {},
      source: source("first"),
      extraConfig: `{plugins: {probe: {rules: {plan: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {Identifier(node) {
          const symbol = checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node));
          const declaration = symbol.declarations[0];
          const unexpected = node.name.startsWith('third') ? symbol.valueDeclaration.name.text : '';
          context.report({node, message: symbol.name + ':' + declaration.name.text + ':' + unexpected});
        }};
      }
    }}}}, rules: {'probe/plan': 'error'}}`,
    });
    const second = join(f.dir, "second.ts");
    const third = join(f.dir, "third.ts");
    writeFileSync(second, source("second"));
    writeFileSync(third, source("third"));
    const profile = join(f.dir, "plan-profile.json");
    const actual = run(f, [second, third], { LINTRS_TYPE_PROFILE: profile });
    assert.equal(actual.status, 1, actual.stderr);
    const eslint = new ESLint({ cwd: f.dir, overrideConfigFile: f.config });
    const expected = await eslint.lintFiles([f.file, second, third]);
    assert.deepEqual(
      JSON.parse(actual.stdout),
      expected.sort((a, b) => a.filePath.localeCompare(b.filePath)),
    );
    const timing = JSON.parse(readFileSync(profile, "utf8"));
    assert.ok(
      timing.accessPlans.fusedQueries > 0,
      JSON.stringify(timing.accessPlans),
    );
    assert.ok(timing.accessPlans.usedFields > 0);
    assert.ok(timing.native["lintrsProperty:symbol:valueDeclaration"] > 0);
  },
);

test("batched assignability preserves string unions, enum identity, and cached false answers", async t => {
  const texts = Array.from({ length: 130 }, (_, index) =>
    JSON.stringify(`value${index}`),
  );
  const members = Array.from(
    { length: 70 },
    (_, index) => `Value${index} = 'value${index}'`,
  );
  const f = fixture(t, {
    typed: true,
    rules: {},
    source: `type Text = ${texts.join(" | ")};
enum Choice { ${members.join(",")} }
declare const textSource: Text;
declare const textTarget: Text;
declare const enumSource: Choice;
declare const enumTarget: Choice;
`,
    extraConfig: `{plugins: {probe: {rules: {assignments: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        const declarations = new Map();
        return {
          VariableDeclarator(node) {
            if (node.id.type === 'Identifier') declarations.set(node.id.name, node.id);
          },
          'Program:exit'() {
            for (const [leftName, rightName] of [['textSource', 'textTarget'], ['enumSource', 'enumTarget']]) {
              const leftNode = declarations.get(leftName);
              const rightNode = declarations.get(rightName);
              const left = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(leftNode));
              const right = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(rightNode));
              if (!left.isUnion() || !right.isUnion()) throw new Error('Expected unions');
              for (const [index, source] of left.types.entries()) {
                const compare = () => right.types.map(target => checker.isTypeAssignableTo(source, target) ? '1' : '0').join('');
                const result = compare();
                if (compare() !== result) throw new Error('Cached assignability changed');
                context.report({node: leftNode, message: leftName + ':' + index + ':' + result});
              }
            }
          }
        };
      }
    }}}}, rules: {'probe/assignments': 'error'}}`,
  });
  const profile = join(f.dir, "type-profile.json");
  const actual = run(f, [], { LINTRS_TYPE_PROFILE: profile });
  assert.equal(actual.status, 1, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
  const timing = JSON.parse(readFileSync(profile, "utf8"));
  assert.ok(timing.api.totals.requestCount < 700, JSON.stringify(timing));
});

test("memoized checker queries preserve optional arguments and missing answers", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source: "export const items: string[] = [];\n",
    extraConfig: `{plugins: {probe: {rules: {memo: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {"Identifier[name='items']"(node) {
          const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
          const results = [];
          for (let repeat = 0; repeat < 3; repeat++) {
            results.push(checker.typeToString(type));
            results.push(checker.typeToString(type, undefined, ${require("typescript").TypeFormatFlags.WriteArrayAsGenericType}));
            results.push(checker.typeToString(type, undefined));
            if (checker.getPropertyOfType(type, 'missing') !== undefined)
              throw new Error('Missing property became present');
          }
          context.report({node, message: results.join(' / ')});
        }};
      }
    }}}}, rules: {'probe/memo': 'error'}}`,
  });
  const profile = join(f.dir, "memo-profile.json");
  const actual = run(f, [], { LINTRS_TYPE_PROFILE: profile });
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
  const timing = JSON.parse(readFileSync(profile, "utf8"));
  if (process.env.LINTRS_TYPED_NATIVE === "1") {
    assert.equal(timing.native.typeToString, 3);
    assert.equal(timing.native.getPropertyOfType, 1);
  }
});

test("contextual type batches preserve shared identities and missing answers", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source:
      'const first: string = "a"; const second: string = "b"; const free = "c";\n',
    extraConfig: `{plugins: {probe: {rules: {context: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        let stringType;
        return {Literal(node) {
          const tsNode = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getContextualType(tsNode);
          if (checker.getContextualType(tsNode) !== type)
            throw new Error('Repeated contextual type changed identity');
          if (type !== undefined) {
            if (stringType !== undefined && stringType !== type)
              throw new Error('Shared contextual type changed identity');
            stringType = type;
          }
          context.report({node, message: type === undefined ? 'missing' : checker.typeToString(type)});
        }};
      }
    }}}}, rules: {'probe/context': 'error'}}`,
  });
  const profile = join(f.dir, "context-profile.json");
  const actual = run(f, [], { LINTRS_TYPE_PROFILE: profile });
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
  if (
    process.env.LINTRS_CONTEXTUAL_BATCH === "1" &&
    process.env.LINTRS_LAZY_OBJECTS !== "1"
  ) {
    const timing = JSON.parse(readFileSync(profile, "utf8"));
    assert.equal(timing.native.lintrsGetContextualTypes, 1);
    assert.equal(timing.native.getContextualType, undefined);
  }
});

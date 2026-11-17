import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixture, run, oracle } from "./test-support/fixture.mjs";

test("declaration headers preserve alias identity and UTF-16 ranges without fetching dependency ASTs", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source: 'import { Imported, Other } from "./dependency";\n',
    extraConfig: `{plugins: {probe: {rules: {headers: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {ImportSpecifier(node) {
          const tsNode = services.esTreeNodeToTSNodeMap.get(node.local);
          const symbol = checker.getSymbolAtLocation(tsNode);
          if (checker.getSymbolAtLocation(tsNode) !== symbol) throw new Error('Symbol identity changed');
          const target = checker.getAliasedSymbol(symbol);
          if (checker.getAliasedSymbol(symbol) !== target) throw new Error('Alias identity changed');
          const declaration = target.getDeclarations()[0];
          if (target.getDeclarations()[0] !== declaration) throw new Error('Declaration identity changed');
          context.report({node, message: JSON.stringify([declaration.kind, declaration.pos, declaration.end, declaration.flags])});
        }};
      }
    }}}}, rules: {'probe/headers': 'error'}}`,
  });
  writeFileSync(
    join(f.dir, "dependency.ts"),
    "// 😀\nexport class Imported {}\nexport interface Other { value: string }\n",
  );
  const profile = join(f.dir, "header-profile.json");
  const actual = run(f, [], { LINTRS_TYPE_PROFILE: profile });
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
  if (process.env.LINTRS_COMPACT_DECLARATIONS === "1") {
    const timing = JSON.parse(readFileSync(profile, "utf8"));
    assert.equal(timing.api.totals.sourceFilesFetched, 1);
    assert.equal(timing.native.getAliasedSymbol, undefined);
    if (process.env.LINTRS_FUSED_SYMBOLS === "1")
      assert.equal(timing.native.lintrsGetAliasedSymbolFacts, undefined);
  }
});

test("compact declarations retain identity after AST fallback and accept checker queries", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source: 'import { Imported, Other } from "./dependency";\n',
    extraConfig: `{plugins: {probe: {rules: {fallback: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        let dependency;
        return {ImportSpecifier(node) {
          const tsNode = services.esTreeNodeToTSNodeMap.get(node.local);
          const symbol = checker.getAliasedSymbol(checker.getSymbolAtLocation(tsNode));
          const declaration = symbol.getDeclarations()[0];
          const file = declaration.getSourceFile();
          if (dependency !== undefined && file !== dependency) throw new Error('SourceFile identity changed');
          dependency = file;
          const found = file.statements.find(statement => statement.pos === declaration.pos);
          if (found !== declaration) throw new Error('Hydration changed declaration identity');
          const name = declaration.name;
          if (name.parent !== declaration) throw new Error('Parent identity changed');
          if (checker.getSymbolAtLocation(name) !== symbol) throw new Error('Checker symbol identity changed');
          context.report({node, message: JSON.stringify([name.text, declaration.getText(), checker.typeToString(checker.getTypeAtLocation(declaration))])});
        }};
      }
    }}}}, rules: {'probe/fallback': 'error'}}`,
  });
  writeFileSync(
    join(f.dir, "dependency.ts"),
    "// 😀\nexport class Imported { value = 1; }\nexport interface Other { value: string }\n",
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
});

test("the import rule reuses shared declarations without hiding derived cycles", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    extraConfig: `{plugins: {fixture: {rules: {'no-import-derived-from-raw': {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        const containsRaw = (type, seen = new Set()) => {
          if (type === undefined || seen.has(type)) return false;
          seen.add(type);
          const names = [type.getSymbol?.()?.name, type.aliasSymbol?.name];
          if (names.includes('Raw') || names.includes('Wrapped')) return true;
          for (const base of type.isClassOrInterface?.() ? checker.getBaseTypes(type) : [])
            if (containsRaw(base, seen)) return true;
          for (const prop of checker.getPropertiesOfType(type)) {
            const location = prop.getDeclarations()?.[0] ?? context.sourceCode.ast;
            if (containsRaw(checker.getTypeOfSymbolAtLocation(prop, location), seen))
              return true;
          }
          return false;
        };
        return {
          ImportSpecifier(node) {
            const symbol = checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node.local));
            const target = checker.getAliasedSymbol(symbol);
            const type = checker.getDeclaredTypeOfSymbol(target);
            if (containsRaw(type))
              context.report({node, message: 'Imported type derives from Raw'});
          }
        };
      }
    }}}}, rules: {
      'fixture/no-import-derived-from-raw': 'error'
    }}`,
    source: `import type { StableFirst, StableSecond, Cycle, Partner, Cycle as Again, DerivedFirst, DerivedSecond, Extended, Merged } from './dependency';\n`,
  });
  writeFileSync(
    join(f.dir, "dependency.ts"),
    `type Wrapped<T> = { raw: T };
type Raw = Wrapped<string>;
type Stable = { next: Stable };
export type StableFirst = { value: Stable };
export type StableSecond = { value: Stable };
export interface Cycle { next: Partner; raw: Raw }
export interface Partner { next: Cycle }
export type DerivedFirst = { value: Raw };
export type DerivedSecond = { value: Raw };
export interface Extended extends Cycle {}
export interface Merged { value: Stable }
export interface Merged { raw: Raw }
`,
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const result = JSON.parse(actual.stdout)[0];
  assert.equal(result.messages.length, 7);
  assert.deepEqual(result, await oracle(f));
});

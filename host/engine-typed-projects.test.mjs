import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { binary, fixture, run, oracle } from "./test-support/fixture.mjs";

const require = createRequire(import.meta.url);

test("an empty type profile path disables profiling", async t => {
  const f = fixture(t, {
    typed: true,
    rules: { "@typescript-eslint/no-unsafe-unary-minus": "error" },
    source: "export const value = 1; -value;\n",
  });
  const actual = run(f, [], { LINTRS_TYPE_PROFILE: "" });
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
});

test("provided programs preserve compiler overrides and declaration references in the Rust checker", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/no-unsafe-unary-minus": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
    source:
      "import { value } from './dependency/src/value';\n-value;\ndeclare const name: string | null;\nif (name !== null) console.log(name);\n",
  });
  const dependency = join(f.dir, "dependency");
  mkdirSync(join(dependency, "src"), { recursive: true });
  mkdirSync(join(dependency, "dist"));
  writeFileSync(
    join(dependency, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { composite: true, rootDir: "src", outDir: "dist" },
      include: ["src/*.ts"],
    }),
  );
  writeFileSync(join(dependency, "src/value.ts"), "export const value = 1;\n");
  writeFileSync(
    join(dependency, "dist/value.d.ts"),
    "export declare const value: string;\n",
  );
  const config = JSON.parse(readFileSync(join(f.dir, "tsconfig.json"), "utf8"));
  config.references = [{ path: "./dependency" }];
  writeFileSync(join(f.dir, "tsconfig.json"), JSON.stringify(config));
  writeFileSync(
    f.config,
    `import ts from 'typescript';
import plugin from 'typescript-eslint';
const path = ${JSON.stringify(join(f.dir, "tsconfig.json"))};
const parsed = ts.getParsedCommandLineOfConfigFile(path, {strictNullChecks: false}, {...ts.sys, onUnRecoverableConfigFileDiagnostic(d) { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\\n')); }});
const program = ts.createProgram({rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences});
if (process.env.LINTRS_FORBID_JS_CHECKER) program.getTypeChecker = () => { throw new Error('JavaScript checker must not run'); };
export default [{files: ['**/*.ts'], plugins: {'@typescript-eslint': plugin.plugin}, languageOptions: {parser: plugin.parser, parserOptions: {programs: [program], projectService: false}}, rules: {'@typescript-eslint/no-unsafe-unary-minus': 'error', '@typescript-eslint/no-unnecessary-condition': 'error'}}];\n`,
  );
  const actual = spawnSync(binary, ["-c", f.config, "-f", "json", f.file], {
    cwd: f.dir,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", LINTRS_FORBID_JS_CHECKER: "1" },
  });
  assert.equal(actual.status, 1, actual.stderr);
  const expected = await oracle(f);
  assert.equal(expected.messages.length, 2, JSON.stringify(expected.messages));
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

test("typed services defer node maps until a rule queries them", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source: "export const value = 1;\n",
    extraConfig: `{plugins: {bridge: {rules: {inspect: {meta: {schema: []}, create(context) {const services = context.sourceCode.parserServices; if (!services.program || typeof services.esTreeNodeToTSNodeMap.get !== 'function' || typeof services.tsNodeToESTreeNodeMap.get !== 'function') throw new Error('Missing typed services'); return {};}}}}}, rules: {'bridge/inspect': 'error'}}`,
  });
  const profile = join(f.dir, "profile.json");
  const actual = run(f, [], { LINTRS_TYPE_PROFILE: profile });
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
  const timing = JSON.parse(readFileSync(profile, "utf8"));
  assert.equal(timing.api.totals.sourceFilesFetched ?? 0, 0);
});

test("referenced projects use built declarations and preserve deprecated exports", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/no-unsafe-unary-minus": "error",
      "@typescript-eslint/no-deprecated": "warn",
    },
    source:
      "import { text, legacy } from './dependency/src/types';\n-text;\nlegacy();\n",
  });
  const configPath = join(f.dir, "tsconfig.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.references = [{ path: "./dependency" }];
  writeFileSync(configPath, JSON.stringify(config));
  const dependency = join(f.dir, "dependency");
  mkdirSync(join(dependency, "src"), { recursive: true });
  mkdirSync(join(dependency, "dist"));
  writeFileSync(
    join(dependency, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { composite: true, rootDir: "src", outDir: "dist" },
      include: ["src/*.ts"],
    }),
  );
  writeFileSync(
    join(dependency, "src/types.ts"),
    "export const text = 1;\nexport function legacy() {}\n",
  );
  writeFileSync(
    join(dependency, "dist/types.d.ts"),
    "export declare const text: string;\n/** @deprecated Use replacement. */\nexport declare function legacy(): void;\n",
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const ts = require("typescript");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(JSON.stringify(diagnostic));
      },
    },
  );
  assert.ok(parsed);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const eslint = new ESLint({
    cwd: f.dir,
    overrideConfigFile: f.config,
    overrideConfig: {
      languageOptions: {
        parserOptions: { projectService: false, programs: [program] },
      },
    },
  });
  const expected = await eslint.lintFiles([f.file]);
  assert.equal(expected[0].errorCount, 1);
  assert.equal(expected[0].warningCount, 1);
  assert.deepEqual(JSON.parse(actual.stdout), expected);
});

test("typed services retain a project across files and release it before another project", async t => {
  const f = fixture(t, {
    typed: true,
    rules: { "@typescript-eslint/no-unsafe-unary-minus": "error" },
    source: "export const value: string = 'text'; -value;\n",
  });
  const second = join(f.dir, "second.ts");
  writeFileSync(second, "import { value } from './sample'; -value;\n");
  const nested = join(f.dir, "nested");
  mkdirSync(nested);
  writeFileSync(
    join(nested, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "es2022" },
      include: ["*.ts"],
    }),
  );
  const other = join(nested, "other.ts");
  writeFileSync(other, "export const value: number = 1; -value;\n");
  const actual = run(f, [second, other]);
  assert.equal(actual.status, 1, actual.stderr);
  const eslint = new ESLint({ cwd: f.dir, overrideConfigFile: f.config });
  const expected = await eslint.lintFiles([f.file, second, other]);
  assert.deepEqual(
    JSON.parse(actual.stdout),
    expected.sort((a, b) => a.filePath.localeCompare(b.filePath)),
  );
});

test("source file enumeration stays lazy and preserves EOF, identities, and exported node maps", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source:
      "export interface Named { readonly id: string }\nexport default class Default { value = 1; }\n",
    extraConfig: `((ts, assert) => ({plugins: {bridge: {rules: {inspect: {
      meta: {schema: [], messages: {checked: 'Checked source file compatibility'}},
      create(context) {
        const services = context.sourceCode.parserServices;
        const program = services.program;
        const current = services.esTreeNodeToTSNodeMap.get(context.sourceCode.ast);
        const files = program.getSourceFiles();
        assert.equal(program.getSourceFiles(), files);
        assert.equal(files.find(file => file.fileName === context.filename), current);
        for (const file of files) {
          assert.equal(file.kind, ts.SyntaxKind.SourceFile);
          assert.equal(typeof file.isDeclarationFile, 'boolean');
          assert.equal(file.getSourceFile(), file);
        }
        const dependency = files.find(file => file.fileName.endsWith('/dependency-0.d.ts'));
        assert.ok(dependency);
        assert.equal(dependency.isDeclarationFile, true);
        assert.equal(dependency.statements[0].name.text, 'Dependency0');
        assert.equal(program.getSourceFile(dependency.fileName), dependency);
        assert.equal(dependency.statements[0].getSourceFile(), dependency);
        assert.equal(current.endOfFileToken.kind, ts.SyntaxKind.EndOfFileToken);
        assert.ok(files.some(file => file.fileName.includes('/node_modules/typescript/lib/')));
        return {
          'ExportNamedDeclaration, ExportDefaultDeclaration'(node) {
            if (node.declaration == null) return;
            const declaration = services.esTreeNodeToTSNodeMap.get(node.declaration);
            assert.equal(services.esTreeNodeToTSNodeMap.get(node), declaration);
            assert.equal(services.tsNodeToESTreeNodeMap.get(declaration), node.declaration);
          },
          'Program:exit'(node) { context.report({node, messageId: 'checked'}); }
        };
      }
    }}}}, rules: {'bridge/inspect': 'warn'}}))(
      (await import('typescript')).default, (await import('node:assert/strict')).default
    )`,
  });
  for (let index = 0; index < 20; index++)
    writeFileSync(
      join(f.dir, `dependency-${index}.d.ts`),
      `export interface Dependency${index} { readonly value: string }\n`,
    );
  const profile = join(f.dir, "profile.json");
  const actual = run(f, [], { LINTRS_TYPE_PROFILE: profile });
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
  const timing = JSON.parse(readFileSync(profile, "utf8"));
  assert.equal(timing.api.totals.sourceFilesFetched, 2);
});

test("unchanged contract rules inspect views and stop at installed standard library types", async t => {
  const source = `import type { Request } from 'express';
export interface ProductView { readonly id: string; labels?: string[] }
export type OtherView = { readonly product: ProductView };
export class TransportApi {
  stream(input: ReadableStream<string>): ReadableStream<string> { return input; }
  invalid(input: Request): void { void input; }
}
`;
  const f = fixture(t, {
    typed: true,
    rules: {},
    source,
    extraConfig: `{plugins: {fixture: {rules: {
      'view-contracts-are-owned': {
        meta: {schema: []},
        create(context) {
          const services = context.sourceCode.parserServices;
          const checker = services.program.getTypeChecker();
          const seen = new Set();
          const owned = type => {
            if (type === undefined || seen.has(type)) return;
            seen.add(type);
            for (const prop of checker.getPropertiesOfType(type)) {
              const declarations = prop.getDeclarations() ?? [];
              if (declarations.some(declaration => declaration.getSourceFile().fileName.includes('node_modules')))
                continue;
              owned(checker.getTypeOfSymbolAtLocation(prop, declarations[0] ?? context.sourceCode.ast));
            }
          };
          return {
            'TSInterfaceDeclaration[id.name=/View$/], TSTypeAliasDeclaration[id.name=/View$/]'(node) {
              owned(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node.id)));
            }
          };
        }
      },
      'view-contracts-are-readonly': {
        meta: {schema: []},
        create(context) {
          return {
            'TSInterfaceDeclaration[id.name=/View$/] TSPropertySignature, TSTypeAliasDeclaration[id.name=/View$/] TSPropertySignature'(node) {
              if (!node.readonly)
                context.report({node, message: 'View property must be readonly'});
            }
          };
        }
      },
      'view-no-optional-fields': {
        meta: {schema: []},
        create(context) {
          return {
            'TSInterfaceDeclaration[id.name=/View$/] TSPropertySignature[optional=true], TSTypeAliasDeclaration[id.name=/View$/] TSPropertySignature[optional=true]'(node) {
              context.report({node, message: 'View field must not be optional'});
            }
          };
        }
      },
      'no-framework-types-in-signatures': {
        meta: {schema: []},
        create(context) {
          const services = context.sourceCode.parserServices;
          const checker = services.program.getTypeChecker();
          return {
            MethodDefinition(node) {
              for (const param of node.value.params) {
                const tsNode = services.esTreeNodeToTSNodeMap.get(param);
                const type = checker.getTypeAtLocation(tsNode);
                for (const typeDeclaration of type.getSymbol?.()?.getDeclarations() ?? []) {
                  const file = typeDeclaration.getSourceFile().fileName;
                  if (file.includes('node_modules') && !file.includes('typescript/lib'))
                    context.report({node: param, message: 'Framework type must not cross the API boundary'});
                }
              }
            }
          };
        }
      }
    }}}, rules: {
      'fixture/view-contracts-are-owned': 'error',
      'fixture/view-contracts-are-readonly': 'error',
      'fixture/view-no-optional-fields': 'error',
      'fixture/no-framework-types-in-signatures': 'error'
    }}`,
  });
  const expressTypes = join(f.dir, "node_modules/@types/express");
  mkdirSync(expressTypes, { recursive: true });
  writeFileSync(
    join(expressTypes, "index.d.ts"),
    "export interface Request { readonly url: string }\n",
  );
  const views = join(f.dir, "src/views");
  mkdirSync(views, { recursive: true });
  const target = { ...f, file: join(views, "product-view.ts") };
  writeFileSync(target.file, source);
  writeFileSync(
    join(f.dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        module: "nodenext",
        skipLibCheck: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    }),
  );
  const actual = run(target);
  assert.equal(actual.status, 1, actual.stderr);
  const result = JSON.parse(actual.stdout)[0];
  assert.ok(
    result.messages.some(
      message => message.ruleId === "fixture/view-contracts-are-readonly",
    ),
  );
  assert.ok(
    result.messages.some(
      message => message.ruleId === "fixture/no-framework-types-in-signatures",
    ),
  );
  assert.deepEqual(result, await oracle(target));
});

test("installed ESNext library aliases preserve collection and iterator types", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
    },
    source: `export function common(left: Set<string>, right: Set<string>): string[] {
  const result = left.intersection(right);
  return [...result.values().map(value => value.toUpperCase())];
}
`,
  });
  writeFileSync(
    join(f.dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2023",
        module: "nodenext",
        skipLibCheck: true,
        lib: [
          "es2023",
          "esnext.collection",
          "esnext.iterator",
          "esnext.array",
          "esnext.disposable",
        ],
      },
      include: ["*.ts"],
    }),
  );
  const actual = run(f);
  assert.equal(actual.status, 0, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(expected.messages, []);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ESLint } from "eslint";

// Shared helpers for the host engine tests. Fixture directories are created
// under `host/` (not next to this file) so `.gitignore` keeps covering them.
const host = resolve(import.meta.dirname, "..");
const root = resolve(host, "..");
const binary =
  process.env.LINTRS_TEST_BINARY ?? join(root, "target/debug/lintrs");

export { binary, root };

export function fixture(
  t,
  {
    rules,
    source,
    extraConfig = "",
    typed = false,
    tsx = false,
    graphql = false,
  },
) {
  const dir = mkdtempSync(join(host, ".fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "eslint.config.mjs");
  const file = join(
    dir,
    graphql ? "sample.graphql" : tsx ? "sample.tsx" : "sample.ts",
  );
  const guard = join(dir, "guard.mjs");
  writeFileSync(file, source);
  // Keep fixture sources in a CommonJS context so extensionless relative
  // imports resolve under `module: nodenext`; the repository root marks the
  // package `"type": "module"`, which would otherwise apply here.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  if (typed) {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "es2022",
          module: "nodenext",
          skipLibCheck: true,
          jsx: "preserve",
        },
        include: ["*.ts", "*.tsx"],
      }),
    );
  }
  writeFileSync(
    config,
    graphql
      ? `import plugin from '@graphql-eslint/eslint-plugin';
export default [{files: ['**/*.graphql'], plugins: {'@graphql-eslint': plugin},
 languageOptions: {parser: plugin.parser, parserOptions: {schemaSdl: 'type Query { greeting: String }'}},
 linterOptions: {reportUnusedDisableDirectives: 'error'}, rules: ${JSON.stringify(rules)}}, ${extraConfig}];\n`
      : `import ts from 'typescript-eslint';
export default [{ files: ['**/*.ts', '**/*.tsx'], plugins: { '@typescript-eslint': ts.plugin },
 languageOptions: { parser: ts.parser, ecmaVersion: 2024, parserOptions: ${JSON.stringify(typed ? { projectService: true } : {})} },
 linterOptions: { reportUnusedDisableDirectives: 'error' },
 rules: ${JSON.stringify(rules)} }, ${extraConfig}];\n`,
  );
  writeFileSync(
    guard,
    `import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(import.meta.url)});
const { ESLint, Linter } = require('eslint');
ESLint.prototype.lintFiles = () => { throw new Error('ESLint engine must not execute in the host'); };
Linter.prototype.verify = () => { throw new Error('ESLint engine must not execute in the host'); };
const Module = require('node:module');
const originalLoad = Module._load;
const guarded = new WeakMap();
Module._load = function(specifier, ...args) {
 const loaded = originalLoad.call(this, specifier, ...args);
 if (specifier === 'graphql') return new Proxy(loaded, {
  get(target, key) {
   if (['parse', 'parseValue', 'parseType', 'parseConstValue', 'buildSchema', 'Lexer'].includes(key))
    return () => { throw new Error('JavaScript GraphQL parser must not execute in the host: ' + key); };
   return Reflect.get(target, key);
  }
 });
 if (specifier !== 'typescript') return loaded;
 if (!guarded.has(loaded)) guarded.set(loaded, new Proxy(loaded, {
  get(target, key) {
   if (['createProgram', 'createIncrementalProgram', 'createLanguageService', 'createCompilerHost', 'createSourceFile'].includes(key))
    return () => { throw new Error('JavaScript TypeScript compiler must not execute in the host: ' + key); };
   return Reflect.get(target, key);
  }
 }));
 return guarded.get(loaded);
};\n`,
  );
  return { dir, file, config, guard, source };
}

export function run(f, extra = [], environment = {}) {
  return spawnSync(binary, ["-c", f.config, "-f", "json", ...extra, f.file], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ...environment,
      NODE_OPTIONS: `--import=${pathToFileURL(f.guard).href}`,
    },
  });
}

export function comparable(message) {
  const { suggestions, ...rest } = message;
  return {
    ...rest,
    ...(suggestions?.length > 0 ? { suggestions } : {}),
  };
}

export async function oracle(f) {
  const eslint = new ESLint({ cwd: f.dir, overrideConfigFile: f.config });
  return (await eslint.lintFiles([f.file]))[0];
}

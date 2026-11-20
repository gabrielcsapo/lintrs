import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixture, run, oracle } from "./test-support/fixture.mjs";

test("provided programs retain ESNext array and collection libraries and their original options", async t => {
  const rules = {
    "@typescript-eslint/require-await": "error",
    "@typescript-eslint/restrict-plus-operands": "error",
    "@typescript-eslint/no-unsafe-return": "error",
  };
  const f = fixture(t, {
    typed: true,
    rules,
    source: `export async function gather(values: AsyncIterable<string>) {
  return Array.fromAsync(values);
}
export function count(left: Set<string>, right: Set<string>) {
  return left.difference(right).size + Map.groupBy([...left], value => value).size;
}
`,
  });
  const libs = ["es2023", "esnext.collection", "esnext.array"];
  writeFileSync(
    join(f.dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2023",
        module: "nodenext",
        lib: libs,
        types: [],
      },
      include: ["*.ts"],
    }),
  );
  writeFileSync(
    f.config,
    `import assert from 'node:assert/strict';
import ts from 'typescript';
import plugin from 'typescript-eslint';
const parsed = ts.getParsedCommandLineOfConfigFile(${JSON.stringify(join(f.dir, "tsconfig.json"))}, {}, {...ts.sys, onUnRecoverableConfigFileDiagnostic(d) { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\\n')); }});
const program = ts.createProgram({rootNames: parsed.fileNames, options: parsed.options});
if (process.env.LINTRS_FORBID_JS_CHECKER) program.getTypeChecker = () => {throw new Error('JavaScript checker must not run');};
export default [{files: ['**/*.ts'], languageOptions: {parser: plugin.parser, parserOptions: {programs: [program], projectService: false}}, plugins: {'@typescript-eslint': plugin.plugin, inspect: {rules: {options: {meta: {schema: []}, create(context) {assert.deepEqual([...context.sourceCode.parserServices.program.getCompilerOptions().lib], parsed.options.lib); return {};}}}}}, rules: {...${JSON.stringify(rules)}, 'inspect/options': 'error'}}];
`,
  );
  const expected = await oracle(f);
  assert.deepEqual(expected.messages, []);
  const actual = run(f, [], { LINTRS_FORBID_JS_CHECKER: "1" });
  assert.equal(actual.status, 0, actual.stderr + actual.stdout);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

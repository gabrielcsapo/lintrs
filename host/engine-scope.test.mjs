import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";

const require = createRequire(import.meta.url);

test("flat configuration resolves its original rule objects", async t => {
  const dir = mkdtempSync(join(import.meta.dirname, ".fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "eslint.config.mjs");
  writeFileSync(
    configPath,
    `import ts from 'typescript-eslint';
export default [
  { files: ['**/*.ts', '**/*.tsx'], plugins: { '@typescript-eslint': ts.plugin },
    rules: { '@typescript-eslint/no-unsafe-unary-minus': 'error',
             '@typescript-eslint/no-floating-promises': 'error' } },
  { files: ['vendor/**'],
    languageOptions: { parserOptions: { projectService: false } },
    rules: { '@typescript-eslint/no-floating-promises': 'off' } },
];
`,
  );
  const loaded = await loadConfig(configPath);
  const config = loaded.configs.getConfig(join(dir, "src/probe.tsx"));
  assert.ok(loaded.rules.size > 0);
  assert.equal(
    loaded.rules.get("@typescript-eslint/no-unsafe-unary-minus"),
    require("typescript-eslint").plugin.rules["no-unsafe-unary-minus"],
  );
  assert.equal(config.rules["@typescript-eslint/no-floating-promises"][0], 2);
  const recursiveUtility = loaded.configs.getConfig(
    join(dir, "vendor/resource-path-builder.ts"),
  );
  assert.equal(
    recursiveUtility.languageOptions.parserOptions.projectService,
    false,
  );
  assert.equal(
    recursiveUtility.rules["@typescript-eslint/no-floating-promises"][0],
    0,
  );
  const production = readFileSync(
    fileURLToPath(new URL("./engine.mjs", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(production, /new ESLint|Linter\.verify|\.lintFiles\(/u);
});

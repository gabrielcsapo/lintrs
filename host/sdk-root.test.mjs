import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { binary, root } from "./test-support/fixture.mjs";

// The dev-layout SDK fallback resolves tsrs through `cargo metadata`, which
// must run in lintrs's checkout — not in the linted project's directory.
// Linting a project outside the repo would fail if it ran with cwd=root.
test(
  "typed lint works on a project outside the lintrs checkout",
  { skip: !existsSync(binary) && "lintrs binary missing" },
  t => {
    const dir = mkdtempSync(join(tmpdir(), "lintrs-outside-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    for (const entry of [
      "eslint",
      "oxlint",
      "typescript",
      "typescript-eslint",
      "@eslint",
      "@typescript-eslint",
      "espree",
    ]) {
      const source = join(root, "node_modules", entry);
      if (existsSync(source))
        symlinkSync(source, join(dir, "node_modules", entry), "dir");
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "commonjs" }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "es2022",
          module: "nodenext",
          skipLibCheck: true,
        },
        include: ["*.ts"],
      }),
    );
    const file = join(dir, "sample.ts");
    writeFileSync(file, "Promise.resolve(1);\n");
    const config = join(dir, "eslint.config.mjs");
    writeFileSync(
      config,
      `import ts from 'typescript-eslint';
export default [{ files: ['**/*.ts'], plugins: { '@typescript-eslint': ts.plugin },
 languageOptions: { parser: ts.parser, parserOptions: { projectService: true } },
 rules: { '@typescript-eslint/no-floating-promises': 'error' } }];\n`,
    );
    const env = { ...process.env };
    // Force the dev fallback: no SDK override, no in-process binding.
    delete env.LINTRS_TSRS_SDK;
    delete env.LINTRS_IN_PROCESS_BINDING;
    delete env.LINTRS_TYPED_NATIVE;
    delete env.LINTRS_NATIVE_HOME;
    const result = spawnSync(binary, ["-c", config, "-f", "json", file], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    assert.equal(result.status, 1, result.stderr);
    const [linted] = JSON.parse(result.stdout);
    assert.deepEqual(
      linted.messages.map(message => message.ruleId),
      ["@typescript-eslint/no-floating-promises"],
    );
  },
);

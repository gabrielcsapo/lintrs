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
import { fileURLToPath } from "node:url";

// Runs native rule cases through the real lintrs pipeline: a temp project with
// a tsconfig and an eslint.config.mjs that imports the plugin module.
export class NativeRuleTester {
  /**
   * @param {object} config
   * @param {string} config.plugin module specifier of a file default-exporting
   *   the nativePlugin() result (absolute path or file: URL)
   * @param {string} [config.binary] lintrs binary; defaults to the native
   *   layout under target/lintrs-native
   * @param {object} [config.env] extra environment for the lintrs run
   */
  constructor({ plugin, binary, env, nodeModules } = {}) {
    if (plugin === undefined)
      throw new Error("NativeRuleTester needs the plugin module specifier");
    this.plugin = plugin.startsWith("file:")
      ? fileURLToPath(plugin)
      : resolve(plugin);
    this.binary =
      binary ??
      resolve(import.meta.dirname, "../../target/lintrs-native/bin/lintrs");
    this.env = env ?? {};
    this.nodeModules =
      nodeModules ?? resolve(import.meta.dirname, "../../node_modules");
  }

  run(ruleId, { valid = [], invalid = [] } = {}) {
    const pluginName = ruleId.split("/")[0];
    const run = cases =>
      cases.map((testCase, index) => {
        const normalized =
          typeof testCase === "string" ? { code: testCase } : testCase;
        const dir = mkdtempSync(join(tmpdir(), "lintrs-ruletest-"));
        try {
          if (existsSync(this.nodeModules))
            symlinkSync(this.nodeModules, join(dir, "node_modules"), "dir");
          const file = join(dir, normalized.filename ?? "case.ts");
          writeFileSync(file, normalized.code);
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
          const options = normalized.options ?? [];
          writeFileSync(
            join(dir, "eslint.config.mjs"),
            `import plugin from ${JSON.stringify(this.plugin)};
export default [{ files: ["**/*.ts"], plugins: { ${JSON.stringify(pluginName)}: plugin },
 languageOptions: { parserOptions: { projectService: true } },
 linterOptions: { reportUnusedDisableDirectives: "error" },
 rules: { ${JSON.stringify(ruleId)}: ["error", ${options.map(item => JSON.stringify(item)).join(",")}] } }];\n`,
          );
          const result = spawnSync(
            this.binary,
            ["-f", "json", normalized.filename ?? "case.ts"],
            {
              cwd: dir,
              encoding: "utf8",
              maxBuffer: 16 * 1024 * 1024,
              env: { ...process.env, ...this.env },
            },
          );
          if (result.status === 2)
            throw new Error(`lintrs failed: ${result.stderr}`);
          const parsed = JSON.parse(result.stdout || "[]");
          return { normalized, result: parsed[0] ?? { messages: [] } };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

    for (const { normalized, result } of run(valid)) {
      assert.deepEqual(
        result.messages,
        [],
        `expected no errors, got ${JSON.stringify(result.messages)} for ` +
          JSON.stringify(normalized.code),
      );
    }
    for (const { normalized, result } of run(invalid)) {
      const expected = normalized.errors;
      const messages = result.messages;
      assert.equal(
        messages.length,
        expected.length,
        `expected ${expected.length} error(s), got ` + JSON.stringify(messages),
      );
      for (const [index, want] of expected.entries()) {
        const got = messages[index];
        assert.equal(got.ruleId, ruleId);
        if (want.message !== undefined) assert.equal(got.message, want.message);
        if (want.messageId !== undefined)
          assert.equal(got.messageId, want.messageId);
        if (want.nodeType !== undefined)
          assert.equal(got.nodeType, want.nodeType);
        if (want.line !== undefined) assert.equal(got.line, want.line);
        if (want.column !== undefined) assert.equal(got.column, want.column);
        if (want.endLine !== undefined) assert.equal(got.endLine, want.endLine);
        if (want.endColumn !== undefined)
          assert.equal(got.endColumn, want.endColumn);
        if (want.suggestions !== undefined) {
          assert.deepEqual(
            (got.suggestions ?? []).map(suggestion => suggestion.desc),
            want.suggestions,
          );
        }
      }
      if (normalized.output !== undefined) {
        const text = normalized.code;
        const fixed = messages
          .filter(message => message.fix !== undefined)
          .sort((a, b) => b.fix.range[0] - a.fix.range[0])
          .reduce(
            (acc, message) =>
              acc.slice(0, message.fix.range[0]) +
              message.fix.text +
              acc.slice(message.fix.range[1]),
            text,
          );
        assert.equal(fixed, normalized.output);
      }
    }
  }
}

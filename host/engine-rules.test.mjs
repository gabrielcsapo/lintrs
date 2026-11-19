import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  fixture,
  run,
  oracle,
  comparable,
  binary,
} from "./test-support/fixture.mjs";

test("native-only enforcement rejects JS rules, including inline enables and workers", t => {
  const f = fixture(t, {
    rules: { "no-debugger": "off" },
    source: "/* eslint no-debugger: error */\ndebugger;\n",
  });
  const second = join(f.dir, "second.ts");
  writeFileSync(second, "export {};\n");
  for (const args of [[], ["--concurrency", "2", second]]) {
    const result = run(f, ["--require-native", ...args]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(
      result.stderr,
      /--require-native cannot run 1 rule\(s\):\nno-debugger/u,
    );
  }
});

test("native-only enforcement honors quiet warnings and disabled rules", t => {
  const f = fixture(t, {
    rules: { "no-debugger": "warn", "no-unused-vars": "off" },
    source: "debugger;\n",
  });
  const warning = run(f, ["--require-native"]);
  assert.equal(warning.status, 2, warning.stderr);
  const quiet = run(f, ["--require-native", "--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.deepEqual(JSON.parse(quiet.stdout), []);
});

test("unchanged rules preserve diagnostics, fixes, suggestions, selectors, scopes, and code paths", async t => {
  const f = fixture(t, {
    rules: {
      "no-debugger": "error",
      "no-async-promise-executor": "error",
      "no-unsafe-finally": "error",
      "no-unused-vars": ["warn", { args: "none" }],
      "@typescript-eslint/no-explicit-any": ["error", { fixToUnknown: true }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='selected']",
          message: "Selected identifier",
        },
      ],
    },
    source:
      'const emoji = "😀";\u2028debugger;\nnew Promise(async () => {});\nfunction cleanup() { try { return 1; } finally { return 2; } }\nlet selected: any;\n',
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const result = JSON.parse(actual.stdout)[0];
  const expected = await oracle(f);
  assert.deepEqual(
    result.messages.map(comparable),
    expected.messages.map(comparable),
  );
  assert.equal(result.errorCount, expected.errorCount);
  assert.equal(result.warningCount, expected.warningCount);
  assert.equal(result.fixableErrorCount, expected.fixableErrorCount);
});

test("Rust applies disables using original rule IDs and retains suggestions", async t => {
  const f = fixture(t, {
    rules: {
      "no-debugger": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
    source:
      "// eslint-disable-next-line no-debugger -- intentional\ndebugger;\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nlet value: any;\n// eslint-disable-next-line no-debugger\nconst clean = 1;\n",
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const result = JSON.parse(actual.stdout)[0];
  const expected = await oracle(f);
  assert.deepEqual(
    result.messages.map(comparable),
    expected.messages.map(comparable),
  );
  assert.deepEqual(
    result.suppressedMessages.map(comparable),
    expected.suppressedMessages.map(comparable),
  );
});

test("per-file options and severities come from resolved configuration", async t => {
  const f = fixture(t, {
    rules: { "@typescript-eslint/no-explicit-any": "error" },
    source: "let value: any;\n",
    extraConfig: `{ files: ['sample.ts'], rules: { '@typescript-eslint/no-explicit-any': ['warn', {fixToUnknown: true}] } }`,
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout)[0];
  const expected = await oracle(f);
  assert.deepEqual(
    actual.messages.map(comparable),
    expected.messages.map(comparable),
  );
  const quiet = run(f, ["--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.deepEqual(JSON.parse(quiet.stdout), []);
});

test("single-thread runs load a configuration factory once", t => {
  const f = fixture(t, { rules: {}, source: "debugger;\n" });
  writeFileSync(
    f.config,
    `let loads = 0; export default () => {
    if (++loads > 1) throw new Error('Configuration was loaded twice');
    return [{files: ['**/*.ts'], rules: {'no-debugger': 'error'}}];
  };\n`,
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const result = JSON.parse(actual.stdout)[0];
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].ruleId, "no-debugger");
});

test("explicit report locations preserve points, ranges, and file-level line zero", async t => {
  const f = fixture(t, {
    rules: {},
    source: "const value = 1;\n",
    extraConfig: `{plugins: {local: {rules: {locations: {meta: {schema: []}, create(context) {return {Program(node) {
      context.report({loc: {start: {line: 0, column: 0}, end: {line: 0, column: 0}}, message: 'File-level'});
      context.report({node, loc: {line: 1, column: 6}, message: 'Point'});
      context.report({node, loc: {start: {line: 1, column: 6}, end: {line: 1, column: 11}}, message: 'Range'});
    }};}}}}}, rules: {'local/locations': 'error'}}`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
});

test("suggestion data follows retained iterator fixes", async t => {
  const f = fixture(t, {
    rules: {},
    source: "const value = 1;\n",
    extraConfig: `{
      plugins: { local: { rules: { suggestions: {
        meta: { schema: [], hasSuggestions: true, messages: { report: 'Change it', change: 'Change {{value}}' } },
        create(context) { return { 'Literal[value=1]'(node) {
          context.report({ node, messageId: 'report', suggest: [
            { messageId: 'change', data: { value: 'discarded' }, fix() { return null; } },
            { messageId: 'change', data: { value: 'retained' }, *fix(fixer) { yield fixer.replaceText(node, '2'); } }
          ] });
        } }; }
      } } } }, rules: { 'local/suggestions': 'error' }
    }`,
  });
  const result = run(f);
  assert.equal(result.status, 1, result.stderr);
  const expected = await oracle(f);
  assert.deepEqual(
    JSON.parse(result.stdout)[0].messages.map(comparable),
    expected.messages.map(comparable),
  );
});

test("ignored invalid files are removed before the Rust parser runs", t => {
  const f = fixture(t, {
    rules: { "no-debugger": "error" },
    source: "const clean = 1;\n",
    extraConfig: `{ ignores: ['ignored/**', '*.mjs'] }`,
  });
  mkdirSync(join(f.dir, "ignored"));
  writeFileSync(join(f.dir, "ignored/broken.ts"), "const = ;");
  const result = spawnSync(binary, ["-c", f.config, "-f", "json", f.dir], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).length, 1);
});

test("syntax-only parser services support rules that do not query types", async t => {
  const f = fixture(t, {
    rules: { "@typescript-eslint/consistent-type-imports": "error" },
    source:
      "import { Value } from './dependency';\nexport const item: Value = { value: 'text' };\n",
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
});

test("inline configuration enables original rules and retains configured options", async t => {
  const f = fixture(t, {
    rules: { "no-unused-vars": ["warn", { varsIgnorePattern: "^ignored" }] },
    source: `/* eslint no-debugger: "error", no-unused-vars: "error" -- inline options */\ndebugger;\nconst ignoredValue = 1;\n`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
});

test("oxlint-disable comments are ignored like ESLint", async t => {
  const f = fixture(t, {
    rules: { "no-debugger": "error" },
    source: `// oxlint-disable-next-line no-debugger\ndebugger;\n`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const result = JSON.parse(actual.stdout)[0];
  assert.deepEqual(
    result.messages.map(message => [message.ruleId, message.line]),
    [["no-debugger", 2]],
  );
  assert.equal(result.suppressedMessages.length, 0);
});

// oxlint picks its own output format from the environment (an AI agent,
// GITHUB_ACTIONS, else its default), and its default and GitHub formats print
// a "Found … / Finished in …" summary even with --silent. Run as a plain
// terminal and as GitHub Actions: stdout must still be exactly lintrs' JSON.
// Agent detection is switched off with empty values, which oxlint treats as
// unset, so this does not pass vacuously when the tests run under an agent.
test("oxlint's own output never reaches stdout, whatever environment it detects", t => {
  const f = fixture(t, {
    rules: { "no-debugger": "error" },
    source: "debugger;\n",
  });
  const noAgent = Object.fromEntries(
    [
      "AI_AGENT",
      "CLAUDECODE",
      "CLAUDE_CODE",
      "REPL_ID",
      "GEMINI_CLI",
      "CODEX_SANDBOX",
      "CODEX_THREAD_ID",
      "COPILOT_CLI",
      "OPENCODE",
      "JUNIE_DATA",
      "JUNIE_SHIM_PATH",
      "CURSOR_AGENT",
    ].map(name => [name, ""]),
  );
  for (const environment of [
    { ...noAgent, GITHUB_ACTIONS: "" },
    { ...noAgent, GITHUB_ACTIONS: "true" },
  ]) {
    const actual = run(f, [], environment);
    assert.equal(actual.status, 1, actual.stderr);
    assert.doesNotMatch(actual.stdout, /Finished in|warnings and/u);
    assert.equal(
      JSON.parse(actual.stdout)[0].messages[0].ruleId,
      "no-debugger",
    );
  }
});

test("invalid syntax fails the run rather than returning a partial result", t => {
  const f = fixture(t, {
    rules: { "no-debugger": "error" },
    source: "const = ;",
  });
  const result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /incomplete/u);
});

test("a run leaves nothing in the temporary directory, whether it succeeds or fails", t => {
  const temporary = mkdtempSync(join(tmpdir(), "lintrs-tmpdir-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const clean = fixture(t, {
    rules: { "no-debugger": "error" },
    source: "const clean = 1;\n",
  });
  const broken = fixture(t, {
    rules: { "no-debugger": "error" },
    source: "const = ;",
  });
  const environment = { TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  const passed = run(clean, [], environment);
  assert.equal(passed.status, 0, passed.stderr);
  const failed = run(broken, [], environment);
  assert.equal(failed.status, 2, failed.stderr);
  assert.deepEqual(readdirSync(temporary), []);
});

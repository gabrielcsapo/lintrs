import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  fixture,
  run,
  oracle,
  comparable,
  binary,
} from "./test-support/fixture.mjs";

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

test("invalid syntax fails the run rather than returning a partial result", t => {
  const f = fixture(t, {
    rules: { "no-debugger": "error" },
    source: "const = ;",
  });
  const result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /incomplete/u);
});

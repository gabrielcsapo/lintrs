import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { ESLint } from "eslint";

import { fixture, run, oracle, binary, root } from "./test-support/fixture.mjs";

test("reusable workers preserve per-project types, options, and fixes", async t => {
  const first = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/no-unsafe-unary-minus": "error",
      "@typescript-eslint/no-explicit-any": ["error", { fixToUnknown: true }],
    },
    source:
      "export const unsafe: any = 'first';\nexport const text: string = 'text';\n-text;\n",
  });
  const second = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/no-unsafe-unary-minus": "warn",
      "@typescript-eslint/no-explicit-any": ["warn", { fixToUnknown: false }],
    },
    source:
      "export const unsafe: any = 'second';\nexport const text: string = 'other';\n-text;\n",
  });
  const fixtures = [first, second, first];
  const differentRegistry = fixture(t, {
    rules: { "no-debugger": "error" },
    source: "debugger;\n",
  });
  const tasks = fixtures.map((f, index) => ({
    configPath: f.config,
    files: [f.file],
    prefix: join(first.dir, `result-${index}`),
  }));
  tasks.push({
    configPath: differentRegistry.config,
    files: [differentRegistry.file],
    prefix: join(first.dir, "result-3"),
  });
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=@typescript/source",
      "--experimental-transform-types",
      "--expose-gc",
      join(import.meta.dirname, "worker.mjs"),
    ],
    {
      cwd: root,
      input: tasks.map(task => JSON.stringify(task)).join("\n") + "\n",
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        RLINT_BINARY: binary,
        NODE_OPTIONS: `--import=${pathToFileURL(first.guard).href}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(responses.length, 4, result.stdout);
  for (const [index, f] of fixtures.entries()) {
    assert.ok(responses[index].status < 2);
    assert.deepEqual(
      JSON.parse(readFileSync(`${tasks[index].prefix}.json`, "utf8"))[0],
      await oracle(f),
    );
  }
  assert.equal(responses[3].status, 3);
  assert.equal(responses[3].retry, true);
  assert.throws(() => readFileSync(`${tasks[3].prefix}.json`, "utf8"), {
    code: "ENOENT",
  });
});

test("missing typed services fail explicitly without an ESLint fallback", t => {
  const f = fixture(t, {
    rules: { "@typescript-eslint/no-unsafe-unary-minus": "error" },
    source: '-"text";\n',
  });
  const result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires type information/u);
  assert.equal(result.stdout, "");
});

test("a failed callback stops later files without publishing partial results", t => {
  const f = fixture(t, {
    rules: {},
    source: "export const value = 1;\n",
    extraConfig: `{plugins: {broken: {rules: {fail: {
      meta: {schema: []},
      create() {
        appendFileSync(new URL('./visits.txt', import.meta.url), 'visited\\n');
        return {Program() { throw new Error('Unsupported fixture API'); }};
      }
    }}}}, rules: {'broken/fail': 'error'}}`,
  });
  writeFileSync(
    f.config,
    `import { appendFileSync } from 'node:fs';\n${readFileSync(f.config, "utf8")}`,
  );
  const second = join(f.dir, "second.ts");
  writeFileSync(second, "export const other = 2;\n");
  const result = run(f, [second]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Unsupported fixture API/u);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(join(f.dir, "visits.txt"), "utf8"), "visited\n");
});

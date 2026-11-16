import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const binary =
  process.env.RLINT_TEST_BINARY ?? join(root, "target/release/rlint");

function fixture(t, source) {
  const directory = mkdtempSync(join(import.meta.dirname, ".workspace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "workspace-fixture" }),
  );
  writeFileSync(join(directory, "src/sample.ts"), source);
  writeFileSync(
    join(directory, "eslint.config.mjs"),
    `
    export default [
      { files: ["**/*.ts"], plugins: { fixture: { rules: {
        warning: { meta: { schema: [] }, create() { throw new Error("quiet must skip warning rule"); } }
      } } }, rules: { "no-debugger": "error", "fixture/warning": "warn" } }
    ];
  `,
  );
  return directory;
}

function lint(directory, extra = {}) {
  return spawnSync(
    process.execPath,
    [
      "--conditions=@typescript/source",
      "--experimental-transform-types",
      join(import.meta.dirname, "workspace.mjs"),
      "--quiet",
      "src/**/*.{ts,mts,tsx,graphql}",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        INIT_CWD: directory,
        ESLINT_CONFIG: join(directory, "eslint.config.mjs"),
        RLINT_BINARY: binary,
        PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`,
        ...extra,
      },
    },
  );
}

test(
  "workspace lint preserves quiet reports and exit status",
  { skip: !existsSync(binary) },
  t => {
    const directory = fixture(t, "debugger; if (1 == 2) {}");
    const native = lint(directory);
    assert.equal(native.status, 1, native.stderr);
    const nativeResults = JSON.parse(
      readFileSync(join(directory, "eslint-output.json"), "utf8"),
    );
    const timing = JSON.parse(
      readFileSync(join(directory, "lint-timing.json"), "utf8"),
    );
    assert.equal(timing.complete, true);
    assert.equal(timing.files, 1);
    assert.equal(timing.errors, 1);
    assert.equal(timing.warnings, 0);
    assert.deepEqual(
      nativeResults.map(result => [
        result.filePath,
        result.messages.map(message => message.ruleId),
      ]),
      [[join(directory, "src/sample.ts"), ["no-debugger"]]],
    );
  },
);

test(
  "workspace lint writes complete empty quiet reports and phase timings",
  { skip: !existsSync(binary) },
  t => {
    const directory = fixture(t, "const value = 1;");
    const result = lint(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "eslint-output.json"), "utf8")),
      [],
    );
    const timing = JSON.parse(
      readFileSync(join(directory, "lint-timing.json"), "utf8"),
    );
    assert.equal(timing.complete, true);
    assert.equal(timing.files, 1);
  },
);

test(
  "workspace workers preserve every input with isolated parser registrations",
  { skip: !existsSync(binary) },
  t => {
    const directory = fixture(t, "debugger;");
    for (let index = 1; index < 400; index++)
      writeFileSync(join(directory, `src/sample-${index}.ts`), "debugger;");
    const result = lint(directory, {
      RLINT_WORKERS: "2",
      RLINT_RUST_THREADS: "2",
    });
    assert.equal(result.status, 1, result.stderr);
    const results = JSON.parse(
      readFileSync(join(directory, "eslint-output.json"), "utf8"),
    );
    const timing = JSON.parse(
      readFileSync(join(directory, "lint-timing.json"), "utf8"),
    );
    assert.equal(timing.complete, true);
    assert.equal(timing.workers, 2);
    assert.equal(timing.files, 400);
    assert.equal(results.length, 400);
    assert.equal(new Set(results.map(result => result.filePath)).size, 400);
    assert.ok(results.every(result => result.errorCount === 1));
  },
);

test(
  "workspace lint retains nested rule failure details",
  { skip: !existsSync(binary) },
  t => {
    const directory = fixture(t, "const value = 1;");
    const config = join(directory, "eslint.config.mjs");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        '"fixture/warning": "warn"',
        '"fixture/warning": "error"',
      ),
    );
    const result = lint(directory);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /quiet must skip warning rule/u);
    const timing = JSON.parse(
      readFileSync(join(directory, "lint-timing.json"), "utf8"),
    );
    assert.equal(timing.complete, false);
    assert.match(timing.failure, /quiet must skip warning rule/u);
    assert.equal(existsSync(join(directory, "eslint-output.json")), false);
  },
);

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { binary } from "./test-support/fixture.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "lintrs-compile-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const temporary = join(dir, "temporary");
  mkdirSync(temporary);
  symlinkSync(
    resolve(import.meta.dirname, "../node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "a.js"), "const a = 1;");
  writeFileSync(join(dir, "b.js"), "const b = 2;");
  const trace = join(dir, "cache.jsonl");
  writeFileSync(
    join(dir, "eslint.config.mjs"),
    `
import {appendFileSync, existsSync, readdirSync} from 'node:fs';
import {getCompileCacheDir} from 'node:module';
import {threadId} from 'node:worker_threads';
import rule from './rule.mjs';
const cache = getCompileCacheDir();
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({threadId, cache: cache ?? null, entries: cache && existsSync(cache) ? readdirSync(cache).length : 0}) + '\\n');
export default [{files:['*.js'], plugins:{local:{rules:{report:rule}}}, rules:{'local/report':'error'}}];
`,
  );
  function rule(message) {
    writeFileSync(
      join(dir, "rule.mjs"),
      `export default {meta:{schema:[], messages:{found:${JSON.stringify(message)}}}, create(context){return {Program(node){context.report({node, messageId:'found'})}}}};`,
    );
  }
  rule("first");
  function lint(extra = {}, parallel = false) {
    const result = spawnSync(
      binary,
      ["-f", "json", "--concurrency", parallel ? "2" : "off", "a.js", "b.js"],
      {
        cwd: dir,
        env: {
          ...process.env,
          TMPDIR: temporary,
          NODE_COMPILE_CACHE: undefined,
          NODE_DISABLE_COMPILE_CACHE: undefined,
          NODE_V8_COVERAGE: undefined,
          LINTRS_CACHE_DIR: join(dir, "persistent-cache"),
          ...extra,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, result.stderr);
    return JSON.parse(result.stdout).flatMap(file =>
      file.messages.map(message => message.message),
    );
  }
  return {
    dir,
    rule,
    lint,
    trace: () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line)),
  };
}

test("workers share the parent's default module compilation directory", t => {
  const f = fixture(t);
  assert.deepEqual(f.lint({}, true), ["first", "first"]);
  const records = f.trace();
  const parent = records.find(record => record.threadId === 0);
  assert.equal(typeof parent?.cache, "string");
  assert.equal(records.length, 3);
  assert.ok(
    records.every(record => record.cache === parent.cache),
    JSON.stringify(records),
  );
  assert.ok(readdirSync(parent.cache).length > 0);
  assert.ok(
    records
      .filter(record => record.threadId !== 0)
      .every(record => record.entries > 0),
    JSON.stringify(records),
  );
});

test("warm compilation keeps diagnostics current when rule code changes", t => {
  const f = fixture(t);
  assert.deepEqual(f.lint(), ["first", "first"]);
  assert.deepEqual(f.lint(), ["first", "first"]);
  f.rule("other");
  assert.deepEqual(f.lint(), ["other", "other"]);
});

test("disabling compilation caching preserves worker diagnostics", t => {
  const f = fixture(t);
  assert.deepEqual(f.lint({ NODE_DISABLE_COMPILE_CACHE: "1" }, true), [
    "first",
    "first",
  ]);
  assert.ok(f.trace().every(record => record.cache === null));
});

test("an unusable compilation directory preserves diagnostics", t => {
  const f = fixture(t);
  const path = join(f.dir, "regular-file");
  writeFileSync(path, "not a directory");
  assert.deepEqual(f.lint({ NODE_COMPILE_CACHE: path }, true), [
    "first",
    "first",
  ]);
  assert.ok(f.trace().every(record => record.cache === null));
});

test("V8 coverage leaves implicit compilation caching disabled", t => {
  const f = fixture(t);
  assert.deepEqual(f.lint({ NODE_V8_COVERAGE: join(f.dir, "coverage") }), [
    "first",
    "first",
  ]);
  assert.ok(f.trace().every(record => record.cache === null));
});

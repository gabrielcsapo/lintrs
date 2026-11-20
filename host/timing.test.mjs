import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixture, run } from "./test-support/fixture.mjs";

const typedFixture = t => {
  const f = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "no-debugger": "error",
    },
    source: `import { text } from './types';
async function check() {
  debugger;
  await text;
}
export const value: any = 1;
export function unsafe() { return value; }
`,
  });
  writeFileSync(
    join(f.dir, "types.ts"),
    "export const text: string = 'hello';\n",
  );
  return f;
};

// Rows of the rule table only: from its "Rule" header to the first blank line
// (the phase and adapter tables follow).
const timingRows = stderr => {
  const lines = stderr.split("\n");
  const start = lines.findIndex(line => /^Rule\s+\|/u.test(line));
  const end = lines.indexOf("", start);
  return new Map(
    lines
      .slice(start, end === -1 ? undefined : end)
      .filter(line => /^\S.*\|\s+[\d.]+ \|/u.test(line))
      .map(line => {
        const cells = line.split("|").map(cell => cell.trim());
        return [cells[0], cells];
      }),
  );
};

test("TIMING reports per-rule time on stderr without changing results", t => {
  const f = typedFixture(t);
  const plain = run(f);
  const timed = run(f, [], { TIMING: "all" });
  assert.equal(plain.status, 1, plain.stderr);
  assert.equal(timed.status, 1, timed.stderr);
  // stdout carries the results and must be byte-identical.
  assert.equal(timed.stdout, plain.stdout);
  assert.doesNotMatch(plain.stderr, /Time \(ms\)/u);

  assert.match(
    timed.stderr,
    /^Rule\s+\| Time \(ms\) \| Relative \| Lang \| Own \(ms\) \| Adapter \(ms\) \| Checker \(ms\) \| Crossing \(ms\) \| Calls \| Node maps \(ms\)$/mu,
  );
  const rows = timingRows(timed.stderr);
  for (const rule of [
    "@typescript-eslint/await-thenable",
    "@typescript-eslint/no-unsafe-return",
    "no-debugger",
  ])
    assert.ok(rows.has(rule), `${rule} is listed:\n${timed.stderr}`);
  // Typed rules query the checker; an untyped rule never does.
  const CALLS = 8;
  assert.ok(Number(rows.get("@typescript-eslint/await-thenable")[CALLS]) > 0);
  assert.equal(rows.get("no-debugger")[CALLS], "0");
  assert.equal(rows.get("no-debugger")[3], "js");
  assert.match(timed.stderr, /^Configuration load\s+\|/mu);
  assert.match(timed.stderr, /^File configuration\s+\|/mu);
  assert.match(timed.stderr, /^Type services setup\s+\|/mu);
  // Typed rules go through the adapter; its entries are labelled.
  assert.match(timed.stderr, /^Adapter entry\s+\|/mu);
  assert.match(
    timed.stderr,
    /^(get \w+\.\S+|\w+\.\w+|wrap)\s+\|\s+[\d.]+ \|/mu,
  );
  assert.match(timed.stderr, /^Unattributed[^|]*\|/mu);
  assert.match(timed.stderr, /^Wall time: [\d.]+ ms\./mu);
});

test("TIMING=1 lists only the slowest rule, like ESLint", t => {
  const f = typedFixture(t);
  const timed = run(f, [], { TIMING: "1" });
  assert.equal(timed.status, 1, timed.stderr);
  const ruleRows = [...timingRows(timed.stderr).keys()];
  assert.equal(ruleRows.length, 1, timed.stderr);
});

test("TIMING merges --concurrency worker threads", t => {
  const f = typedFixture(t);
  const second = join(f.dir, "second.ts");
  writeFileSync(second, "debugger;\nexport {};\n");
  const timed = run(f, ["--concurrency", "2", second], { TIMING: "all" });
  assert.equal(timed.status, 1, timed.stderr);
  assert.equal(JSON.parse(timed.stdout).length, 2);
  const rows = timingRows(timed.stderr);
  assert.ok(rows.has("no-debugger"), timed.stderr);
  assert.ok(rows.has("@typescript-eslint/await-thenable"), timed.stderr);
  assert.match(timed.stderr, /^Configuration load\s+\|/mu);
  assert.match(timed.stderr, /^File configuration\s+\|/mu);
});

test("LINTRS_TYPE_PROFILE gains the per-rule timing summary", t => {
  const f = typedFixture(t);
  const path = join(f.dir, "profile.json");
  const timed = run(f, [], { LINTRS_TYPE_PROFILE: path });
  assert.equal(timed.status, 1, timed.stderr);
  assert.doesNotMatch(timed.stderr, /Time \(ms\)/u, "no table without TIMING");
  const profile = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(profile.api !== undefined, "type-service data is kept");
  const rule = profile.timing.rules.find(
    row => row.rule === "@typescript-eslint/await-thenable",
  );
  assert.ok(rule.checkerCalls > 0);
  const parts =
    rule.ownMs +
    rule.adapterMs +
    rule.checkerMs +
    (rule.crossingMs ?? 0) +
    rule.nodeMapsMs;
  assert.ok(
    Math.abs(rule.totalMs - parts) < 1e-6,
    "a rule's total is the sum of its parts",
  );
  assert.ok(rule.topCheckerMethods.length > 0);
  assert.ok(rule.topAdapterEntries.length > 0);
  assert.ok(profile.timing.adapterEntries.length > 0);
  for (const name of [
    "Host imports",
    "Configuration load",
    "File discovery",
    "Configuration scoping",
    "File configuration",
    "Inline configuration",
    "Type service initialization",
  ]) {
    const phase = profile.timing.phases.find(row => row.phase === name);
    assert.ok(phase?.totalMs > 0, `${name} is timed`);
  }
  assert.ok(profile.timing.wallMs >= profile.timing.attributedMs);
});

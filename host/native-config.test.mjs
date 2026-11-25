import assert from "node:assert/strict";
import { test } from "node:test";

import { createNativeRulePreparer } from "./native/config.mjs";

function rule(name, prepareOptions) {
  return { meta: { lintrs: { rule: name, prepareOptions } } };
}

test("files sharing a configuration reuse native option serialization", () => {
  let serializations = 0;
  const options = {
    toJSON() {
      serializations++;
      return { match: "value" };
    },
  };
  const nativeRules = new Map([
    ["demo/rename", rule("rename", value => value)],
  ]);
  const prepare = createNativeRulePreparer(nativeRules, {
    resolveLibrary: () => "/rules.so",
  });
  const config = Object.freeze({ rules: { "demo/rename": [2, options] } });
  const expected = {
    libraries: ["/rules.so"],
    specs: [
      {
        id: "demo/rename",
        name: "rename",
        library: "/rules.so",
        severity: 2,
        options,
      },
    ],
  };
  assert.deepEqual(prepare(config), expected);
  assert.deepEqual(prepare(config), expected);
  assert.equal(serializations, 1);
});

test("per-file overrides retain their own options, severity and disabled rules", () => {
  const prepare = createNativeRulePreparer(
    new Map([
      ["demo/rename", rule("rename", value => ({ ...value, ready: true }))],
    ]),
    { resolveLibrary: () => "/rules.so" },
  );
  const base = Object.freeze({
    rules: { "demo/rename": [2, { match: "first" }] },
  });
  const inline = Object.freeze({
    ...base,
    rules: { ...base.rules, "demo/rename": [1, { match: "second" }] },
  });
  const disabled = Object.freeze({ ...base, rules: { "demo/rename": [0] } });
  const [first] = prepare(base).specs;
  const [second] = prepare(inline).specs;
  assert.equal(first.severity, 2);
  assert.deepEqual(first.options, { match: "first", ready: true });
  assert.equal(second.severity, 1);
  assert.deepEqual(second.options, { match: "second", ready: true });
  assert.deepEqual(prepare(disabled), { specs: [], libraries: [] });
  assert.deepEqual(prepare(base).specs, [first]);
});

test("quiet mode excludes warnings and unrelated JavaScript rules", () => {
  const calls = [];
  const prepare = createNativeRulePreparer(
    new Map([
      ["demo/error", rule("error")],
      ["demo/warning", rule("warning")],
      ["demo/off", rule("off")],
    ]),
    {
      quiet: true,
      resolveLibrary(meta) {
        calls.push(meta.rule);
        return "/rules.so";
      },
    },
  );
  const result = prepare({
    rules: {
      "demo/error": [2],
      "demo/warning": [1],
      "demo/off": [0],
      "javascript/rule": [2],
    },
  });
  assert.deepEqual(calls, ["error"]);
  assert.deepEqual(
    result.specs.map(spec => spec.id),
    ["demo/error"],
  );
  assert.deepEqual(result.specs[0].options, []);
});

test("distinct configurations share equivalent prepared options and deduplicate libraries", () => {
  let preparations = 0;
  const prepare = createNativeRulePreparer(
    new Map([
      [
        "demo/first",
        rule("first", options => {
          preparations++;
          return { options };
        }),
      ],
      ["demo/second", rule("second")],
    ]),
    { resolveLibrary: () => "/rules.so" },
  );
  const config = severity => ({
    rules: { "demo/first": [severity, "one", "two"], "demo/second": [2] },
  });
  const first = prepare(config(2));
  const second = prepare(config(1));
  assert.equal(preparations, 1);
  assert.deepEqual(first.specs[0].options, { options: ["one", "two"] });
  assert.equal(second.specs[0].severity, 1);
  assert.deepEqual(first.libraries, ["/rules.so"]);
});

test("later invocations resolve current libraries and failed preparation can retry", () => {
  const nativeRules = new Map([["demo/rename", rule("rename")]]);
  const config = { rules: { "demo/rename": [2] } };
  let library = "/before.so";
  const resolveLibrary = () => library;
  const first = createNativeRulePreparer(nativeRules, { resolveLibrary });
  assert.deepEqual(first(config).libraries, ["/before.so"]);
  library = "/after.so";
  const second = createNativeRulePreparer(nativeRules, { resolveLibrary });
  assert.deepEqual(second(config).libraries, ["/after.so"]);

  let attempts = 0;
  const retry = createNativeRulePreparer(nativeRules, {
    resolveLibrary() {
      if (++attempts === 1) throw new Error("missing library");
      return library;
    },
  });
  assert.throws(() => retry(config), /missing library/u);
  assert.deepEqual(retry(config).libraries, ["/after.so"]);
  assert.equal(attempts, 2);
});

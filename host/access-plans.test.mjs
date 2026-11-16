import assert from "node:assert/strict";
import { test } from "node:test";

import { createAccessPlans } from "./access-plans.mjs";

test("access plans learn fields after a file and isolate rule and node kind", () => {
  const plans = createAccessPlans();
  const query = "getSymbolAtLocation";
  plans.withRule("declarations", () => {
    for (let index = 0; index < 10; index++) {
      const object = {};
      plans.observe(object, query, 1);
      plans.observe(object, query, 1);
      plans.read(object, "declarations");
      plans.read(object, "declarations");
      if (index === 0) plans.read(object, "name");
      plans.read(object, "__hydrate");
    }
    assert.deepEqual(plans.fields(query, 1), []);
  });
  plans.finishFile();
  plans.withRule("declarations", () => {
    assert.deepEqual(plans.fields(query, 1), ["declarations"]);
    assert.deepEqual(plans.fields(query, 2), []);
    assert.deepEqual(plans.fields("getTypeAtLocation", 1), []);
  });
  plans.withRule("flagsOnly", () => {
    assert.deepEqual(plans.fields(query, 1), []);
  });
  assert.throws(() =>
    plans.withRule("declarations", () => {
      throw new Error("rule failure");
    }),
  );
  assert.deepEqual(plans.fields(query, 1), []);
});

test("a shared object records each rule and completed files retain no value observations", () => {
  const plans = createAccessPlans();
  const shared = Array.from({ length: 8 }, () => ({}));
  for (const [rule, field] of [
    ["names", "name"],
    ["declarations", "declarations"],
  ])
    plans.withRule(rule, () => {
      for (const object of shared) {
        plans.observe(object, "getSymbolAtLocation", 1);
        plans.read(object, field);
      }
    });
  plans.finishFile();
  plans.withRule("names", () => {
    for (const object of shared) plans.read(object, "valueDeclaration");
  });
  plans.finishFile();
  plans.withRule("names", () =>
    assert.deepEqual(plans.fields("getSymbolAtLocation", 1), ["name"]),
  );
  plans.withRule("declarations", () =>
    assert.deepEqual(plans.fields("getSymbolAtLocation", 1), ["declarations"]),
  );
});

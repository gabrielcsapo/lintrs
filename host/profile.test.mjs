import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProfiler,
  formatTiming,
  merge,
  summarize,
  timingLimit,
} from "./profile.mjs";

// A clock the tests advance by hand: `spend(ms)` is "work" inside a frame.
function clock() {
  let time = 0;
  return { now: () => time, spend: ms => (time += ms) };
}

test("TIMING follows ESLint's list sizes", () => {
  assert.equal(timingLimit(undefined), undefined);
  assert.equal(timingLimit(""), undefined);
  assert.equal(timingLimit("1"), 1);
  assert.equal(timingLimit("25"), 25);
  assert.equal(timingLimit("all"), Infinity);
  assert.equal(timingLimit("ALL"), Infinity);
  assert.equal(timingLimit("yes"), 10);
  assert.equal(timingLimit("0"), 10);
});

test("a rule's time splits into its own JS, checker, and node-map time", () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  profile.rule("a/typed", () => {
    spend(2);
    profile.charge("checker", "getTypeAtLocation", () => spend(5));
    profile.charge("nodeMaps", "get", () => {
      spend(1);
      // A lookup that needs the checker bills the checker, not node maps.
      profile.charge("checker", "getSourceFile", () => spend(3));
    });
    spend(1);
  });
  const [row] = summarize(profile.snapshot()).rules;
  assert.deepEqual(
    {
      rule: row.rule,
      totalMs: row.totalMs,
      ownMs: row.ownMs,
      checkerMs: row.checkerMs,
      checkerCalls: row.checkerCalls,
      nodeMapsMs: row.nodeMapsMs,
      nodeMapsCalls: row.nodeMapsCalls,
    },
    {
      rule: "a/typed",
      totalMs: 12,
      ownMs: 3,
      checkerMs: 8,
      checkerCalls: 2,
      nodeMapsMs: 1,
      nodeMapsCalls: 1,
    },
  );
  assert.deepEqual(
    row.topCheckerMethods.map(method => method.method),
    ["getTypeAtLocation", "getSourceFile"],
  );
});

test("a checker call made by another checker call is one call", () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  profile.rule("a/rule", () =>
    profile.charge("checker", "apiRequest", () =>
      profile.charge("checker", "request", () => spend(4)),
    ),
  );
  const [row] = summarize(profile.snapshot()).rules;
  assert.equal(row.checkerMs, 4);
  assert.equal(row.checkerCalls, 1);
  assert.deepEqual(row.topCheckerMethods, [
    { method: "apiRequest", calls: 1, ms: 4 },
  ]);
});

test("a phase triggered inside a rule is not charged to the rule", () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  profile.rule("a/first", () => {
    spend(1);
    profile.phase("Type services setup", () => {
      spend(10);
      profile.charge("checker", "getSourceFile", () => spend(4));
    });
  });
  const summary = summarize(profile.snapshot());
  assert.equal(summary.rules[0].totalMs, 1);
  assert.equal(summary.rules[0].checkerCalls, 0);
  assert.deepEqual(
    summary.phases.map(({ phase, totalMs, checkerMs }) => ({
      phase,
      totalMs,
      checkerMs,
    })),
    [{ phase: "Type services setup", totalMs: 14, checkerMs: 4 }],
  );
});

test("checker calls outside any rule or phase are still accounted", () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  profile.charge("checker", "release", () => spend(2));
  assert.deepEqual(
    summarize(profile.snapshot()).phases.map(row => [row.phase, row.totalMs]),
    [["Outside rules", 2]],
  );
});

test("async phases account across awaits and exclude nested work", async () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  const result = await profile.phaseAsync("Configuration load", async () => {
    spend(3);
    await Promise.resolve();
    profile.phase("Configuration validation", () => spend(5));
    profile.charge("checker", "initialize", () => spend(2));
    spend(4);
    return 42;
  });
  profile.rule("a/rule", () => spend(6));
  assert.equal(result, 42);
  const summary = summarize(profile.snapshot());
  assert.deepEqual(
    summary.phases.map(({ phase, ownMs, checkerMs, totalMs }) => ({
      phase,
      ownMs,
      checkerMs,
      totalMs,
    })),
    [
      { phase: "Configuration load", ownMs: 7, checkerMs: 2, totalMs: 9 },
      { phase: "Configuration validation", ownMs: 5, checkerMs: 0, totalMs: 5 },
    ],
  );
  assert.equal(summary.rules[0].totalMs, 6);
  assert.equal(summary.attributedMs, 20);
});

test("a rejected async phase restores accounting for later work", async () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  const error = new Error("configuration failed");
  await assert.rejects(
    profile.phaseAsync("Configuration load", async () => {
      await Promise.resolve();
      spend(3);
      throw error;
    }),
    failure => failure === error,
  );
  profile.rule("a/rule", () => spend(4));
  const summary = summarize(profile.snapshot());
  assert.equal(summary.phases[0].totalMs, 3);
  assert.equal(summary.rules[0].totalMs, 4);
  assert.equal(summary.attributedMs, 7);
});

test("worker snapshots merge by summing time and taking the longest wall", () => {
  const worker = () => {
    const { now, spend } = clock();
    const profile = createProfiler({ now });
    profile.rule("a/rule", () => {
      spend(3);
      profile.charge("checker", "getTypeAtLocation", () => spend(2));
    });
    return profile;
  };
  const main = createProfiler();
  main.addWall(20);
  const merged = summarize(
    merge([main.snapshot(), worker().snapshot(), worker().snapshot()]),
  );
  assert.equal(merged.wallMs, 20);
  assert.equal(merged.rules[0].totalMs, 10);
  assert.equal(merged.rules[0].checkerCalls, 2);
  assert.deepEqual(merged.rules[0].topCheckerMethods, [
    { method: "getTypeAtLocation", calls: 2, ms: 4 },
  ]);
});

test("the table keeps ESLint's TIMING columns and reports unattributed time", () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  for (const [id, ms] of [
    ["a/slow", 6],
    ["a/fast", 1],
    ["a/medium", 3],
  ])
    profile.rule(id, () => spend(ms));
  profile.addWall(20);
  const lines = formatTiming(profile.snapshot(), 2).split("\n");
  assert.match(
    lines[0],
    /^Rule\s+\| Time \(ms\) \| Relative \| Lang \| Own \(ms\) \| Adapter \(ms\) \| Checker \(ms\) \| Crossing \(ms\) \| Calls \| Node maps \(ms\)$/u,
  );
  assert.match(lines[1], /^:-+\|-+:\|-+:\|/u);
  // Slowest first, limited to two; Relative is against all rules.
  assert.match(lines[2], /^a\/slow\s+\|\s+6\.000 \|\s+60\.0% \|/u);
  assert.match(lines[3], /^a\/medium\s+\|\s+3\.000 \|\s+30\.0% \|/u);
  assert.equal(lines[4], "");
  const text = lines.join("\n");
  assert.match(text, /Rules \(all\)\s+\|\s+10\.000 \|\s+50\.0%/u);
  // Without a compute clock the checker is not split: Crossing shows "-".
  assert.match(
    lines[2],
    /\| js\s+\|\s+6\.000 \|\s+0\.000 \|\s+0\.000 \|\s+- \|/u,
  );
  assert.match(text, /no compute clock/u);
  assert.match(text, /Unattributed[^|]*\|\s+10\.000 \|\s+50\.0%/u);
  assert.match(text, /Wall time: 20\.000 ms/u);
});

test("the compute clock splits checker time into Rust work and the crossing", () => {
  const { now, spend } = clock();
  let rust = 0;
  const profile = createProfiler({ now });
  profile.setComputeClock(() => rust);
  profile.rule("a/typed", () => {
    spend(1);
    profile.charge("checker", "getTypeAtLocation", () => {
      spend(10);
      rust += 7; // Rust reports 7 of the 10 ms as its own work
    });
  });
  const [row] = summarize(profile.snapshot()).rules;
  assert.equal(row.totalMs, 11);
  assert.equal(row.ownMs, 1);
  assert.equal(row.checkerMs, 7);
  assert.equal(row.crossingMs, 3);
  assert.ok(
    formatTiming(profile.snapshot()).includes("Checker is Rust compute"),
  );
});

test("Rust compute is capped at the call's observed time", () => {
  const { now, spend } = clock();
  let rust = 0;
  const profile = createProfiler({ now });
  profile.setComputeClock(() => rust);
  profile.rule("a/rule", () =>
    profile.charge("checker", "getTypeAtLocation", () => {
      spend(2);
      rust += 2.5; // timer granularity: Rust saw slightly more than JS
    }),
  );
  const [row] = summarize(profile.snapshot()).rules;
  assert.equal(row.checkerMs, 2);
  assert.equal(row.crossingMs, 0);
});

test("native rules are listed as Rust rows and carved out of their phase", () => {
  const { now, spend } = clock();
  let rust = 0;
  const profile = createProfiler({ now });
  profile.setComputeClock(() => rust);
  profile.rule("a/js", () => spend(2));
  profile.phase("Native rules (Rust)", () =>
    profile.charge("checker", "lintrsRunNativeRules", () => {
      spend(10);
      rust += 9;
    }),
  );
  profile.addNative({ "example/native": { ms: 6, calls: 40 } });
  profile.addWall(20);
  const summary = summarize(profile.snapshot());
  assert.deepEqual(
    summary.rules.map(({ rule, language, totalMs }) => [
      rule,
      language,
      totalMs,
    ]),
    [
      ["example/native", "rust", 6],
      ["a/js", "js", 2],
    ],
  );
  assert.equal(summary.rules[0].ruleCalls, 40);
  // The phase keeps only dispatch (3 ms of compute) and the crossing (1 ms).
  assert.deepEqual(
    summary.phases.map(({ phase, totalMs, checkerMs, crossingMs }) => [
      phase,
      totalMs,
      checkerMs,
      crossingMs,
    ]),
    [["Native rules (Rust): dispatch", 4, 3, 1]],
  );
  assert.equal(summary.attributedMs, 12);
  const text = formatTiming(profile.snapshot(), Infinity);
  assert.match(text, /^example\/native\s+\|\s+6\.000 \|\s+75\.0% \| rust/mu);
});

test("merge keeps native times and the compute flag", () => {
  const worker = () => {
    const profile = createProfiler();
    profile.setComputeClock(() => 0);
    profile.addNative({ "example/native": { ms: 2, calls: 3 } });
    return profile.snapshot();
  };
  const merged = merge([createProfiler().snapshot(), worker(), worker()]);
  assert.equal(merged.computeKnown, true);
  assert.deepEqual(merged.native, { "example/native": { ms: 4, calls: 6 } });
});

test("checker methods split into compute, Node-API conversion and JS side", () => {
  const { now, spend } = clock();
  let rust = 0;
  let callback = 0;
  const profile = createProfiler({ now });
  profile.setComputeClock(
    () => rust,
    () => callback,
  );
  profile.rule("a/typed", () =>
    profile.charge("checker", "getSymbolsAtLocations", () => {
      spend(10);
      rust += 3; // checker work
      callback += 7; // whole native callback: 3 compute + 4 conversion
    }),
  );
  const summary = summarize(profile.snapshot());
  assert.deepEqual(summary.checkerMethods, [
    {
      method: "getSymbolsAtLocations",
      calls: 1,
      ms: 10,
      computeMs: 3,
      crossingMs: 7,
      conversionMs: 4,
      jsSideMs: 3,
    },
  ]);
  assert.deepEqual(summary.rules[0].topCheckerMethods, summary.checkerMethods);
});

test("adapter work is its own bucket, and rule callbacks bill the rule", () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  profile.rule("a/typed", () => {
    spend(1); // the rule's own code
    profile.charge("adapter", "getTypeOfSymbol", () => {
      spend(4); // unwrapping, memo lookups, wrapping
      profile.charge("checker", "getTypeOfSymbol", () => spend(5));
      profile.charge("adapter", "wrap", () => spend(2)); // nested: time only
      // A checker method calling back into the rule's code.
      profile.resume(() => spend(3));
    });
  });
  const [row] = summarize(profile.snapshot()).rules;
  assert.deepEqual(
    {
      totalMs: row.totalMs,
      ownMs: row.ownMs,
      adapterMs: row.adapterMs,
      adapterCalls: row.adapterCalls,
      checkerMs: row.checkerMs,
    },
    { totalMs: 15, ownMs: 4, adapterMs: 6, adapterCalls: 1, checkerMs: 5 },
  );
});

test("resume outside a rule just runs the callback", () => {
  const profile = createProfiler();
  assert.equal(
    profile.resume(() => 42),
    42,
  );
  assert.deepEqual(summarize(profile.snapshot()).rules, []);
});

test("adapter time breaks down by entry, nested work included", () => {
  const { now, spend } = clock();
  const profile = createProfiler({ now });
  profile.rule("a/typed", () => {
    profile.charge("adapter", "get type.flags", () => spend(1));
    profile.charge("adapter", "get type.flags", () => spend(1));
    profile.charge("adapter", "checker.getTypeAtLocation", () => {
      spend(2);
      // Wrapping the result is part of this entry, not a separate one.
      profile.charge("adapter", "wrap", () => spend(3));
      // The checker request is not adapter time at all.
      profile.charge("checker", "getTypeAtLocation", () => spend(10));
    });
  });
  profile.addWall(30);
  const summary = summarize(profile.snapshot());
  assert.deepEqual(summary.adapterEntries, [
    { entry: "checker.getTypeAtLocation", calls: 1, ms: 5, averageUs: 5000 },
    { entry: "get type.flags", calls: 2, ms: 2, averageUs: 1000 },
  ]);
  assert.deepEqual(summary.rules[0].topAdapterEntries, summary.adapterEntries);
  const text = formatTiming(profile.snapshot(), 10);
  assert.match(
    text,
    /^Adapter entry\s+\| Time \(ms\) \| Of adapter \| Calls \| Avg \(µs\)$/mu,
  );
  assert.match(
    text,
    /^checker\.getTypeAtLocation\s+\|\s+5\.000 \|\s+71\.4% \|\s+1 \|\s+5000\.00$/mu,
  );
});

test("no adapter table when there was no adapter work", () => {
  const profile = createProfiler();
  profile.rule("a/plain", () => {});
  assert.doesNotMatch(formatTiming(profile.snapshot()), /Adapter entry/u);
});

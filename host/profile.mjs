// Rule profiling behind ESLint's TIMING variable (and LINTRS_TYPE_PROFILE).
//
// Time is accounted exclusively on a stack of frames:
//   - "rule" frames wrap a JS rule's create() and each listener call;
//   - "phase" frames wrap engine work that is not a rule's own logic (project
//     build, per-file type-services setup, native rule runs);
//   - "charge" frames (checker requests, node-map lookups, adapter work) bill
//     their time to the nearest enclosing rule or phase, under a named bucket.
//     "adapter" is lintrs' TypeScript-compatibility layer: proxy property
//     reads on types/symbols/nodes, wrapping SDK objects, and the bound
//     checker methods (argument unwrapping, memo lookups, result wrapping).
// A frame's own time excludes everything nested in it, so rows add up and a
// phase triggered lazily inside a rule (type-services setup in the first
// rule's create()) is not charged to that rule.
//
// Two numbers come from Rust rather than from JS timers:
//   - the compute clock: the in-process session adds the time it spends on
//     each request to a Float64Array the host registered (profileClock), so a
//     checker call splits into Rust compute and the JS/Rust crossing without
//     any extra call across the boundary;
//   - native (Rust) rules, which Rust times per rule (nativeRuleTiming).
//
// One profiler per thread; worker threads send snapshot() to the main thread,
// which merges them with merge().

/** ESLint's TIMING list size: "all" lists every rule; a positive integer
 * lists that many; anything else non-empty lists ten. */
export function timingLimit(value = process.env.TIMING) {
  if (value === undefined || value === "") return undefined;
  if (value.toLowerCase() === "all") return Infinity;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 10;
}

const FIELDS = [
  "selfMs",
  "checkerMs",
  "computeMs",
  "checkerCalls",
  "nodeMapsMs",
  "nodeMapsCalls",
  "adapterMs",
  "adapterCalls",
];

const BUCKET_FIELDS = {
  checker: { ms: "checkerMs", calls: "checkerCalls" },
  nodeMaps: { ms: "nodeMapsMs", calls: "nodeMapsCalls" },
  adapter: { ms: "adapterMs", calls: "adapterCalls" },
};

const emptyMethod = () => ({ calls: 0, ms: 0, computeMs: 0, nativeMs: 0 });

function emptyEntry() {
  return {
    ...Object.fromEntries(FIELDS.map(field => [field, 0])),
    methods: {},
    // Adapter time by entry ("get type.flags", "checker.getTypeAtLocation",
    // "wrap"): each entry's adapter work, nested adapter work included.
    adapterEntries: {},
  };
}

/** Exported for tests, which inject a deterministic clock. */
export function createProfiler({ now = () => performance.now() } = {}) {
  const entries = { rule: new Map(), phase: new Map() };
  const native = new Map();
  const stack = [];
  let wallMs = 0;
  let compute;
  let callbackClock;

  const entryFor = (kind, key) => {
    let entry = entries[kind].get(key);
    if (entry === undefined) {
      entry = emptyEntry();
      entries[kind].set(key, entry);
    }
    return entry;
  };

  // The hot path: every listener call and every adapter entry goes through
  // enter/exit, millions of times per run. Keep it allocation-light:
  // precomputed field names, the owner's entry cached on its frame, and a
  // plain loop to find the owner.
  const enter = frame => {
    frame.start = now();
    frame.child = 0;
    if (compute !== undefined && frame.bucket === "checker") {
      frame.computeStart = compute();
      frame.nativeStart = callbackClock?.();
    }
    stack.push(frame);
    return frame;
  };

  const exit = frame => {
    stack.pop();
    const elapsed = now() - frame.start;
    const self = elapsed - frame.child;
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.child += elapsed;
    if (frame.kind !== "charge") {
      (frame.entry ?? entryFor(frame.kind, frame.key)).selfMs += self;
      return;
    }
    // Bill the nearest rule or phase; with neither (top level), the bucket's
    // time lands in an "outside rules" phase.
    let owner;
    for (let index = stack.length - 1; index >= 0; index--)
      if (stack[index].kind !== "charge") {
        owner = stack[index];
        break;
      }
    const entry =
      owner === undefined
        ? entryFor("phase", "Outside rules")
        : (owner.entry ??= entryFor(owner.kind, owner.key));
    const fields = BUCKET_FIELDS[frame.bucket];
    entry[fields.ms] += self;
    entry[fields.calls]++;
    if (frame.bucket === "adapter") {
      const item = (entry.adapterEntries[frame.label] ??= { calls: 0, ms: 0 });
      item.calls++;
      item.ms += self;
      return;
    }
    if (frame.bucket !== "checker") return;
    const timesCompute = compute !== undefined;
    // Rust's own time for this call, capped at what JS observed so the
    // crossing (the rest) is never negative from timer granularity.
    const computed = timesCompute
      ? Math.min(elapsed, compute() - frame.computeStart)
      : 0;
    // Whole native callback time (conversions included), between the compute
    // time and what JS observed.
    const nativeMs =
      timesCompute && callbackClock !== undefined
        ? Math.min(
            elapsed,
            Math.max(computed, callbackClock() - frame.nativeStart),
          )
        : undefined;
    entry.computeMs += computed;
    const method = (entry.methods[frame.label] ??= emptyMethod());
    method.calls++;
    method.ms += elapsed;
    method.computeMs += computed;
    if (nativeMs !== undefined) method.nativeMs += nativeMs;
  };

  const run = (frame, fn) => {
    enter(frame);
    try {
      return fn();
    } finally {
      exit(frame);
    }
  };

  return {
    /** Runs fn as JS rule `id`'s own work. */
    rule: (id, fn) => run({ kind: "rule", key: id }, fn),
    /** Runs fn as the enclosing rule's own work again: rule callbacks the
     * adapter invokes (a checker method taking a function) are the rule's
     * code, not adapter work. Outside any rule, just runs fn. */
    resume(fn) {
      let owner;
      for (let index = stack.length - 1; index >= 0; index--)
        if (stack[index].kind === "rule") {
          owner = stack[index];
          break;
        }
      return owner === undefined
        ? fn()
        : run({ kind: "rule", key: owner.key }, fn);
    },
    /** Runs fn as engine phase `name`. */
    phase: (name, fn) => run({ kind: "phase", key: name }, fn),
    /** Runs sequential asynchronous engine work as phase `name`. */
    async phaseAsync(name, fn) {
      const frame = enter({ kind: "phase", key: name });
      try {
        return await fn();
      } finally {
        exit(frame);
      }
    },
    /** Bills fn to the enclosing rule or phase under `bucket`. */
    charge(bucket, label, fn) {
      // Inside a charge of the same bucket (adapter code calling adapter
      // code, an SDK call implemented with another), a frame would bill the
      // same bucket and owner anyway: run fn directly, as one call.
      const outer = stack[stack.length - 1];
      if (outer !== undefined && outer.bucket === bucket) return fn();
      return run({ kind: "charge", bucket, label }, fn);
    },
    /** Whether the innermost frame is already a `bucket` charge. Hot call
     * sites check this first and skip building a closure for charge(). */
    active(bucket) {
      const outer = stack[stack.length - 1];
      return outer !== undefined && outer.bucket === bucket;
    },
    /** charge() without a closure, for the hottest call sites: returns a
     * frame to pass to exit(), or undefined when already inside a `bucket`
     * charge (then there is nothing to exit). */
    enter(bucket, label) {
      const outer = stack[stack.length - 1];
      if (outer !== undefined && outer.bucket === bucket) return undefined;
      return enter({ kind: "charge", bucket, label });
    },
    exit(frame) {
      if (frame !== undefined) exit(frame);
    },
    /** Registers Rust's cumulative compute time (ms) and, optionally, its
     * cumulative whole native-callback time, read around each checker call.
     * Without them, checker time is not split. */
    setComputeClock(clock, nativeClock) {
      compute = clock;
      callbackClock = nativeClock;
    },
    /** Adds Rust-timed native rules: { ruleId: { ms, calls } }. */
    addNative(times) {
      for (const [id, { ms, calls }] of Object.entries(times)) {
        const entry = native.get(id) ?? { ms: 0, calls: 0 };
        entry.ms += ms;
        entry.calls += calls;
        native.set(id, entry);
      }
    },
    addWall(ms) {
      wallMs += ms;
    },
    snapshot() {
      return {
        wallMs,
        computeKnown: compute !== undefined,
        rule: Object.fromEntries(entries.rule),
        phase: Object.fromEntries(entries.phase),
        native: Object.fromEntries(native),
      };
    },
  };
}

let current;

/** The thread's profiler, or undefined when profiling is off. */
export function profiler() {
  if (
    current === undefined &&
    (timingLimit() !== undefined ||
      (process.env.LINTRS_TYPE_PROFILE ?? "") !== "")
  )
    current = createProfiler();
  return current;
}

/** Merges thread snapshots. Wall time is the longest thread's, since threads
 * overlap; rule and phase times are summed (CPU-style), as ESLint does for
 * its --concurrency workers. */
export function merge(snapshots) {
  const merged = {
    wallMs: 0,
    computeKnown: false,
    rule: {},
    phase: {},
    native: {},
  };
  for (const snapshot of snapshots) {
    if (snapshot === undefined) continue;
    merged.wallMs = Math.max(merged.wallMs, snapshot.wallMs);
    merged.computeKnown ||= snapshot.computeKnown;
    for (const kind of ["rule", "phase"])
      for (const [key, entry] of Object.entries(snapshot[kind])) {
        const target = (merged[kind][key] ??= emptyEntry());
        for (const field of FIELDS) target[field] += entry[field];
        for (const [method, stats] of Object.entries(entry.methods)) {
          const into = (target.methods[method] ??= emptyMethod());
          for (const field of Object.keys(into))
            into[field] += stats[field] ?? 0;
        }
        for (const [label, stats] of Object.entries(
          entry.adapterEntries ?? {},
        )) {
          const into = (target.adapterEntries[label] ??= { calls: 0, ms: 0 });
          into.calls += stats.calls;
          into.ms += stats.ms;
        }
      }
    for (const [id, { ms, calls }] of Object.entries(snapshot.native ?? {})) {
      const into = (merged.native[id] ??= { ms: 0, calls: 0 });
      into.ms += ms;
      into.calls += calls;
    }
  }
  return merged;
}

const NATIVE_PHASE = "Native rules (Rust)";

/** A checker method's calls and time; with the compute clock, the time
 * splits into Rust compute, Node-API conversion of arguments and results
 * (in Rust) and the JS side (the call itself, JSON work, SDK wrapping). */
function methodRow(method, stats, known) {
  if (!known) return { method, calls: stats.calls, ms: stats.ms };
  const conversion =
    stats.nativeMs > 0 ? Math.max(0, stats.nativeMs - stats.computeMs) : null;
  return {
    method,
    calls: stats.calls,
    ms: stats.ms,
    computeMs: stats.computeMs,
    crossingMs: stats.ms - stats.computeMs,
    conversionMs: conversion,
    jsSideMs: conversion === null ? null : stats.ms - stats.nativeMs,
  };
}

/** Rows for output. Each row's totalMs = ownMs + adapterMs + checkerMs + crossingMs +
 * nodeMapsMs. checkerMs is Rust compute when the compute clock is known
 * (crossingMs is then the JS/Rust boundary); otherwise it is the whole
 * checker call and crossingMs is null. Native rules have no checker or
 * crossing: they call the checker directly, inside their own time. */
export function summarize(snapshot) {
  const known = snapshot.computeKnown;
  const row = (name, entry) => {
    const crossing = known ? entry.checkerMs - entry.computeMs : null;
    return {
      ownMs: entry.selfMs,
      adapterMs: entry.adapterMs,
      adapterCalls: entry.adapterCalls,
      checkerMs: known ? entry.computeMs : entry.checkerMs,
      crossingMs: crossing,
      checkerCalls: entry.checkerCalls,
      nodeMapsMs: entry.nodeMapsMs,
      nodeMapsCalls: entry.nodeMapsCalls,
      totalMs:
        entry.selfMs + entry.adapterMs + entry.checkerMs + entry.nodeMapsMs,
      topCheckerMethods: Object.entries(entry.methods)
        .sort(([, a], [, b]) => b.ms - a.ms)
        .slice(0, 5)
        .map(([method, stats]) => methodRow(method, stats, known)),
      topAdapterEntries: adapterRows(entry.adapterEntries).slice(0, 5),
    };
  };
  const nativeRows = Object.entries(snapshot.native ?? {}).map(
    ([id, { ms, calls }]) => ({
      rule: id,
      language: "rust",
      ownMs: ms,
      adapterMs: 0,
      adapterCalls: 0,
      checkerMs: 0,
      crossingMs: known ? 0 : null,
      checkerCalls: 0,
      nodeMapsMs: 0,
      nodeMapsCalls: 0,
      totalMs: ms,
      ruleCalls: calls,
      topCheckerMethods: [],
    }),
  );
  const rules = [
    ...Object.entries(snapshot.rule).map(([id, entry]) => ({
      rule: id,
      language: "js",
      ...row(id, entry),
    })),
    ...nativeRows,
  ].sort((a, b) => b.totalMs - a.totalMs);
  // Native rules run inside the native phase's checker request; carve their
  // time out of it so the phase shows only dispatch, setup and the crossing.
  const nativeMs = nativeRows.reduce((sum, item) => sum + item.totalMs, 0);
  const phases = Object.entries(snapshot.phase)
    .map(([name, entry]) => {
      const item = { phase: name, ...row(name, entry) };
      if (name !== NATIVE_PHASE || nativeMs === 0) return item;
      const carved = Math.min(nativeMs, item.checkerMs);
      return {
        ...item,
        phase: `${NATIVE_PHASE}: dispatch`,
        checkerMs: item.checkerMs - carved,
        totalMs: item.totalMs - carved,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
  const attributed = [...rules, ...phases].reduce(
    (sum, item) => sum + item.totalMs,
    0,
  );
  // Every checker method across the run, costliest crossing first.
  const methods = {};
  for (const kind of ["rule", "phase"])
    for (const entry of Object.values(snapshot[kind]))
      for (const [method, stats] of Object.entries(entry.methods)) {
        const into = (methods[method] ??= emptyMethod());
        for (const field of Object.keys(into)) into[field] += stats[field] ?? 0;
      }
  const checkerMethods = Object.entries(methods)
    .map(([method, stats]) => methodRow(method, stats, known))
    .sort((a, b) => (b.crossingMs ?? b.ms) - (a.crossingMs ?? a.ms));
  // Every adapter entry across the run, costliest first.
  const adapter = {};
  for (const kind of ["rule", "phase"])
    for (const entry of Object.values(snapshot[kind]))
      for (const [label, stats] of Object.entries(entry.adapterEntries ?? {})) {
        const into = (adapter[label] ??= { calls: 0, ms: 0 });
        into.calls += stats.calls;
        into.ms += stats.ms;
      }
  const adapterEntries = adapterRows(adapter);
  return {
    wallMs: snapshot.wallMs,
    attributedMs: attributed,
    checkerSplit: known,
    rules,
    phases,
    checkerMethods,
    adapterEntries,
  };
}

/** Adapter entries, costliest first, with the average per call. */
function adapterRows(entries = {}) {
  return Object.entries(entries)
    .map(([entry, { calls, ms }]) => ({
      entry,
      calls,
      ms,
      averageUs: calls > 0 ? (ms * 1000) / calls : 0,
    }))
    .sort((a, b) => b.ms - a.ms);
}

const ms = value => (value === null ? "-" : value.toFixed(3));
const pct = (value, total) =>
  total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";

function table(header, align, rows) {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map(row => row[index].length)),
  );
  const line = cells =>
    cells
      .map((cell, index) =>
        align[index] === "r"
          ? cell.padStart(widths[index])
          : cell.padEnd(widths[index]),
      )
      .join(" | ");
  // ESLint's layout: cells are joined by " | ", so the separator cell under
  // a column spans its width plus the padding spaces on each side it has.
  const rule = widths
    .map((width, index) => {
      const span =
        width + (index > 0 ? 1 : 0) + (index < widths.length - 1 ? 1 : 0);
      return align[index] === "r"
        ? `${"-".repeat(span - 1)}:`
        : `:${"-".repeat(span - 1)}`;
    })
    .join("|");
  return [line(header), rule, ...rows.map(line)].join("\n");
}

/** ESLint's TIMING table (Rule | Time (ms) | Relative, with the same
 * columns and meaning), extended with lintrs' breakdown of each rule's time,
 * followed by engine phases and wall time. */
export function formatTiming(snapshot, limit = timingLimit() ?? 10) {
  const summary = summarize(snapshot);
  const ruleTotal = summary.rules.reduce((sum, item) => sum + item.totalMs, 0);
  const ruleTable = table(
    [
      "Rule",
      "Time (ms)",
      "Relative",
      "Lang",
      "Own (ms)",
      "Adapter (ms)",
      "Checker (ms)",
      "Crossing (ms)",
      "Calls",
      "Node maps (ms)",
    ],
    ["l", "r", "r", "l", "r", "r", "r", "r", "r", "r"],
    summary.rules
      .slice(0, limit)
      .map(item => [
        item.rule,
        ms(item.totalMs),
        pct(item.totalMs, ruleTotal),
        item.language,
        ms(item.ownMs),
        ms(item.adapterMs),
        ms(item.checkerMs),
        ms(item.crossingMs),
        String(item.checkerCalls),
        ms(item.nodeMapsMs),
      ]),
  );
  const unattributed = Math.max(0, summary.wallMs - summary.attributedMs);
  const phaseRows = [
    ["Rules (all)", ruleTotal],
    ...summary.phases.map(item => [item.phase, item.totalMs]),
    ["Unattributed (parse, traversal, config, output)", unattributed],
  ];
  const phaseTable = table(
    ["Phase", "Time (ms)", "Of wall"],
    ["l", "r", "r"],
    phaseRows.map(([name, value]) => [
      name,
      ms(value),
      pct(value, summary.wallMs),
    ]),
  );
  // The adapter's busiest entries: which property reads, wrapped methods or
  // wrapping account for its time, to aim compatibility-layer work.
  const adapterTotal = summary.adapterEntries.reduce(
    (sum, item) => sum + item.ms,
    0,
  );
  const adapterTable =
    adapterTotal > 0
      ? table(
          ["Adapter entry", "Time (ms)", "Of adapter", "Calls", "Avg (µs)"],
          ["l", "r", "r", "r", "r"],
          summary.adapterEntries
            .slice(0, Math.min(limit, 10))
            .map(item => [
              item.entry,
              ms(item.ms),
              pct(item.ms, adapterTotal),
              String(item.calls),
              item.averageUs.toFixed(2),
            ]),
        )
      : undefined;
  return [
    ruleTable,
    "",
    phaseTable,
    "",
    ...(adapterTable === undefined ? [] : [adapterTable, ""]),
    `Wall time: ${ms(summary.wallMs)} ms. Time = Own + Adapter + Checker + Crossing + Node maps; ` +
      (summary.checkerSplit
        ? "Checker is Rust compute, Crossing the JS/Rust boundary."
        : "Checker includes the JS/Rust boundary (no compute clock on this transport)."),
    "",
  ].join("\n");
}

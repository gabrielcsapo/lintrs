---
description: "See where lint time goes: per-rule timing with ESLint's TIMING variable, split into rule code, the compatibility adapter, type-checker work, the JS/Rust crossing and node-map lookups."
---

# Profiling rules

Set `TIMING`, exactly as with ESLint:

```sh
TIMING=1 lintrs -c eslint.config.mjs src     # slowest 10 rules
TIMING=all lintrs -c eslint.config.mjs src   # every rule
TIMING=25 lintrs -c eslint.config.mjs src    # slowest 25
```

The table goes to **stderr**, so `-f json` output on stdout stays parseable
(ESLint prints it to stdout). Results are identical with and without it. The
[CLI reference](/reference/cli#profiling) shows a full example.

## The rule table

`Rule`, `Time (ms)` and `Relative` mean what they mean in ESLint: a rule's
time, including the type information it asked for, and its share of all rule
time. lintrs splits that time, so for every row
`Time = Own + Adapter + Checker + Crossing + Node maps`:

| Column           | What it measures                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `Lang`           | `js` or `rust`.                                                                                  |
| `Own (ms)`       | The rule's own code.                                                                             |
| `Adapter (ms)`   | lintrs' TypeScript-compatibility layer, working on the rule's behalf (see below).                |
| `Checker (ms)`   | Type-checker work the rule asked for, timed in Rust.                                             |
| `Crossing (ms)`  | The JS/Rust boundary for those requests: converting parameters and results, and the call itself. |
| `Calls`          | How many checker requests the rule made.                                                         |
| `Node maps (ms)` | Mapping ESTree nodes to TypeScript nodes (`esTreeNodeToTSNodeMap`) and back.                     |

How to read it:

- **High `Own`**: the rule's own logic is the cost.
- **High `Adapter`**: presenting tsrs results as TypeScript's API is the
  cost, not the rule or the checker.
- **High `Checker`**: real type-checking work; batching won't help much.
- **High `Crossing`, many `Calls`**: a chatty rule. Fewer, larger requests
  would help.
- **High `Crossing`, few `Calls`**: large results crossing the boundary.

### The adapter

Typed JavaScript rules expect TypeScript's checker API: `Type`, `Symbol` and
`Node` objects with properties and methods. lintrs presents tsrs results that
way through a compatibility layer, and that layer's work is `Adapter`:

- reading properties of wrapped types, symbols, signatures and nodes
  (`type.flags`, `signature.parameters`, …);
- wrapping SDK objects into those compatible objects;
- the checker methods' own work: unwrapping arguments, memoized answers,
  and building and wrapping results.

Checker requests made along the way still count as `Checker` and `Crossing`.
Callbacks a checker method hands back to the rule count as `Own`. ESLint has
no equivalent: typescript-eslint works on TypeScript's own objects there.

The adapter table after the phases breaks `Adapter` down by entry, so you can
see which part of the layer the time goes to:

| Entry                   | Example                     | What it is                                                         |
| ----------------------- | --------------------------- | ------------------------------------------------------------------ |
| `get <kind>.<property>` | `get node.initializer`      | A rule reading a property of a type, symbol, signature, node, etc. |
| `<owner>.<method>`      | `checker.getTypeAtLocation` | A checker or object method: unwrapping, memo lookups, wrapping.    |
| `wrap`                  | `wrap`                      | Wrapping an object directly, e.g. while iterating an array.        |

Each entry's time includes adapter work nested under it (wrapping a method's
result counts toward the method), but never checker requests or rule
callbacks. A high `Avg (µs)` marks an entry that is expensive per call; a
high `Calls` with a low average marks one that is cheap but hot.

### Rust rules

[Rust rules](./rust-rules) are timed in Rust, per rule, across `initialize`
and every `visit`. They call the checker directly, so their checker work is
part of `Own` and `Adapter`, `Checker`, `Crossing` and `Calls` are `0`.

### Transports

The checker split needs the in-process binding, which the release layout
uses by default. On the child-process transport, `Checker` holds the whole
request and `Crossing` shows `-`.

## The phase table

| Phase                         | What it measures                                                     |
| ----------------------------- | -------------------------------------------------------------------- |
| Rules (all)                   | Sum of the rule table.                                               |
| Host imports                  | Loading the host after the CLI has enabled its compilation cache.    |
| Configuration load            | Importing and normalizing the flat configuration, including plugins. |
| File discovery                | Finding candidate input files before configuration matching.         |
| Configuration scoping         | Removing configuration patterns that cannot match the inputs.        |
| File configuration            | Selecting configured files and resolving their effective settings.   |
| Inline configuration          | Reading configuration comments in selected files.                    |
| Type service initialization   | Loading the checker SDK and creating its client before project work. |
| Type services setup           | Per-file `parserServices` setup, charged here rather than to a rule. |
| Project build                 | Opening the TypeScript project in tsrs.                              |
| Native rules (Rust): dispatch | Running Rust rules, minus the rules' own time.                       |
| Outside rules                 | Checker requests made outside any rule.                              |
| Unattributed                  | Remaining host work, including parsing and AST traversal.            |

With `--concurrency`, rule and phase times are summed across worker threads,
so they can exceed the wall time.

Wall time starts before the host imports and ends after linting. It excludes
Node process startup, the CLI's own static imports, and formatting/writing the
final output. Configuration imports are included, so a cold run can show
whether loading plugins costs more than executing their rules. Compare
unprofiled runs separately when measuring a performance change.

## JSON

`LINTRS_TYPE_PROFILE=profile.json` writes the same numbers under `timing`,
plus each rule's five most expensive checker methods (`ms` there is the
whole call, checker and crossing), next to the type-service totals:

```json
{
  "rule": "@typescript-eslint/unbound-method",
  "language": "js",
  "totalMs": 254.09,
  "ownMs": 29.58,
  "adapterMs": 80.06,
  "adapterCalls": 70652,
  "checkerMs": 56.29,
  "crossingMs": 86.61,
  "checkerCalls": 3483,
  "nodeMapsMs": 1.55,
  "nodeMapsCalls": 4516,
  "topCheckerMethods": [
    { "method": "getSymbolsAtLocations", "calls": 384, "ms": 113.5 }
  ]
}
```

Rules also carry `topAdapterEntries`, and `timing.adapterEntries` lists every
adapter entry across the run, costliest first:

```json
{
  "entry": "get node.initializer",
  "calls": 38739,
  "ms": 55.13,
  "averageUs": 1.42
}
```

`timing.checkerMethods` lists every checker method across the run, costliest
crossing first. With the in-process binding each method's crossing splits
further, into `conversionMs` (Node-API conversion of arguments and results,
in Rust) and `jsSideMs` (the call itself, JSON work and SDK wrapping in JS):

```json
{
  "method": "getSymbolsAtLocations",
  "calls": 384,
  "ms": 119.2,
  "computeMs": 43.3,
  "crossingMs": 75.9,
  "conversionMs": 74.8,
  "jsSideMs": 1.1
}
```

`crossingMs` is `null` on the child-process transport. With the in-process binding the file
also has `binding.typedArgumentsMs` and `binding.typedResultsMs`: the
conversion time spent decoding typed-query arguments and encoding their
results. Rust rules also carry
`ruleCalls`, the number of `initialize` and `visit` calls.

## Cost

Profiling adds about 15% to a typed run while it is on, mostly from timing
every adapter entry (millions per run). That timing also adds slightly to the
`Adapter` figure itself, under 10% of it. When profiling is off, rules and
the adapter run unwrapped and Rust rules are not timed.

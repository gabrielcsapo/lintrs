---
description: "What lintrs does not support yet: TypeScript 7 semantics, single-project limits, pinned oxlint internals, native-rule requirements, and why typed JS rules run slower than under ESLint."
---

# Limitations

lintrs is experimental. It never falls back to ESLint: a failed run exits `2`.

- **Platforms**: macOS arm64, Linux x64; Node 24.
- **TypeScript 7 semantics**: tsrs differs from TypeScript 5.x in places.
  Unsupported checker features are reported, not skipped.
- **One project**: no multiple explicit TypeScript projects. Prebuild
  project-reference declarations; freshness isn't checked.
- **Unsupported config**: see [Configuration](./configuration#not-supported).
- **oxlint 1.83.0 exactly**: lintrs imports its unstable internals
  (`dist/lint.js`, `dist/bindings.js`, `dist/workspace.js`).
- **Parser threads**: parallel parser isolation needs Linux x64 glibc.

## Native rules

- Need the in-process binding (`lib/liblintrs.node`) and a TypeScript project
  for each file. The pipe transport can't host them.
- Locked to the exact lintrs and `rustc` ([Version lock](./packaging#version-lock)).

## Typed JavaScript rules are slower than ESLint

lintrs parses and runs untyped rules faster than ESLint, but typed
JavaScript rules (typescript-eslint's `recommendedTypeChecked`, for example)
currently run slower overall; see [Benchmarks](/benchmarks). The cost is
structural:

- Under ESLint, typescript-eslint calls TypeScript in the same JavaScript
  process: asking for a type is a function call that returns an object.
- Under lintrs the checker runs in Rust. Every answer crosses from Rust to
  JavaScript (**Crossing**) and is turned into the TypeScript-shaped objects
  those rules expect (**Adapter**).

On date-fns, the checker work itself is cheaper than TypeScript's, and
untyped work is faster, but crossing and adapter together cost about as much
as the whole difference. Measured, not guessed: the adapter's time goes to
building objects for the answers rules actually use, not to its proxies
(replacing them with classes would save under 1%), so incremental tuning
narrows the gap without closing it.

What changes the picture:

- **Rules written in Rust** skip both costs: they query the checker directly.
  The same custom typed rule is about 3× faster than under ESLint (see
  [Benchmarks](/benchmarks) and [Rust rules](./rust-rules)).
- **Profiling** shows where a given config spends its time:
  `TIMING=1 lintrs …` splits each rule into its own code, adapter, checker
  work and crossing ([Profiling rules](./profiling)).

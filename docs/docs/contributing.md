# Contributing

## Build from source

Needs Node ≥ 24 and Rust 1.96 (pinned by `rust-toolchain.toml`; `rustup`
picks it up).

```sh
npm ci
cargo fetch --locked
npm run build:native
```

`npm run build:native` (`scripts/build-native.mjs`):

1. runs `type-api/prepare.mjs` into a scratch build directory (`--build`,
   default `$TMPDIR/lintrs-native-build`): it copies the pinned `tsrs_api`
   crate, applies the checked-in extensions, verifies every patch anchor, and
   leaves Cargo's checkout untouched;
2. builds the release binary, the shared `liblintrs` and the `liblintrs.node`
   wrapper;
3. fixes install names and rpaths (`@rpath` + `@loader_path` on macOS,
   `$ORIGIN` on Linux) and copies the shared libstd;
4. stages:

```txt
target/lintrs-native/
  bin/lintrs                   # CLI; finds lib/liblintrs.node automatically
  lib/liblintrs.{dylib,so}     # the one shared copy of lintrs + tsrs
  lib/liblintrs.node           # thin Node addon wrapper (napi entry)
  lib/libstd-*.{dylib,so}     # shared libstd the dylib and rules link against
  sdk/deps/                   # .rlib metadata + proc-macro dylibs
```

Keep the build directory while developing: the binary finds host modules
through it. `sdk/` is staged for development only; releases ship it as the
separate `lintrs-sdk-*` tarball.

Build a relocatable distribution (`dist/lintrs-<version>-<target>/` and its
`.tar.gz`):

```sh
npm run dist -- --build /tmp/lintrs-native-build
```

## Tests

```sh
cargo test --locked -p lintrs
npm run test:host   # `pretest:host` runs `cargo build --locked` first
```

Host fixtures compare unchanged rules against ESLint: messages, fixes,
suggestions, suppressions and UTF-16 locations. Guards keep ESLint's lint
engine and the JS TypeScript checker out of the native host. The prepared API
crate has regression tests for the query, symbol-index and checker-lifecycle
extensions.

Native binding tests run in two mutually exclusive modes:

```sh
# eager typed native
LINTRS_TYPED_NATIVE=1 LINTRS_IN_PROCESS_BINDING="$PWD/target/lintrs-native/lib/liblintrs.node" \
LINTRS_BINARY="$PWD/target/lintrs-native/bin/lintrs" LINTRS_TEST_BINARY="$PWD/target/lintrs-native/bin/lintrs" \
LINTRS_COMPACT_DECLARATIONS=1 LINTRS_FUSED_SYMBOLS=1 \
LINTRS_TRUE_BULK=1 LINTRS_CONTEXTUAL_BATCH=1 \
npm run test:host

# lazy objects
LINTRS_TYPED_NATIVE=1 LINTRS_IN_PROCESS_BINDING="$PWD/target/lintrs-native/lib/liblintrs.node" \
LINTRS_BINARY="$PWD/target/lintrs-native/bin/lintrs" LINTRS_TEST_BINARY="$PWD/target/lintrs-native/bin/lintrs" \
LINTRS_LAZY_OBJECTS=1 LINTRS_LAZY_PREFETCH=1 LINTRS_ADAPTIVE_FACTS=1 \
npm run test:host
```

Running the tests from an AI coding agent? oxlint changes its own output
when it detects one (`CLAUDECODE`, `AI_AGENT` and similar), which can hide
failures CI sees. Clear those variables to test as CI and users run lintrs:

```sh
AI_AGENT= CLAUDECODE= CLAUDE_CODE= npm run test:host
```

## Docs

```sh
npm run docs:dev      # dev server
npm run docs:build    # build into docs/doc_build
```

The site uses [Rspress](https://rspress.rs) with its own `docs/package.json`.
Add pages under `docs/docs/` and list them in `rspress.config.ts`.

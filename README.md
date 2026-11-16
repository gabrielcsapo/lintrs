# rlint

Run existing ESLint-compatible rules with Rust parsing and native TypeScript
type services. rlint replaces the JavaScript linter and the `tsc` checker inside
the lint run: files are parsed by [oxc](https://oxc.rs), rules execute through
[oxlint](https://oxc.rs/docs/guide/usage/linter)'s rule host, and typed queries
are served by a pinned [tsrs](https://github.com/oxc-project/tsrs) API extended
with checked-in extensions in `type-api/`.

**Status: experimental.** ESLint parity is incomplete, the tsrs checker has
TypeScript 7 semantics (not TypeScript 5.x), and several typed rules are not yet
supported. rlint never falls back to ESLint on failure; a failed run fails
loudly.

## Requirements

- Node.js >= 24
- Rust toolchain (MSRV 1.96) and Cargo. The checked-in
  `rust-toolchain.toml` pins `channel = "1.96.0"`, so `rustup` selects a
  suitable toolchain automatically inside the repository.

## Install

Prebuilt tarballs for Linux x64 and macOS arm64 are attached to GitHub
Releases. Two artifacts are published per platform:

- `rlint-<version>-<target>.tar.gz` — the runtime: `bin/`, `lib/` (the rlint
  dylib, the `librlint.node` binding and shared libstd), `host/`, `tsrs-sdk/`
  and docs. Everything needed to lint, including **prebuilt** native rule
  packages.
- `rlint-sdk-<version>-<target>.tar.gz` — the rule-crate SDK (`sdk/` only).
  Only needed to compile rule crates from source (local `crate:` packages);
  extract it into the unpacked distribution so `<prefix>/sdk` sits next to
  `lib/` (or point `RLINT_SDK_DIR` at it).

Unpack the runtime and put `bin/` on `PATH`:

```sh
tar -xzf rlint-<version>-<target>.tar.gz
export PATH="$PWD/rlint-<version>-<target>/bin:$PATH"
rlint --config eslint.config.mjs src/**/*.ts
```

At runtime the distribution only needs `node` >= 24 on `PATH` — no Rust
toolchain or Cargo. The Rust toolchain and the `rlint-sdk-*` tarball are only
ever needed to build rule crates from source. The binary locates `host/` and `tsrs-sdk/` relative to its
own location, so the unpacked directory can be moved freely; `RLINT_HOST_DIR`
and `RLINT_TSRS_SDK` override those locations if needed.

A distribution can also be produced from a source checkout after building:

```sh
npm run dist -- --build /tmp/rlint-native-build
# -> dist/rlint-<version>-<target>/ and dist/rlint-<version>-<target>.tar.gz
```

## Build

```sh
npm ci
cargo fetch --locked
npm run build:native
```

`npm run build:native` (`scripts/build-native.mjs`) runs
`type-api/prepare.mjs` into a scratch build directory (`--build`, default
`$TMPDIR/rlint-native-build`), builds the release binary plus the shared
`librlint` library and the `librlint.node` binding wrapper, fixes up install
names/rpaths (`@rpath` + `@loader_path` on macOS, `$ORIGIN` on Linux), copies
the shared libstd, and stages `target/rlint-native/`:

```
target/rlint-native/
  bin/rlint              # CLI; finds lib/librlint.node automatically
  lib/librlint.{dylib,so}   # the one shared copy of rlint + tsrs
  lib/librlint.node      # thin Node addon wrapper (napi entry)
  lib/libstd-*.{dylib,so}   # shared libstd the dylib and rules link against
  sdk/deps/              # .rlib metadata + proc-macro dylibs for rule builds
```

(`sdk/` is staged here for development; the `npm run dist` runtime tarball
does not contain it — it ships as `rlint-sdk-<version>-<target>.tar.gz`.)

The preparation script copies the pinned `tsrs_api` crate into the output
directory and applies the checked-in extensions. It verifies every patch
anchor and leaves Cargo's own dependency checkout untouched. Keep the prepared
build directory around while developing: the binary inside `target/` locates
host modules through the path it was built from (or install the `npm run dist`
output, which is self-contained and relocatable). `RLINT_NATIVE_HOME`
overrides the layout location for the JS host.

## Usage

Lint files directly:

```sh
rlint --config eslint.config.mjs src/**/*.ts
rlint -c eslint.config.mjs -f json src/**/*.ts > eslint-output.json
```

The default output matches ESLint's `unix` formatter (`-f unix`); `-f json`
emits the `LintResult[]` JSON. The exit code is `1` when any file reports an
error-severity message, `2` on engine failure, and `0` otherwise. `--quiet`
suppresses warnings.

### Workspace runner

`host/workspace.mjs` lints an entire workspace. Run it from the workspace
directory (or set `INIT_CWD`), passing one or more positional globs relative to
the workspace — at least one is required:

```sh
node /path/to/rlint/host/workspace.mjs 'src/**/*.{ts,mts,tsx,graphql}' [--quiet]
```

No special Node flags are needed. The runner:

- uses a single flat config: `$ESLINT_CONFIG`, else
  `<workspace>/eslint.config.mjs`;
- expands the globs, then filters the matches through config discovery so only
  files the config actually covers are linted;
- requires the in-process native binding: `lib/librlint.node` next to
  `bin/rlint` in a distribution or the `target/rlint-native/` layout from
  `npm run build:native` in a source checkout, or an explicit
  `RLINT_IN_PROCESS_BINDING`; it forces `RLINT_TYPED_NATIVE`,
  `RLINT_TRUE_BULK`, and `RLINT_CONTEXTUAL_BATCH`;
- stays on a single worker below 400 files; with 400+ files it spawns up to
  `RLINT_WORKERS` workers sharing one Rust type-session;
- writes `eslint-output.json` (the report) and `lint-timing.json` (phase
  timings) into the workspace, prints each diagnostic to stdout, and preserves
  the single-process exit codes (`1` on errors, `2` on failure).

## Native rules

rlint ships no rules of its own. Besides JavaScript rules it can run lint
rules written in **Rust**, loaded as shared libraries into the same process
and sharing the same TypeScript program and checker the typed JS rules use.

### Using native rules

A rule package wraps its rules with `nativePlugin` (from `rlint/native`) and
is used like any ESLint plugin in `eslint.config.mjs`:

```js
import { nativePlugin } from "rlint/native";

const demo = nativePlugin({
  name: "demo",
  rules: ["value-is-string", "rename-value"],
  // a local crate directory built from source, or:
  // prebuilt: { "darwin-arm64": "@acme/demo-rules-darwin-arm64", ... }
});

export default [
  {
    files: ["**/*.ts"],
    plugins: { demo },
    languageOptions: { parserOptions: { projectService: true } },
    rules: { "demo/value-is-string": "error" },
  },
];
```

`nativePlugin` returns a normal ESLint plugin whose rule entries are stubs
(`meta.rlint = { native: true, ... }`); running them under plain ESLint fails
loudly. The platform key is `` `${process.platform}-${process.arch}` `` plus
`-gnu` on Linux. Resolution order per plugin: the prebuilt platform package
for the current key, otherwise the `crate` source build (cached), otherwise an
error.

### Authoring a rule crate

A rule crate is a cdylib library crate that does **not** declare `rlint` as a
Cargo dependency — rlint compiles it with `cargo rustc --extern
rlint=<librlint> -L dependency=<sdk/deps>` so the plugin and the host share
exactly one copy of rlint and tsrs (cargo-built copies would load a second,
incompatible tsrs). For the same reason a rule crate must not depend on any
crate rlint already contains (serde_json, the tsrs crates, …): the build
fails with a message pointing at the facade. Boundary types go through the
facade's re-exports — `rlint::native::serde_json`, `rlint::native::Value`,
and `rlint::ts` (`ast`, `checker`, `compiler`, `core`, `scanner`) — while
crates rlint does _not_ contain are free to use as ordinary dependencies
(see `fixtures/native/casing-rules`, which uses `camino`). Use the `rlint`
facade API:

```rust
use rlint::native::{Rule, RuleContext};
use rlint::ts::ast::{Kind, Node};
use rlint::ts::core::P;

struct ValueIsString;

impl Rule for ValueIsString {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::Identifier
    }

    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>) {
        if node.text() == "value"
            && context
                .checker
                .type_to_string(context.checker.get_type_at_location(node))
                == "string"
        {
            context.report(node, "identifier 'value' has type string");
        }
    }
}

rlint::export_rules! {
    "value-is-string" => rlint::native::simple::<ValueIsString>,
}
```

`RuleContext` exposes `source_file`, `program`, `checker`, the resolved
`options` (`serde_json::Value` — the first element of the rule's config array)
and the reporting methods `report(node|range, message)`,
`report_with_fix(..., Fix { pos, end, text })` and
`report_with_suggestions(..., Vec<Suggestion>)`. All positions are tsrs UTF-8
byte offsets; rlint converts them to ESLint UTF-16 locations at the boundary.
`export_rules!` emits the `rlint_rules_v0` entry point together with the ABI
fingerprint; invalid options should return `Err` from the constructor and are
surfaced as a lint failure.

### Prebuilt platform packages

`node host/native/build.mjs <crate-dir> --out <dir>` compiles a crate into a
publishable platform package: the rule library plus a `package.json` whose
`"rlint": { "library", "abi" }` entries name the library file and the ABI
fingerprint it was built for. Publish one package per platform key and map
them in `nativePlugin({ prebuilt })`. At load time rlint checks the package's
`abi` against its own fingerprint (rlint version + rustc version + tsrs
revision + build id) and fails with both fingerprints on mismatch — rule
packages and rlint are locked to the exact same rlint version and `rustc`
toolchain.

### Local packages

When a plugin gives `crate:` instead of a prebuilt package, rlint builds the
crate from source on first use. Source builds need the SDK
(`rlint-sdk-<version>-<target>.tar.gz` extracted next to `lib/`, or
`RLINT_SDK_DIR`) — without it the build fails naming the exact artifact. The build requires `cargo` and the `rustc`
version named in the fingerprint (`rustup toolchain install <version>`); a
cache miss without a toolchain is a clear error, a stale or missing artifact
is rebuilt, and results are cached under `RLINT_CACHE_DIR` or `~/.cache/rlint`
keyed by fingerprint + a hash of the crate sources — cache hits never invoke
cargo. On this machine a fixture crate builds in ~1–2 s cold and under a
second after editing the rule; the resulting library is tens of KB.

### Testing rules

`NativeRuleTester` (from `rlint/native`) mirrors ESLint's `RuleTester` —
`valid`/`invalid` cases with `code`, `filename`, `options`,
`errors: { message, line, column, endLine, endColumn }` and `output` after
applying fixes — and runs each case through the real rlint binary, usable
with `node:test`.

### Limitations

- Native rules require the in-process binding (`lib/librlint.node`) and a
  TypeScript project covering each linted file; both missing cases fail
  loudly. The pipe transport cannot host them.
- macOS and Linux only.
- Rule libraries link dynamically against `lib/librlint.*` — never copy or
  rename that dylib; only the `.node` wrapper and rule libraries may move.
- The ABI fingerprint locks rule builds to the exact rlint version and
  `rustc`; there is no cross-version compatibility.

## Environment variables

| Variable                     | Effect                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RLINT_BINARY`               | Path to the `rlint` binary the host should use for subprocess work (set automatically by the binary itself).                                                                   |
| `RLINT_IN_PROCESS_BINDING`   | Absolute path to a `.node` copy of `librlint`; enables the in-process Node-API binding instead of the pipe transport.                                                          |
| `RLINT_TYPED_NATIVE`         | `1` enables the native typed session used by the in-process binding.                                                                                                           |
| `RLINT_WORKERS`              | Number of JavaScript lint workers in the workspace runner (default `1`).                                                                                                       |
| `RLINT_RUST_THREADS`         | Rust session threads shared across workers.                                                                                                                                    |
| `RLINT_OXLINT_THREADS`       | Parser threads inside oxlint's rule host.                                                                                                                                      |
| `RLINT_HOST_DIR`             | Directory containing `cli.mjs` and the other `host/*.mjs` modules (overrides auto-detection).                                                                                  |
| `RLINT_TSRS_SDK`             | Directory of a tsrs `npm/tsrs` SDK (containing `package.json` and `src/`); overrides auto-detection and removes the Cargo lookup.                                              |
| `RLINT_SHARED_SESSION`       | Internal token workers use to attach to the shared Rust session.                                                                                                               |
| `RLINT_TYPE_PROFILE`         | Path to write per-phase type-service timings as JSON.                                                                                                                          |
| `RLINT_LAZY_OBJECTS`         | `1` defers native object materialization (requires `RLINT_TYPED_NATIVE`).                                                                                                      |
| `RLINT_LAZY_PREFETCH`        | `1` prefetches lazy object facts.                                                                                                                                              |
| `RLINT_ADAPTIVE_FACTS`       | `1` fuses fact fetches using learned access plans (requires lazy objects).                                                                                                     |
| `RLINT_COMPACT_DECLARATIONS` | `1` uses compact declaration handles (requires the eager typed native binding; incompatible with lazy objects).                                                                |
| `RLINT_FUSED_SYMBOLS`        | `1` fuses symbol queries (same requirements as compact declarations).                                                                                                          |
| `RLINT_TRUE_BULK`            | `1` enables the bulk native query path.                                                                                                                                        |
| `RLINT_CONTEXTUAL_BATCH`     | `1` batches contextual type queries (requires `RLINT_TYPED_NATIVE` and `RLINT_TRUE_BULK`).                                                                                     |
| `RLINT_CONFIG_EXPORT`        | Named export to read from the config module (internal, set by workers).                                                                                                        |
| `RLINT_TEST_BINARY`          | Binary the host test suite drives (default `target/debug/rlint`).                                                                                                              |

## Runtime architecture

Files are parsed once by the Rust parser; the ESTree-compatible AST crosses to
Node and rules run inside oxlint's rule host, so ordinary ESLint-compatible
rules execute unchanged — including fixes, suggestions, selectors, scopes, and
code paths. Rules that only need syntax never create a type checker.

Typed rules see `parserServices` compatible with `@typescript-eslint`: the
program, node maps, and a checker whose queries are proxied to the pinned tsrs
checker. Type and symbol queries batch by node kind within each file. Project
snapshots, object identities, declaration wrappers, and query caches are
retained until the project's last file completes. Declaration-backed
references avoid loading dependency source programs; dependency declarations
must already be built — rlint does not build or validate their freshness.
Filename-only inspection of `Program.getSourceFiles()` does not fetch
dependency ASTs.

rlint does not run oxlint's built-in rules and ignores `oxlint-disable`
comments, exactly like ESLint: every rule the resolved flat config enables runs
on every file it covers, and only `eslint-disable*`/`eslint-enable` comments
suppress reports.

The CLI also supports the SDK's synchronous pipe transport and ordinary flat
configuration modules. Multiple explicit TypeScript projects, prebuilt
JavaScript programs, processors, and inline global/exported configuration fail
explicitly.

## Testing

```sh
cargo test --locked -p rlint
npm run test:host   # `pretest:host` runs `cargo build --locked` first
```

Host fixtures compare unchanged rules against ESLint, including complete
messages, fixes, suggestions, suppressions, and UTF-16 locations. Guards
prevent ESLint's lint engine and the JavaScript TypeScript checker from being
used inside the native host.

Native binding tests require the release build plus a `.node` copy of the
library and run in two mutually exclusive modes — same env vars in front of
`npm run test:host`:

```sh
# eager typed native (compact declarations, fused symbols, contextual batch)
RLINT_TYPED_NATIVE=1 RLINT_IN_PROCESS_BINDING="$PWD/librlint.node" \
RLINT_BINARY="$PWD/target/release/rlint" RLINT_TEST_BINARY="$PWD/target/release/rlint" \
RLINT_COMPACT_DECLARATIONS=1 RLINT_FUSED_SYMBOLS=1 \
RLINT_TRUE_BULK=1 RLINT_CONTEXTUAL_BATCH=1 \
npm run test:host

# lazy objects (lazy handles, prefetch, adaptive plans)
RLINT_TYPED_NATIVE=1 RLINT_IN_PROCESS_BINDING="$PWD/librlint.node" \
RLINT_BINARY="$PWD/target/release/rlint" RLINT_TEST_BINARY="$PWD/target/release/rlint" \
RLINT_LAZY_OBJECTS=1 RLINT_LAZY_PREFETCH=1 RLINT_ADAPTIVE_FACTS=1 \
npm run test:host
```

The prepared API crate also contains regression tests for the checked-in query,
symbol-index, and checker-lifecycle extensions.

## Limitations

- Parallel parser isolation currently requires Linux x64 glibc.
- ESLint parity is incomplete; some typed rules hit unsupported checker
  features and are reported rather than silently skipped.
- The pinned checker implements TypeScript 7 semantics, which differ from
  TypeScript 5.x in places.
- Project-reference declarations must be built beforehand; freshness is not
  checked.
- rlint imports oxlint's internals (`dist/lint.js`, `dist/bindings.js`,
  `dist/workspace.js`), which are not a stable API — it therefore requires
  exactly oxlint 1.83.0.

## License

MIT. `type-api/` contains extensions applied to
[tsrs](https://github.com/oxc-project/tsrs) (Apache-2.0, oxc-project); see
`NOTICE`.

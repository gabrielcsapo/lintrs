# Packaging Rust rules

Wrap a crate's rules with `nativePlugin` (from `lintrs/native`):

```js
import { nativePlugin } from "lintrs/native";

const demo = nativePlugin({
  name: "demo",
  rules: ["value-is-string", "rename-value"],
  // a local crate lintrs builds from source and caches, or prebuilt packages:
  // prebuilt: { "darwin-arm64": "@acme/demo-rules-darwin-arm64", ... }
  crate: new URL("./demo-rules", import.meta.url),
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

lintrs loads the prebuilt package for the platform key, else builds `crate`,
else fails. Platform key: `` `${process.platform}-${process.arch}` ``, plus
`-gnu` on Linux. The plugin's rules are stubs (`meta.lintrs.native: true`)
that throw under plain ESLint.

## Prebuilt packages

```sh
node host/native/build.mjs <crate-dir> --out <platform package dir>
```

Output: the rule library and a `package.json` with
`"lintrs": { "library", "abi" }`. Publish one package per platform key and list
them in `nativePlugin({ prebuilt })`. Users need no Rust toolchain or SDK.

## Local packages

With `crate:`, lintrs builds on first use. Needs:

- the **SDK**: `lintrs-sdk-<version>-<target>.tar.gz` extracted next to `lib/`,
  or `LINTRS_SDK_DIR` (the SDK ships as a release tarball only, not on npm);
- `cargo` and the fingerprint's `rustc`. With `rustup`, lintrs selects it
  (`RUSTUP_TOOLCHAIN`); install with `rustup toolchain install <version>`.
  Without `rustup`, the `rustc` on `PATH` must match.

Builds are cached in `LINTRS_CACHE_DIR` (default `~/.cache/lintrs`), keyed by
fingerprint and source hash. Hits never run Cargo.

## Version lock

The ABI fingerprint (lintrs version, tsrs revision, `rustc` version, build id)
must match exactly; on mismatch lintrs prints both. Rule libraries link against
`lib/liblintrs.*`: never copy or rename it. Only the `.node` wrapper and rule
libraries may move.

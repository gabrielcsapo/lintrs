---
description: Install lintrs and lint your project in a minute.
---

# Install and run

Requires Node ≥ 24; packages ship for macOS arm64 and Linux x64. npm installs
the right prebuilt binary for your platform.

## 1. Install

```sh
npm i -D @lintrs/cli
```

## 2. Lint

```sh
npx lintrs --config eslint.config.mjs src
```

### Or download a release tarball

Grab `lintrs-<version>-<target>.tar.gz` from
[GitHub Releases](https://github.com/gabrielcsapo/lintrs/releases), extract it
and put `bin/` on `PATH`, then run `lintrs --config eslint.config.mjs src`.
To build rule crates from source you also need
`lintrs-sdk-<version>-<target>.tar.gz` (see
[Packaging](./packaging#local-packages)).

## Next steps

- [Configuration](./configuration) — what's supported.
- [Rules](./rules) — JS and Rust rules.
- [Benchmarks](/benchmarks) — measured results.

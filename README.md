# lintrs

Run the rules in your existing `eslint.config.mjs`, typed typescript-eslint
rules included, with [oxc](https://oxc.rs) parsing and a native TypeScript 7
checker from [tsrs](https://github.com/oxc-project/tsrs). Write new type-aware
rules in JavaScript or Rust. lintrs ships no rules of its own.

**Docs: <https://gabrielcsapo.github.io/lintrs/>**

> **Experimental.** ESLint parity is incomplete and the checker has
> TypeScript 7 semantics. lintrs never falls back to ESLint: a failed run
> fails loudly. See
> [Limitations](https://gabrielcsapo.github.io/lintrs/guide/limitations).

## Quick start

Node ≥ 24 on macOS arm64 or Linux x64:

```sh
npm i -D lintrs
npx lintrs --config eslint.config.mjs src
```

Output matches ESLint's `unix` formatter (or `-f json`); exit codes match too.

## Learn more

- [Install and run](https://gabrielcsapo.github.io/lintrs/guide/getting-started)
  and [Configuration](https://gabrielcsapo.github.io/lintrs/guide/configuration)
- [Rules](https://gabrielcsapo.github.io/lintrs/guide/rules): the same rule
  in [JavaScript](https://gabrielcsapo.github.io/lintrs/guide/js-rules) or
  [Rust](https://gabrielcsapo.github.io/lintrs/guide/rust-rules), configured
  the same way
- [CLI](https://gabrielcsapo.github.io/lintrs/reference/cli) and
  [Profiling rules](https://gabrielcsapo.github.io/lintrs/guide/profiling)
  (`TIMING=1`)
- [Benchmarks](https://gabrielcsapo.github.io/lintrs/benchmarks) against
  ESLint, and why typed JavaScript rules are
  [still slower](https://gabrielcsapo.github.io/lintrs/guide/limitations#typed-javascript-rules-are-slower-than-eslint)

## Develop

```sh
npm ci
cargo fetch --locked
npm run build:native
npm run test:host
```

See [Contributing](https://gabrielcsapo.github.io/lintrs/contributing).

## License

MIT. `type-api/` contains extensions applied to
[tsrs](https://github.com/oxc-project/tsrs) (Apache-2.0, oxc-project); see
`NOTICE`.

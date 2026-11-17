---
description: lintrs runs the rules in your existing eslint.config.mjs with oxc parsing and a native TypeScript 7 checker, and lets you write type-aware lint rules in Rust.
---

# Introduction

lintrs runs the rules in your `eslint.config.mjs` on a different engine:

| Stage   | Engine                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Parse   | [oxc](https://oxc.rs), once per file, in Rust                                                                            |
| Rules   | [oxlint](https://oxc.rs/docs/guide/usage/linter)'s JS-plugin rule host; ESLint-compatible rules run unchanged            |
| Types   | a pinned [tsrs](https://github.com/oxc-project/tsrs) checker (a Rust port of the TypeScript 7 compiler) plus `type-api/` |
| Reports | Rust, with ESLint semantics: `eslint-disable`, `unix`/JSON output, exit codes                                            |

lintrs **ships no rules**. Every diagnostic comes from a rule your config
enables. You can also write rules [in Rust](./rust-rules).

:::warning Experimental
Parity with ESLint is incomplete. See [Limitations](./limitations).
:::

## Compared with

- **ESLint**: same config, rules and semantics. Any behavior difference is a
  parity gap.
- **oxlint's JS plugins**: oxlint `1.83.0` gives JS-plugin rules an **empty
  `parserServices`**. lintrs gives them typed, `@typescript-eslint`-compatible
  `parserServices`, so rules like `no-floating-promises` work.

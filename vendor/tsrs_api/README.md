# Vendored `tsrs_api`

`tsrs_api` from [tsrs](https://github.com/oxc-project/tsrs) (`crates/tsrs_api`),
licensed Apache-2.0 (`LICENSE`), copyright the oxc project contributors.

- Upstream revision: `c21a36ef2dd2c8ec8fdfcc8ac32fd98cd5bd8ef5`
- The other tsrs crates stay ordinary git dependencies at the same revision
  (`[workspace.dependencies]` in the root `Cargo.toml`); the root
  `[patch."https://github.com/oxc-project/tsrs"]` entry swaps this copy in for
  every crate that depends on `tsrs_api`.

## Why it is vendored

lintrs extends the checker API (typed native rules, bulk queries, symbol
indexes, checker reuse). Those extensions use `tsrs_api` internals that are
crate-private (`checker` is `pub(crate)`), so they live inside the crate. They
used to be patched into a generated copy on every build; keeping the copy here
makes them ordinary code that builds, caches and lints like the rest of the
workspace.

## What lintrs changed

The commit that vendored this directory holds the upstream files untouched
apart from `Cargo.toml` (package fields, dependencies and lints that upstream
inherits from its workspace, spelled out) and this README, `LICENSE` and
`rustfmt.toml`. Every later change is lintrs'. Files lintrs modified or added
start with a `// Modified by lintrs` or `// Added by lintrs` line.

To see lintrs' changes against upstream:

```sh
git log --oneline -- vendor/tsrs_api
git diff <vendoring commit> -- vendor/tsrs_api
```

## Updating tsrs

1. Bump the `rev` of every tsrs dependency in the root `Cargo.toml`.
2. Diff upstream `crates/tsrs_api` between the old and new revision and apply
   that diff here (`git diff old..new -- crates/tsrs_api` in a tsrs checkout,
   then `git apply --directory=vendor/tsrs_api -p3` here). Resolve conflicts
   against lintrs' changes.
3. Update the revision above, then run
   `cargo test --locked -p tsrs_api lintrs_` and the host tests.

The formatting is upstream's (tsrs does not run rustfmt), and `rustfmt.toml`
keeps `cargo fmt` from rewriting it, so upstream diffs keep applying cleanly.

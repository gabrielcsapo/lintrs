---
description: "Write type-aware lint rules in Rust: implement the lintrs Rule trait, query the TypeScript checker directly, and export rules with export_rules!."
---

# Rust rules

A Rust rule is a shared library lintrs loads in-process: it queries the same
checker as typed JS rules and skips the JS rule runtime. It is enabled and
configured exactly like a JS rule. Rust rules run on TypeScript project
files only — never on `.graphql`.

## The same rule, in Rust

This is `call-returns-union` from [JavaScript rules](./js-rules), as a
`cdylib` crate:

<!-- example: examples/rules/typescript-rust/src/lib.rs -->

```rust title="src/lib.rs"
use lintrs::native::{Rule, RuleContext};
use lintrs::ts::ast::{Kind, Node};
use lintrs::ts::checker::TypeFlags;
use lintrs::ts::core::P;

/// Reports call expressions whose result type is a union.
#[derive(Default)]
struct CallReturnsUnion;

impl Rule for CallReturnsUnion {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::CallExpression
    }

    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>) {
        let ty = context.checker.get_type_at_location(node);
        if ty.flags().contains(TypeFlags::Union) {
            context.report(node, "Call returns a union type");
        }
    }
}

lintrs::export_rules! {
    "call-returns-union" => lintrs::native::simple::<CallReturnsUnion>,
}
```

<!-- example: examples/rules/typescript-rust/Cargo.toml -->

```toml title="Cargo.toml"
[package]
name = "example-rules"
version = "0.1.0"
edition = "2024"
publish = false

[workspace]

[lib]
crate-type = ["cdylib"]
```

<!-- example: examples/rules/typescript-rust/index.mjs -->

```js title="index.mjs"
import { nativePlugin } from "@lintrs/cli/native";

export default nativePlugin({
  name: "example",
  rules: ["call-returns-union"],
  crate: new URL("./", import.meta.url),
});
```

## `RuleContext`

| Member                                                      | What it is                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `source_file`                                               | the tsrs `SourceFile`                                      |
| `program`                                                   | the shared `Program`                                       |
| `checker`                                                   | `&mut tsrs_checker::Checker`                               |
| `options`                                                   | `lintrs::native::Value`: first element of the config array |
| `report(target, message)`                                   | report a diagnostic                                        |
| `report_with_fix(target, message, Fix { pos, end, text })`  | report with an autofix                                     |
| `report_with_suggestions(target, message, Vec<Suggestion>)` | report with suggestions                                    |

A target is a node (`P<Node>`, its token range) or a `{ pos, end }` range in
tsrs **UTF-8 byte offsets**. lintrs converts to ESLint's UTF-16 locations.
`initialize` runs once per file before traversal; `listens_to` picks node
kinds, `visit` runs on each.

## Exporting

`lintrs::export_rules!` maps names to constructors
(`fn(&Value) -> Result<Box<dyn Rule>, String>`) and emits the `lintrs_rules_v0`
entry point with the ABI fingerprint.

- `lintrs::native::simple::<R>`: constructor for `Default` rules without
  options.
- With options: write a constructor; `Err` fails the lint. Example:
  `rename-value` in `fixtures/native/demo-rules/src/lib.rs`.

## Dependencies

lintrs builds crates with
`cargo rustc --extern lintrs=<liblintrs> -L dependency=<sdk/deps>` so rule and
host share one copy of lintrs and tsrs. So:

- Don't depend on `lintrs` or crates it contains (`serde_json`, tsrs crates,
  …); the build fails.
- Use the re-exports: `lintrs::native::serde_json`, `lintrs::native::Value`,
  `lintrs::ts::{ast, checker, compiler, core, scanner}`.
- Other crates are fine. `fixtures/native/casing-rules` uses `camino`.

See also: [Packaging](./packaging), [run-time requirements](./limitations#native-rules),
[Native rules API](/reference/native-api).

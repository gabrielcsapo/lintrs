# Native rules API

Rust facade: `lintrs::native`. JavaScript facade: `@lintrs/cli/native`. Guide:
[Writing Rust rules](/guide/rust-rules).

## Rust facade (`lintrs::native`)

```rust
pub trait Rule {
    fn initialize(&self, _context: &mut RuleContext<'_>) {}
    fn listens_to(&self, kind: Kind) -> bool;
    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>);
}

pub struct RuleContext<'a> {
    pub source_file: P<SourceFile>,
    pub program: &'static Program,
    pub checker: &'a mut Checker,
    pub options: &'a Value,
    // private: rule_id, diagnostics
}

impl RuleContext<'_> {
    pub fn report(&mut self, target: impl Into<ReportTarget>, message: impl Into<String>);
    pub fn report_with_fix(&mut self, target: impl Into<ReportTarget>,
                           message: impl Into<String>, fix: Fix);
    pub fn report_with_suggestions(&mut self, target: impl Into<ReportTarget>,
                                   message: impl Into<String>,
                                   suggestions: Vec<Suggestion>);
}

pub enum ReportTarget {
    Node(P<Node>),              // reported over the node's token range
    Range { pos: u32, end: u32 },
}

pub struct Fix        { pub pos: u32, pub end: u32, pub text: String }
pub struct Suggestion { pub desc: String, pub fix: Fix }
```

Positions are tsrs **UTF-8 byte offsets**, converted to ESLint UTF-16
locations.

### Constructors and the export macro

```rust
pub type RuleFactory =
    unsafe extern "C" fn(&Value) -> Result<Box<dyn Rule>, String>;

pub fn simple<R: Rule + Default + 'static>(
    _options: &Value,
) -> Result<Box<dyn Rule>, String>;

lintrs::export_rules! {
    "rule-name" => my_factory,      // fn(&Value) -> Result<Box<dyn Rule>, _>
    "plain-rule" => lintrs::native::simple::<PlainRule>,
}
```

`export_rules!` emits `#[unsafe(no_mangle)] pub extern "C" fn
lintrs_rules_v0() -> &'static RulesBundle`: the ABI fingerprint (checked before
any rule runs) and the rule table.

### Re-exports

- `lintrs::native::serde_json`, `lintrs::native::Value` — boundary JSON types.
- `lintrs::ts::{ast, checker, compiler, core, scanner}` — the tsrs crates.

### Constants

- `ABI_FINGERPRINT` — `lintrs/<version>/tsrs-<rev>/rustc-<version>/<build-id>`.
- `LINTRS_PROBE` / `probe_address()` — single-copy check: a rule library
  resolves this static in the already-loaded image.

## JavaScript facade (`@lintrs/cli/native`)

```ts
nativePlugin({
  name: string,
  rules: string[],
  crate?: string | URL,                  // local crate built from source
  prebuilt?: Record<string, string>,     // platform key -> npm package
}): ESLintPlugin
```

Platform keys: `` `${process.platform}-${process.arch}` ``, plus `-gnu` on
Linux (`darwin-arm64`, `linux-x64-gnu`).

Also exported: `NativeRuleTester`, `buildCrate`, `packageCrate`,
`cacheRoot`, `platformKey`, `nativeAbi`, `nativeHome`.

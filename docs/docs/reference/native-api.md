# Native rules API

Rust facade: `lintrs::native`. JavaScript facade: `@lintrs/cli/native`. Guide:
[Writing Rust rules](/guide/rust-rules).

## Rust facade (`lintrs::native`)

```rust
pub trait Rule {
    fn initialize(&self, _context: &mut RuleContext<'_>) {}
    fn listens_to(&self, kind: Kind) -> bool;
    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>);
    fn exit(&self, _node: P<Node>, _context: &mut RuleContext<'_>) {}
}

pub struct RuleContext<'a> {
    pub source_file: P<SourceFile>,
    pub program: &'static Program,
    pub checker: &'a mut Checker,
    pub options: &'a Value,
    // private: rule_id, diagnostics
}

impl RuleContext<'_> {
    pub fn cache<T: Default + Send + 'static>(&self) -> Arc<Mutex<T>>;
    pub fn report(&mut self, target: impl Into<ReportTarget>, message: impl Into<String>);
    pub fn report_with_id(&mut self, target: impl Into<ReportTarget>,
                          message: impl Into<String>, message_id: impl Into<String>,
                          node_type: impl Into<String>) -> &mut Diagnostic;
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
pub struct Suggestion {
    pub desc: String,
    pub fix: Fix,
    pub message_id: Option<String>,
    pub data: Option<Value>,
}
```

Positions are tsrs **UTF-8 byte offsets**, converted to ESLint UTF-16
locations.

`report_with_id` preserves ESLint message ids and ESTree node type names in
JSON output. Its returned diagnostic can also carry a fix or suggestions.
Suggestion message ids and data are optional and are preserved when supplied.
An empty replacement string deletes the selected range, for both fixes and
suggestions. These fields require rebuilding native plugins with ABI `native-3`.

`symbol_has_jsdoc_tag(symbol: P<Symbol>, name: &str) -> bool` checks a symbol's
JSDoc tags using the same symbol documentation lookup as the typed adapter.

`cache` shares state across files for the same library, rule id, options and
cache type. It is isolated per snapshot, project and checker, cleared when a
checker is replaced, and released with its snapshot. Use it for symbol or
type analysis that is valid across files. Keep the returned handle within
the rule execution; retaining it globally can outlive its source program.

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

- `ABI_FINGERPRINT` — `lintrs/<version>/native-<api>/tsrs-<rev>/rustc-<version>/<build-id>`.
- `LINTRS_PROBE` / `probe_address()` — single-copy check: a rule library
  resolves this static in the already-loaded image.

## JavaScript facade (`@lintrs/cli/native`)

```ts
nativePlugin({
  name: string,
  rules: string[],
  crate?: string | URL,                  // local crate built from source
  prebuilt?: Record<string, string>,     // platform key -> npm package
  prepareOptions?: Record<string, (options: unknown) => unknown>,
}): ESLintPlugin
```

Platform keys: `` `${process.platform}-${process.arch}` ``, plus `-gnu` on
Linux (`darwin-arm64`, `linux-x64-gnu`).

`prepareOptions` maps exported rule names to synchronous functions that return
the JSON options passed to Rust. It runs after ESLint validates user options,
once per distinct configuration in each lint worker. A single option is passed
as its object; zero or multiple options are passed as an array. Use it to supply
runtime data such as available built-in methods. Keep the function deterministic
for a configuration and process, and return JSON-serializable data. The prepared
options also identify the native program cache, so differing runtime data or
settings cannot share that rule's cached results.

Also exported: `NativeRuleTester`, `buildCrate`, `packageCrate`,
`cacheRoot`, `platformKey`, `nativeAbi`, `nativeHome`.

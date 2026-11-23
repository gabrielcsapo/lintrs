//! Facade for native (Rust) lint rules loaded from dynamic libraries.
//!
//! Rule libraries are compiled against this crate and the tsrs crates and are
//! loaded with `dlopen`; the Rust ABI is shared because the plugin, this
//! facade and the in-process binding all come from the same rustc and the same
//! dependency graph. `RulesBundle::fingerprint` is checked before any rule
//! runs.

#[cfg(feature = "typed-native")]
use std::collections::HashMap;
#[cfg(feature = "typed-native")]
use std::ffi::CStr;
#[cfg(feature = "in-process-node")]
use std::ffi::{c_char, c_void};
#[cfg(feature = "typed-native")]
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(feature = "typed-native")]
use std::sync::{Mutex, OnceLock};
#[cfg(feature = "typed-native")]
use std::time::Instant;

// Boundary types must resolve to this crate's dependency graph, never to an
// instance the plugin may also depend on. Re-exporting them lets the macro
// and plugin code go through `$crate::native::...` unconditionally.
pub use serde_json::{self, Value};
pub use tsrs_api::native_rules::symbol_has_jsdoc_tag;
use tsrs_ast::{Kind, Node, SourceFile};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
use tsrs_core::P;

/// tsrs types re-exported so rule libraries name them through this crate.
pub mod ts {
    pub use tsrs_ast as ast;
    pub use tsrs_checker as checker;
    pub use tsrs_compiler as compiler;
    pub use tsrs_core as core;
    pub use tsrs_scanner as scanner;
}

/// Identifies the exact Rust ABI surface a rule library was compiled for:
/// this crate's version, the pinned tsrs revision, and the rustc that built
/// the in-process binding. A library built for any other combination refuses
/// to load.
pub const ABI_FINGERPRINT: &str = concat!(
    "lintrs/",
    env!("CARGO_PKG_VERSION"),
    "/native-3/tsrs-c21a36ef/rustc-",
    env!("LINTRS_RUSTC_VERSION"),
    "/",
    env!("LINTRS_BUILD_ID")
);

/// Exposed for the single-copy guarantee: a rule library resolves this static
/// in the already-loaded image, so its address must match ours.
pub static LINTRS_PROBE: u8 = 0x42;

pub fn probe_address() -> usize {
    &LINTRS_PROBE as *const u8 as usize
}

pub trait Rule {
    /// Called once per file before traversal. Override to inspect the source
    /// file or prime per-file state.
    fn initialize(&self, _context: &mut RuleContext<'_>) {}
    fn listens_to(&self, kind: Kind) -> bool;
    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>);
    /// Called after the children of a node selected by `listens_to`.
    fn exit(&self, _node: P<Node>, _context: &mut RuleContext<'_>) {}
}

#[derive(Clone)]
pub struct Fix {
    /// UTF-8 byte offsets into the source text.
    pub pos: u32,
    pub end: u32,
    pub text: String,
}

#[derive(Clone)]
pub struct Suggestion {
    pub desc: String,
    pub fix: Fix,
    pub message_id: Option<String>,
    pub data: Option<Value>,
}

pub struct Diagnostic {
    pub rule_id: String,
    pub message: String,
    pub pos: u32,
    pub end: u32,
    pub fix: Option<Fix>,
    pub suggestions: Vec<Suggestion>,
    pub message_id: Option<String>,
    pub node_type: Option<String>,
}

/// Either a node (reported over its full range) or an explicit range.
/// All positions and ranges in this API are UTF-8 byte offsets into the
/// source text, the same units `Node::pos`/`Node::end` use; the runner
/// converts them to UTF-16 code units once at the boundary.
pub enum ReportTarget {
    Node(P<Node>),
    Range { pos: u32, end: u32 },
}

impl From<P<Node>> for ReportTarget {
    fn from(node: P<Node>) -> Self {
        ReportTarget::Node(node)
    }
}

impl From<(u32, u32)> for ReportTarget {
    fn from((pos, end): (u32, u32)) -> Self {
        ReportTarget::Range { pos, end }
    }
}

pub struct RuleContext<'a> {
    pub source_file: P<SourceFile>,
    pub program: &'static Program,
    pub checker: &'a mut Checker,
    pub options: &'a Value,
    rule_id: &'a str,
    diagnostics: &'a mut Vec<Diagnostic>,
    state: &'a tsrs_api::native_rules::NativeRuleState,
    cache_key: &'a str,
}

impl RuleContext<'_> {
    /// Shared across files for this rule's library, id and options, within one
    /// snapshot, project and checker. A replacement checker starts empty.
    pub fn cache<T: Default + Send + 'static>(&self) -> std::sync::Arc<std::sync::Mutex<T>> {
        self.state.cache(self.cache_key)
    }

    pub fn report(&mut self, target: impl Into<ReportTarget>, message: impl Into<String>) {
        let (pos, end) = self.range(target);
        self.diagnostics.push(Diagnostic {
            rule_id: self.rule_id.to_string(),
            message: message.into(),
            pos,
            end,
            fix: None,
            suggestions: Vec::new(),
            message_id: None,
            node_type: None,
        });
    }

    pub fn report_with_id(
        &mut self,
        target: impl Into<ReportTarget>,
        message: impl Into<String>,
        message_id: impl Into<String>,
        node_type: impl Into<String>,
    ) -> &mut Diagnostic {
        self.report(target, message);
        let diagnostic = self.diagnostics.last_mut().unwrap();
        diagnostic.message_id = Some(message_id.into());
        diagnostic.node_type = Some(node_type.into());
        diagnostic
    }

    pub fn report_with_fix(
        &mut self,
        target: impl Into<ReportTarget>,
        message: impl Into<String>,
        fix: Fix,
    ) {
        let (pos, end) = self.range(target);
        self.diagnostics.push(Diagnostic {
            rule_id: self.rule_id.to_string(),
            message: message.into(),
            pos,
            end,
            fix: Some(fix),
            suggestions: Vec::new(),
            message_id: None,
            node_type: None,
        });
    }

    pub fn report_with_suggestions(
        &mut self,
        target: impl Into<ReportTarget>,
        message: impl Into<String>,
        suggestions: Vec<Suggestion>,
    ) {
        let (pos, end) = self.range(target);
        self.diagnostics.push(Diagnostic {
            rule_id: self.rule_id.to_string(),
            message: message.into(),
            pos,
            end,
            fix: None,
            suggestions,
            message_id: None,
            node_type: None,
        });
    }

    fn range(&self, target: impl Into<ReportTarget>) -> (u32, u32) {
        match target.into() {
            ReportTarget::Node(node) => {
                // Skip leading trivia so columns match ESLint's node-start
                // convention (tsrs `pos` includes preceding whitespace/comments).
                let pos = tsrs_scanner::get_token_pos_of_node(node, self.source_file, false);
                (pos.max(0) as u32, node.end().max(0) as u32)
            }
            ReportTarget::Range { pos, end } => (pos, end),
        }
    }
}

/// `fn(&options) -> Result<Box<dyn Rule>, String>` per exported rule name.
/// The boundary is Rust-ABI by design: plugin, facade and binding share one
/// compiler, so `Result`/`Box<dyn>`/`&str` cross it unchanged.
#[allow(improper_ctypes_definitions)]
pub type RuleFactory = unsafe extern "C" fn(&Value) -> Result<Box<dyn Rule>, String>;

#[repr(C)]
pub struct RuleEntry {
    pub name: &'static str,
    pub create: RuleFactory,
}

#[repr(C)]
pub struct RulesBundle {
    pub fingerprint: &'static str,
    pub rules: &'static [RuleEntry],
}

/// Constructor for option-less rules: `export_rules!("id" => simple::<R>)`.
pub fn simple<R: Rule + Default + 'static>(_options: &Value) -> Result<Box<dyn Rule>, String> {
    Ok(Box::new(R::default()))
}

#[macro_export]
macro_rules! export_rules {
    ($($name:literal => $create:expr),+ $(,)?) => {
        static __LINTRS_RULES: &[$crate::native::RuleEntry] = &[
            $(
                $crate::native::RuleEntry {
                    name: $name,
                    create: {
                        struct __LintrsFactory;
                        impl __LintrsFactory {
                            #[allow(improper_ctypes_definitions)]
                            unsafe extern "C" fn call(
                                options: &$crate::native::Value,
                            ) -> Result<Box<dyn $crate::native::Rule>, String> {
                                ($create)(options)
                            }
                        }
                        __LintrsFactory::call
                    },
                }
            ),+
        ];
        static __LINTRS_BUNDLE: $crate::native::RulesBundle =
            $crate::native::RulesBundle {
                fingerprint: $crate::native::ABI_FINGERPRINT,
                rules: __LINTRS_RULES,
            };
        #[allow(improper_ctypes_definitions)]
        #[unsafe(no_mangle)]
        pub extern "C" fn lintrs_rules_v0() -> &'static $crate::native::RulesBundle {
            &__LINTRS_BUNDLE
        }
    };
}

pub use crate::export_rules;

#[cfg(test)]
mod export_rules_tests {
    use super::{Rule, Value};

    fn create(options: &Value) -> Result<Box<dyn Rule>, String> {
        Err(format!("create:{options}"))
    }

    fn call(options: &Value) -> Result<Box<dyn Rule>, String> {
        Err(format!("call:{options}"))
    }

    crate::export_rules! {
        "bare-create" => create,
        "bare-call" => call,
        "qualified" => self::create,
        "closure" => |options| create(options),
    }

    #[test]
    fn factory_names_do_not_resolve_to_the_abi_trampoline() {
        let bundle = lintrs_rules_v0();
        for (entry, expected) in
            bundle
                .rules
                .iter()
                .zip(["create:42", "call:42", "create:42", "create:42"])
        {
            let result = unsafe { (entry.create)(&Value::from(42)) };
            assert_eq!(result.err().as_deref(), Some(expected));
        }
    }
}

#[cfg(feature = "in-process-node")]
unsafe extern "C" {
    fn dlopen(path: *const c_char, mode: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    #[cfg(feature = "typed-native")]
    fn dlerror() -> *mut c_char;
}

#[cfg(feature = "in-process-node")]
const RTLD_NOW: i32 = 2;
/// Keep plugin code and its bundle statics alive for the process lifetime;
/// rules outlive the snapshot they run against.
#[cfg(all(feature = "in-process-node", target_os = "macos"))]
const RTLD_NODELETE: i32 = 0x80;
#[cfg(all(feature = "in-process-node", target_os = "linux"))]
const RTLD_NODELETE: i32 = 0x1000;

#[cfg(feature = "typed-native")]
static BUNDLES: OnceLock<Mutex<HashMap<String, &'static RulesBundle>>> = OnceLock::new();

/// Per-rule timing for TIMING / LINTRS_TYPE_PROFILE: the number of sessions
/// with a registered profiler clock (`profileClock`). Timing is on while any
/// is registered, so normal runs never read the clock around a rule call, and
/// one --concurrency worker finishing does not switch it off for the others.
#[cfg(feature = "typed-native")]
static PROFILERS: AtomicUsize = AtomicUsize::new(0);
/// Rule id -> (milliseconds, calls) across every file since the last take.
#[cfg(feature = "typed-native")]
static RULE_TIMES: Mutex<Option<HashMap<String, (f64, u64)>>> = Mutex::new(None);

#[cfg(feature = "typed-native")]
pub(crate) fn profiler_registered(registered: bool) {
    if registered {
        PROFILERS.fetch_add(1, Ordering::AcqRel);
    } else {
        let _ = PROFILERS.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            count.checked_sub(1)
        });
    }
}

/// Returns and clears the accumulated per-rule times as
/// `{ ruleId: { ms, calls } }`; calls count `initialize`, `visit` and `exit`.
#[cfg(feature = "typed-native")]
pub(crate) fn take_rule_times() -> Value {
    let times = RULE_TIMES
        .lock()
        .map(|mut times| times.take().unwrap_or_default())
        .unwrap_or_default();
    Value::Object(
        times
            .into_iter()
            .map(|(id, (ms, calls))| (id, serde_json::json!({ "ms": ms, "calls": calls })))
            .collect(),
    )
}

/// Times `action` into `times[index]` when profiling, else just runs it.
#[cfg(feature = "typed-native")]
fn timed(times: &mut Option<Vec<(f64, u64)>>, index: usize, action: impl FnOnce()) {
    match times {
        None => action(),
        Some(times) => {
            let start = Instant::now();
            action();
            let entry = &mut times[index];
            entry.0 += start.elapsed().as_secs_f64() * 1000.0;
            entry.1 += 1;
        }
    }
}

#[cfg(feature = "typed-native")]
unsafe fn load_library(path: &str) -> Result<&'static RulesBundle, String> {
    let path_c = std::ffi::CString::new(path).map_err(|_| format!("bad path {path}"))?;
    let handle = unsafe { dlopen(path_c.as_ptr(), RTLD_NOW | RTLD_NODELETE) };
    if handle.is_null() {
        let error = unsafe {
            let e = dlerror();
            if e.is_null() {
                "unknown".to_string()
            } else {
                CStr::from_ptr(e).to_string_lossy().into_owned()
            }
        };
        return Err(format!("dlopen {path}: {error}"));
    }
    let symbol = unsafe { dlsym(handle, c"lintrs_rules_v0".as_ptr()) };
    if symbol.is_null() {
        return Err(format!("{path} does not export lintrs_rules_v0"));
    }
    let bundle_fn: extern "C" fn() -> &'static RulesBundle = unsafe { std::mem::transmute(symbol) };
    let bundle = bundle_fn();
    if bundle.fingerprint != ABI_FINGERPRINT {
        return Err(format!(
            "{path} was built for {}, this process is {}",
            bundle.fingerprint, ABI_FINGERPRINT,
        ));
    }
    Ok(bundle)
}

/// The runner installed into the tsrs dispatch. Builds a checker-bound
/// context per rule and walks the file once, dispatching on `listens_to`.
/// `tsrs_api::native_rules` is lintrs' addition to the vendored tsrs_api
/// (vendor/tsrs_api); the runner is only built with `typed-native`.
#[cfg(feature = "typed-native")]
unsafe fn run(
    call: &mut tsrs_api::native_rules::LintrsNativeCall<'_>,
    specs: &[tsrs_api::native_rules::LintrsNativeRuleSpec],
    libraries: &[String],
) -> Result<Vec<tsrs_api::native_rules::LintrsNativeDiagnostic>, String> {
    let cache = BUNDLES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache.lock().unwrap();
    let mut bundles = Vec::with_capacity(libraries.len());
    for library in libraries {
        let bundle = match cache.get(library) {
            Some(bundle) => *bundle,
            None => {
                let bundle = unsafe { load_library(library)? };
                cache.insert(library.clone(), bundle);
                bundle
            }
        };
        bundles.push(bundle);
    }
    drop(cache);
    let mut rules: Vec<Box<dyn Rule>> = Vec::with_capacity(specs.len());
    let mut options: Vec<Value> = Vec::with_capacity(specs.len());
    let mut cache_keys = Vec::with_capacity(specs.len());
    for spec in specs {
        let parsed = tsrs_core::json::marshal(&spec.options)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let mut found = None;
        for (library, bundle) in libraries.iter().zip(&bundles) {
            if spec.library.as_ref().is_some_and(|owner| owner != library) {
                continue;
            }
            for entry in bundle.rules {
                if entry.name == spec.name {
                    if found.is_some() {
                        return Err(format!(
                            "ambiguous native rule {}; specify its library",
                            spec.name
                        ));
                    }
                    found = Some((library, entry));
                }
            }
        }
        let Some((library, entry)) = found else {
            return Err(format!(
                "no native rule named {} in its configured library",
                spec.name
            ));
        };
        rules.push(unsafe { (entry.create)(&parsed) }?);
        cache_keys.push(serde_json::to_string(&(library, &spec.name, &spec.id, &parsed)).unwrap());
        options.push(parsed);
    }
    let mut diagnostics = Vec::new();
    let mut listeners: HashMap<Kind, Vec<usize>> = HashMap::new();
    let mut times = (PROFILERS.load(Ordering::Acquire) > 0).then(|| vec![(0.0, 0); rules.len()]);
    #[allow(clippy::too_many_arguments)]
    fn visit(
        node: P<Node>,
        rules: &[Box<dyn Rule>],
        listeners: &mut HashMap<Kind, Vec<usize>>,
        call: &mut tsrs_api::native_rules::LintrsNativeCall<'_>,
        specs: &[tsrs_api::native_rules::LintrsNativeRuleSpec],
        options: &[Value],
        cache_keys: &[String],
        diagnostics: &mut Vec<Diagnostic>,
        times: &mut Option<Vec<(f64, u64)>>,
    ) {
        let kind = node.kind();
        let active = listeners
            .entry(kind)
            .or_insert_with(|| {
                rules
                    .iter()
                    .enumerate()
                    .filter_map(|(index, rule)| rule.listens_to(kind).then_some(index))
                    .collect()
            })
            .clone();
        for &index in &active {
            let rule = &rules[index];
            let mut context = RuleContext {
                source_file: call.source_file,
                program: call.program,
                checker: call.checker,
                options: &options[index],
                rule_id: &specs[index].id,
                diagnostics,
                state: &call.state,
                cache_key: &cache_keys[index],
            };
            timed(times, index, || rule.visit(node, &mut context));
        }
        node.for_each_child(&mut |child| {
            visit(
                child,
                rules,
                listeners,
                call,
                specs,
                options,
                cache_keys,
                diagnostics,
                times,
            );
            false
        });
        for &index in &active {
            let mut context = RuleContext {
                source_file: call.source_file,
                program: call.program,
                checker: call.checker,
                options: &options[index],
                rule_id: &specs[index].id,
                diagnostics,
                state: &call.state,
                cache_key: &cache_keys[index],
            };
            timed(times, index, || rules[index].exit(node, &mut context));
        }
    }
    for (index, rule) in rules.iter().enumerate() {
        let mut context = RuleContext {
            source_file: call.source_file,
            program: call.program,
            checker: call.checker,
            options: &options[index],
            rule_id: &specs[index].id,
            diagnostics: &mut diagnostics,
            state: &call.state,
            cache_key: &cache_keys[index],
        };
        timed(&mut times, index, || rule.initialize(&mut context));
    }
    call.source_file.as_node().for_each_child(&mut |child| {
        visit(
            child,
            &rules,
            &mut listeners,
            call,
            specs,
            &options,
            &cache_keys,
            &mut diagnostics,
            &mut times,
        );
        false
    });
    if let Some(times) = times
        && let Ok(mut totals) = RULE_TIMES.lock()
    {
        let totals = totals.get_or_insert_with(HashMap::new);
        for (spec, (ms, calls)) in specs.iter().zip(times) {
            let entry = totals.entry(spec.id.clone()).or_insert((0.0, 0));
            entry.0 += ms;
            entry.1 += calls;
        }
    }
    // tsrs positions are UTF-8 byte offsets; everything past this boundary
    // (and every other lintrs path) uses UTF-16 code units, so convert here.
    let text = call.source_file.text();
    let utf16 = |offset: u32| -> u32 {
        text.get(..offset as usize)
            .map(|prefix| prefix.chars().map(char::len_utf16).sum::<usize>() as u32)
            .unwrap_or(offset)
    };
    Ok(diagnostics
        .into_iter()
        .map(
            |diagnostic| tsrs_api::native_rules::LintrsNativeDiagnostic {
                rule_id: diagnostic.rule_id,
                message: diagnostic.message,
                message_id: diagnostic.message_id,
                node_type: diagnostic.node_type,
                pos: utf16(diagnostic.pos),
                end: utf16(diagnostic.end),
                fix: diagnostic
                    .fix
                    .map(|fix| tsrs_api::native_rules::LintrsNativeFix {
                        pos: utf16(fix.pos),
                        end: utf16(fix.end),
                        text: fix.text,
                    }),
                suggestions: diagnostic
                    .suggestions
                    .into_iter()
                    .map(
                        |suggestion| tsrs_api::native_rules::LintrsNativeSuggestion {
                            desc: suggestion.desc,
                            message_id: suggestion.message_id,
                            data: suggestion.data.map(|value| {
                                tsrs_core::json::unmarshal(&value.to_string()).unwrap()
                            }),
                            fix: tsrs_api::native_rules::LintrsNativeFix {
                                pos: utf16(suggestion.fix.pos),
                                end: utf16(suggestion.fix.end),
                                text: suggestion.fix.text,
                            },
                        },
                    )
                    .collect(),
            },
        )
        .collect())
}

#[cfg(feature = "typed-native")]
pub fn install_runner() {
    tsrs_api::native_rules::set_native_rules_runner(run);
}

/// Single-copy proof hook for tests: a rule library may export `lintrs_probe`
/// returning `probe_address()`; the host compares it against its own address.
#[cfg(feature = "in-process-node")]
pub fn plugin_probe(library: &str) -> Option<usize> {
    let path_c = std::ffi::CString::new(library).ok()?;
    let handle = unsafe { dlopen(path_c.as_ptr(), RTLD_NOW | RTLD_NODELETE) };
    if handle.is_null() {
        return None;
    }
    let probe = unsafe { dlsym(handle, c"lintrs_probe".as_ptr()) };
    if probe.is_null() {
        return None;
    }
    let probe_fn: extern "C" fn() -> usize = unsafe { std::mem::transmute(probe) };
    Some(probe_fn())
}

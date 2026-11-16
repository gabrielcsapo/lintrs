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
use std::sync::{Mutex, OnceLock};

// Boundary types must resolve to this crate's dependency graph, never to an
// instance the plugin may also depend on. Re-exporting them lets the macro
// and plugin code go through `$crate::native::...` unconditionally.
pub use serde_json::{self, Value};
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
    "rlint/",
    env!("CARGO_PKG_VERSION"),
    "/tsrs-c21a36ef/rustc-",
    env!("RLINT_RUSTC_VERSION"),
    "/",
    env!("RLINT_BUILD_ID")
);

/// Exposed for the single-copy guarantee: a rule library resolves this static
/// in the already-loaded image, so its address must match ours.
pub static RLINT_PROBE: u8 = 0x42;

pub fn probe_address() -> usize {
    &RLINT_PROBE as *const u8 as usize
}

pub trait Rule {
    /// Called once per file before traversal. Override to inspect the source
    /// file or prime per-file state.
    fn initialize(&self, _context: &mut RuleContext<'_>) {}
    fn listens_to(&self, kind: Kind) -> bool;
    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>);
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
}

pub struct Diagnostic {
    pub rule_id: String,
    pub message: String,
    pub pos: u32,
    pub end: u32,
    pub fix: Option<Fix>,
    pub suggestions: Vec<Suggestion>,
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
}

impl RuleContext<'_> {
    pub fn report(&mut self, target: impl Into<ReportTarget>, message: impl Into<String>) {
        let (pos, end) = self.range(target);
        self.diagnostics.push(Diagnostic {
            rule_id: self.rule_id.to_string(),
            message: message.into(),
            pos,
            end,
            fix: None,
            suggestions: Vec::new(),
        });
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
        static __RLINT_RULES: &[$crate::native::RuleEntry] = &[
            $(
                $crate::native::RuleEntry {
                    name: $name,
                    create: {
                        #[allow(improper_ctypes_definitions)]
                        unsafe extern "C" fn create(
                            options: &$crate::native::Value,
                        ) -> Result<Box<dyn $crate::native::Rule>, String> {
                            ($create)(options)
                        }
                        create
                    },
                }
            ),+
        ];
        static __RLINT_BUNDLE: $crate::native::RulesBundle =
            $crate::native::RulesBundle {
                fingerprint: $crate::native::ABI_FINGERPRINT,
                rules: __RLINT_RULES,
            };
        #[allow(improper_ctypes_definitions)]
        #[unsafe(no_mangle)]
        pub extern "C" fn rlint_rules_v0() -> &'static $crate::native::RulesBundle {
            &__RLINT_BUNDLE
        }
    };
}

pub use crate::export_rules;

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
    let symbol = unsafe { dlsym(handle, c"rlint_rules_v0".as_ptr()) };
    if symbol.is_null() {
        return Err(format!("{path} does not export rlint_rules_v0"));
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
/// `tsrs_api::native_rules` is injected by type-api/prepare.mjs, so this only
/// exists in prepared builds (`typed-native`).
#[cfg(feature = "typed-native")]
unsafe fn run(
    call: &mut tsrs_api::native_rules::RlintNativeCall<'_>,
    specs: &[tsrs_api::native_rules::RlintNativeRuleSpec],
    libraries: &[String],
) -> Result<Vec<tsrs_api::native_rules::RlintNativeDiagnostic>, String> {
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
    for spec in specs {
        let parsed = tsrs_core::json::marshal(&spec.options)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let mut found = false;
        for bundle in &bundles {
            for entry in bundle.rules {
                if entry.name == spec.name {
                    rules.push(unsafe { (entry.create)(&parsed) }?);
                    found = true;
                }
            }
        }
        if !found {
            return Err(format!("no native rule named {}", spec.name));
        }
        options.push(parsed);
    }
    let mut diagnostics = Vec::new();
    let mut listeners: HashMap<Kind, Vec<usize>> = HashMap::new();
    fn visit(
        node: P<Node>,
        rules: &[Box<dyn Rule>],
        listeners: &mut HashMap<Kind, Vec<usize>>,
        call: &mut tsrs_api::native_rules::RlintNativeCall<'_>,
        specs: &[tsrs_api::native_rules::RlintNativeRuleSpec],
        options: &[Value],
        diagnostics: &mut Vec<Diagnostic>,
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
            };
            rule.visit(node, &mut context);
        }
        node.for_each_child(&mut |child| {
            visit(child, rules, listeners, call, specs, options, diagnostics);
            false
        });
    }
    for (index, rule) in rules.iter().enumerate() {
        let mut context = RuleContext {
            source_file: call.source_file,
            program: call.program,
            checker: call.checker,
            options: &options[index],
            rule_id: &specs[index].id,
            diagnostics: &mut diagnostics,
        };
        rule.initialize(&mut context);
    }
    call.source_file.as_node().for_each_child(&mut |child| {
        visit(
            child,
            &rules,
            &mut listeners,
            call,
            specs,
            &options,
            &mut diagnostics,
        );
        false
    });
    // tsrs positions are UTF-8 byte offsets; everything past this boundary
    // (and every other rlint path) uses UTF-16 code units, so convert here.
    let text = call.source_file.text();
    let utf16 = |offset: u32| -> u32 {
        text.get(..offset as usize)
            .map(|prefix| prefix.chars().map(char::len_utf16).sum::<usize>() as u32)
            .unwrap_or(offset)
    };
    Ok(diagnostics
        .into_iter()
        .map(|diagnostic| tsrs_api::native_rules::RlintNativeDiagnostic {
            rule_id: diagnostic.rule_id,
            message: diagnostic.message,
            pos: utf16(diagnostic.pos),
            end: utf16(diagnostic.end),
            fix: diagnostic
                .fix
                .map(|fix| tsrs_api::native_rules::RlintNativeFix {
                    pos: utf16(fix.pos),
                    end: utf16(fix.end),
                    text: fix.text,
                }),
            suggestions: diagnostic
                .suggestions
                .into_iter()
                .map(|suggestion| tsrs_api::native_rules::RlintNativeSuggestion {
                    desc: suggestion.desc,
                    fix: tsrs_api::native_rules::RlintNativeFix {
                        pos: utf16(suggestion.fix.pos),
                        end: utf16(suggestion.fix.end),
                        text: suggestion.fix.text,
                    },
                })
                .collect(),
        })
        .collect())
}

#[cfg(feature = "typed-native")]
pub fn install_runner() {
    tsrs_api::native_rules::set_native_rules_runner(run);
}

/// Single-copy proof hook for tests: a rule library may export `rlint_probe`
/// returning `probe_address()`; the host compares it against its own address.
#[cfg(feature = "in-process-node")]
pub fn plugin_probe(library: &str) -> Option<usize> {
    let path_c = std::ffi::CString::new(library).ok()?;
    let handle = unsafe { dlopen(path_c.as_ptr(), RTLD_NOW | RTLD_NODELETE) };
    if handle.is_null() {
        return None;
    }
    let probe = unsafe { dlsym(handle, c"rlint_probe".as_ptr()) };
    if probe.is_null() {
        return None;
    }
    let probe_fn: extern "C" fn() -> usize = unsafe { std::mem::transmute(probe) };
    Some(probe_fn())
}

// Added by lintrs: see vendor/tsrs_api/README.md.
//! lintrs native rule libraries: shared types and the registered runner.
//! The runner lives in the `lintrs` facade crate and is installed once per
//! process; both sides see the same definitions, so pointers between them are
//! ordinary typed references (same compiler, same crate sources).

use tsrs_ast::SourceFile;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_core::json::Value;
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub fn symbol_has_jsdoc_tag(symbol: P<tsrs_ast::Symbol>, name: &str) -> bool {
    tsrs_ls::get_symbol_jsdoc_tags(Some(symbol))
        .iter()
        .any(|tag| tag.name == name)
}

/// Rule caches belong to one snapshot, project and checker. Keeping them in
/// the checker registry prevents symbols from escaping into a later program.
#[derive(Default)]
pub struct NativeRuleState {
    caches: Mutex<HashMap<(String, TypeId), Arc<dyn Any + Send + Sync>>>,
}

impl NativeRuleState {
    pub fn cache<T: Default + Send + 'static>(&self, key: &str) -> Arc<Mutex<T>> {
        let mut caches = self.caches.lock().unwrap();
        Arc::clone(caches
            .entry((key.to_string(), TypeId::of::<T>()))
            .or_insert_with(|| Arc::new(Mutex::new(T::default()))))
            .downcast::<Mutex<T>>()
            .unwrap_or_else(|_| unreachable!("cache type is part of the key"))
    }
}

pub struct LintrsNativeRuleSpec {
    /// Exported rule name inside the library (e.g. "no-string-value").
    pub name: String,
    /// ESLint rule id to report (e.g. "demo/no-string-value").
    pub id: String,
    /// Owning library. Older callers may omit it for unambiguous rule names.
    pub library: Option<String>,
    pub options: Value,
}

pub struct LintrsNativeFix {
    pub pos: u32,
    pub end: u32,
    pub text: String,
    pub text_utf16: Option<Vec<u16>>,
}

pub struct LintrsNativeSuggestion {
    pub desc: String,
    pub fix: LintrsNativeFix,
    pub message_id: Option<String>,
    pub data: Option<Value>,
}

/// ESLint source locations use one-based lines and zero-based UTF-16 columns.
/// Line zero is preserved for diagnostics about project configuration.
/// Column -1 preserves column-zero directive diagnostics in ESLint output.
#[derive(Clone, Copy)]
pub struct LintrsNativePosition {
    pub line: u32,
    pub column: i32,
}

#[derive(Clone, Copy)]
pub struct LintrsNativeLocation {
    pub start: LintrsNativePosition,
    pub end: Option<LintrsNativePosition>,
}

pub struct LintrsNativeDiagnostic {
    pub rule_id: String,
    pub message: String,
    pub message_id: Option<String>,
    pub node_type: Option<String>,
    pub location: Option<LintrsNativeLocation>,
    pub pos: u32,
    pub end: u32,
    pub fix: Option<LintrsNativeFix>,
    pub suggestions: Vec<LintrsNativeSuggestion>,
}

pub struct LintrsNativeCall<'a> {
    pub checker: &'a mut tsrs_checker::Checker,
    pub program: &'static Program,
    pub source_file: P<SourceFile>,
    pub state: Arc<NativeRuleState>,
}

pub type LintrsNativeRunner = for<'a> unsafe fn(
    &mut LintrsNativeCall<'a>,
    &[LintrsNativeRuleSpec],
    &[String],
) -> Result<Vec<LintrsNativeDiagnostic>, String>;

static NATIVE_RULES_RUNNER: std::sync::RwLock<Option<LintrsNativeRunner>> =
    std::sync::RwLock::new(None);

pub fn set_native_rules_runner(runner: LintrsNativeRunner) {
    *NATIVE_RULES_RUNNER.write().unwrap() = Some(runner);
}

pub(crate) fn native_rules_runner() -> Option<LintrsNativeRunner> {
    *NATIVE_RULES_RUNNER.read().unwrap()
}

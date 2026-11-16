//! rlint native rule libraries: shared types and the registered runner.
//! The runner lives in the `rlint` facade crate and is installed once per
//! process; both sides see the same definitions, so pointers between them are
//! ordinary typed references (same compiler, same crate sources).

use tsrs_ast::SourceFile;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_core::json::Value;

pub struct RlintNativeRuleSpec {
    /// Exported rule name inside the library (e.g. "no-string-value").
    pub name: String,
    /// ESLint rule id to report (e.g. "demo/no-string-value").
    pub id: String,
    pub options: Value,
}

pub struct RlintNativeFix {
    pub pos: u32,
    pub end: u32,
    pub text: String,
}

pub struct RlintNativeSuggestion {
    pub desc: String,
    pub fix: RlintNativeFix,
}

pub struct RlintNativeDiagnostic {
    pub rule_id: String,
    pub message: String,
    pub pos: u32,
    pub end: u32,
    pub fix: Option<RlintNativeFix>,
    pub suggestions: Vec<RlintNativeSuggestion>,
}

pub struct RlintNativeCall<'a> {
    pub checker: &'a mut tsrs_checker::Checker,
    pub program: &'static Program,
    pub source_file: P<SourceFile>,
}

pub type RlintNativeRunner = for<'a> unsafe fn(
    &mut RlintNativeCall<'a>,
    &[RlintNativeRuleSpec],
    &[String],
) -> Result<Vec<RlintNativeDiagnostic>, String>;

static NATIVE_RULES_RUNNER: std::sync::RwLock<Option<RlintNativeRunner>> =
    std::sync::RwLock::new(None);

pub fn set_native_rules_runner(runner: RlintNativeRunner) {
    *NATIVE_RULES_RUNNER.write().unwrap() = Some(runner);
}

pub(crate) fn native_rules_runner() -> Option<RlintNativeRunner> {
    *NATIVE_RULES_RUNNER.read().unwrap()
}

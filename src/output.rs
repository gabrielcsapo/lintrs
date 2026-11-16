use std::fmt::Write;

use crate::diagnostic::{ERROR, LintResult};

pub fn json(results: &[LintResult]) -> anyhow::Result<String> {
    Ok(serde_json::to_string(results)?)
}

/// ESLint's default `stylish` layout, without colors.
pub fn stylish(results: &[LintResult]) -> String {
    let mut out = String::new();
    let (mut errors, mut warnings) = (0, 0);
    for result in results.iter().filter(|r| !r.messages.is_empty()) {
        let _ = writeln!(out, "\n{}", result.file_path);
        for message in &result.messages {
            let level = if message.severity == ERROR {
                "error"
            } else {
                "warning"
            };
            let _ = writeln!(
                out,
                "  {}:{}  {level}  {}  {}",
                message.line,
                message.column,
                message.message.replace('\n', " "),
                message.rule_id.as_deref().unwrap_or("")
            );
        }
        errors += result.error_count;
        warnings += result.warning_count;
    }
    let total = errors + warnings;
    if total > 0 {
        let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
        let _ = writeln!(
            out,
            "\n✖ {} ({}, {})",
            plural(total, "problem"),
            plural(errors, "error"),
            plural(warnings, "warning")
        );
    }
    out
}

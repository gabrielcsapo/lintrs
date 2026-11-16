//! Fixture rule crate used by host/native-*.test.mjs. Not shipped.

use rlint::native::{Fix, Rule, RuleContext, Suggestion, probe_address};
use rlint::ts::ast::Kind;
use rlint::ts::core::P;
use rlint::native::serde_json::Value;

/// Flags a `value` identifier whose type is `string`.
#[derive(Default)]
struct ValueIsString;

impl Rule for ValueIsString {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::Identifier
    }

    fn visit(&self, node: P<rlint::ts::ast::Node>, context: &mut RuleContext<'_>) {
        if node.text() != "value" {
            return;
        }
        let ty = context.checker.get_type_at_location(node);
        if context.checker.type_to_string_exported(ty) == "string" {
            context.report(node, "identifier 'value' has type string");
        }
    }
}

/// Renames an identifier (options: {"match": string, "replacement": string}),
/// demonstrating options parsing, a fix, and a suggestion.
struct RenameValue {
    target: String,
    replacement: String,
}

fn rename_value(options: &Value) -> Result<Box<dyn Rule>, String> {
    let object = options
        .as_object()
        .ok_or("rename-value expects an options object")?;
    let target = object
        .get("match")
        .and_then(Value::as_str)
        .ok_or("rename-value requires a \"match\" string")?;
    let replacement = object
        .get("replacement")
        .and_then(Value::as_str)
        .ok_or("rename-value requires a \"replacement\" string")?;
    Ok(Box::new(RenameValue {
        target: target.to_string(),
        replacement: replacement.to_string(),
    }))
}

impl Rule for RenameValue {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::Identifier
    }

    fn visit(&self, node: P<rlint::ts::ast::Node>, context: &mut RuleContext<'_>) {
        if node.text() != self.target {
            return;
        }
        let fix = Fix {
            pos: rlint::ts::scanner::get_token_pos_of_node(node, context.source_file, false).max(0)
                as u32,
            end: node.end().max(0) as u32,
            text: self.replacement.clone(),
        };
        context.report_with_fix(
            node,
            format!("rename '{}' to '{}'", self.target, self.replacement),
            fix.clone(),
        );
    }
}

/// Flags string literals containing non-ASCII text (UTF-16 range checks).
#[derive(Default)]
struct NoNonAsciiString;

impl Rule for NoNonAsciiString {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::StringLiteral
    }

    fn visit(&self, node: P<rlint::ts::ast::Node>, context: &mut RuleContext<'_>) {
        if node.text().chars().any(|c| !c.is_ascii()) {
            context.report(node, "non-ASCII string literal");
        }
    }
}

/// Single-copy probe: resolved against the already-loaded rlint dylib.
#[unsafe(no_mangle)]
pub extern "C" fn rlint_probe() -> usize {
    probe_address()
}

/// Same rename, reported through a suggestion instead of an autofix.
struct SuggestRename {
    target: String,
    replacement: String,
}

fn suggest_rename(options: &Value) -> Result<Box<dyn Rule>, String> {
    let object = options
        .as_object()
        .ok_or("suggest-rename expects an options object")?;
    let target = object
        .get("match")
        .and_then(Value::as_str)
        .ok_or("suggest-rename requires a \"match\" string")?;
    let replacement = object
        .get("replacement")
        .and_then(Value::as_str)
        .ok_or("suggest-rename requires a \"replacement\" string")?;
    Ok(Box::new(SuggestRename {
        target: target.to_string(),
        replacement: replacement.to_string(),
    }))
}

impl Rule for SuggestRename {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::Identifier
    }

    fn visit(&self, node: P<rlint::ts::ast::Node>, context: &mut RuleContext<'_>) {
        if node.text() != self.target {
            return;
        }
        context.report_with_suggestions(
            node,
            format!("rename '{}' to '{}'", self.target, self.replacement),
            vec![Suggestion {
                desc: format!("Replace with '{}'", self.replacement),
                fix: Fix {
                    pos: rlint::ts::scanner::get_token_pos_of_node(node, context.source_file, false)
                        .max(0) as u32,
                    end: node.end().max(0) as u32,
                    text: self.replacement.clone(),
                },
            }],
        );
    }
}

rlint::export_rules! {
    "value-is-string" => rlint::native::simple::<ValueIsString>,
    "rename-value" => rename_value,
    "suggest-rename" => suggest_rename,
    "no-non-ascii-string" => rlint::native::simple::<NoNonAsciiString>,
}

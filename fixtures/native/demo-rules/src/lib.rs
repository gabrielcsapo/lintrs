//! Fixture rule crate used by host/native-*.test.mjs. Not shipped.

use lintrs::native::serde_json::Value;
use lintrs::native::{Fix, Rule, RuleContext, Suggestion, probe_address};
use lintrs::ts::ast::Kind;
use lintrs::ts::core::P;

/// Flags a `value` identifier whose type is `string`.
#[derive(Default)]
struct ValueIsString;

#[derive(Default)]
struct FileCounter;

#[derive(Default)]
struct ExitOrdering(std::cell::RefCell<Vec<String>>);

impl Rule for ExitOrdering {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::CallExpression
    }
    fn visit(&self, node: P<lintrs::ts::ast::Node>, _context: &mut RuleContext<'_>) {
        self.0.borrow_mut().push(format!(
            "enter {}",
            node.as_call_expression().expression().text()
        ));
    }
    fn exit(&self, node: P<lintrs::ts::ast::Node>, context: &mut RuleContext<'_>) {
        let name = node.as_call_expression().expression().text();
        self.0.borrow_mut().push(format!("exit {name}"));
        if name == "outer" {
            context.report(node, self.0.borrow().join(", "));
        }
    }
}

impl Rule for FileCounter {
    fn initialize(&self, context: &mut RuleContext<'_>) {
        let cache = context.cache::<usize>();
        let mut count = cache.lock().unwrap();
        *count += 1;
        context.report_with_id((0, 1), format!("file {}", *count), "fileCount", "Program");
    }

    fn listens_to(&self, _kind: Kind) -> bool {
        false
    }

    fn visit(&self, _node: P<lintrs::ts::ast::Node>, _context: &mut RuleContext<'_>) {}
}

impl Rule for ValueIsString {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::Identifier
    }

    fn visit(&self, node: P<lintrs::ts::ast::Node>, context: &mut RuleContext<'_>) {
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

    fn visit(&self, node: P<lintrs::ts::ast::Node>, context: &mut RuleContext<'_>) {
        if node.text() != self.target {
            return;
        }
        let fix = Fix {
            pos: lintrs::ts::scanner::get_token_pos_of_node(node, context.source_file, false).max(0)
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

    fn visit(&self, node: P<lintrs::ts::ast::Node>, context: &mut RuleContext<'_>) {
        if node.text().chars().any(|c| !c.is_ascii()) {
            context.report(node, "non-ASCII string literal");
        }
    }
}

/// Single-copy probe: resolved against the already-loaded lintrs dylib.
#[unsafe(no_mangle)]
pub extern "C" fn lintrs_probe() -> usize {
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

    fn visit(&self, node: P<lintrs::ts::ast::Node>, context: &mut RuleContext<'_>) {
        if node.text() != self.target {
            return;
        }
        context.report_with_suggestions(
            node,
            format!("rename '{}' to '{}'", self.target, self.replacement),
            vec![Suggestion {
                desc: format!("Replace with '{}'", self.replacement),
                message_id: Some("replaceName".into()),
                data: Some(lintrs::native::serde_json::json!({"replacement": self.replacement})),
                fix: Fix {
                    pos: lintrs::ts::scanner::get_token_pos_of_node(
                        node,
                        context.source_file,
                        false,
                    )
                    .max(0) as u32,
                    end: node.end().max(0) as u32,
                    text: self.replacement.clone(),
                },
            }],
        );
    }
}

#[derive(Default)]
struct ExplicitLocation;

impl Rule for ExplicitLocation {
    fn initialize(&self, context: &mut RuleContext<'_>) {
        use lintrs::native::{Location, Position};
        let with_end = context
            .options
            .get("withEnd")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let line = context
            .options
            .get("line")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;
        let column = context
            .options
            .get("column")
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32;
        let fix = context
            .options
            .get("fix")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then(|| {
                let pos = context.source_file.text().find("value").unwrap() as u32;
                Fix {
                    pos,
                    end: pos + 5,
                    text: "renamed".into(),
                }
            });
        let diagnostic = context.report_at_location(
            Location {
                start: Position { line, column },
                end: with_end.then_some(Position { line, column }),
            },
            "explicit location",
        );
        diagnostic.message_id = Some("explicitLocation".into());
        diagnostic.fix = fix;
    }
    fn listens_to(&self, _kind: Kind) -> bool {
        false
    }
    fn visit(&self, _node: P<lintrs::ts::ast::Node>, _context: &mut RuleContext<'_>) {}
}

#[derive(Default)]
pub struct Utf16Replacement;
impl Rule for Utf16Replacement {
    fn initialize(&self, context: &mut RuleContext<'_>) {
        let diagnostic =
            context.report_with_id((0, 0), "UTF-16 replacement", "utf16Replacement", "Program");
        diagnostic.fix_utf16 = Some(lintrs::native::Utf16Fix {
            pos: 0,
            end: 0,
            text: vec![0x27, 0xd800, 0x27],
        });
    }
    fn listens_to(&self, _kind: Kind) -> bool {
        false
    }
    fn visit(&self, _node: P<lintrs::ts::ast::Node>, _context: &mut RuleContext<'_>) {}
}

lintrs::export_rules! {
    "utf16-replacement" => lintrs::native::simple::<Utf16Replacement>,
    "explicit-location" => lintrs::native::simple::<ExplicitLocation>,
    "exit-ordering" => lintrs::native::simple::<ExitOrdering>,
    "file-counter" => lintrs::native::simple::<FileCounter>,
    "value-is-string" => lintrs::native::simple::<ValueIsString>,
    "rename-value" => rename_value,
    "suggest-rename" => suggest_rename,
    "no-non-ascii-string" => lintrs::native::simple::<NoNonAsciiString>,
}

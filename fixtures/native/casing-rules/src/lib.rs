//! Rule crate that uses its own crates.io dependency internally.
//!
//! `camino` is a Cargo dependency of this crate (and not part of lintrs's
//! dependency graph): it is compiled and linked into the rule library while
//! the boundary types still come from `lintrs::native`.

use camino::Utf8Path;
use lintrs::native::{Rule, RuleContext};
use lintrs::ts::ast::{Kind, Node};
use lintrs::ts::core::P;

/// Flags string literals that name an existing non-UTF-8-free path segment:
/// reports literals containing a platform-style path like `a/b/c` whose
/// first segment is `tmp`.
#[derive(Default)]
struct TmpPathLiteral;

impl Rule for TmpPathLiteral {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::StringLiteral
    }

    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>) {
        let text = node.text();
        let path = Utf8Path::new(text.trim_matches('"'));
        if path.components().next().is_some_and(|c| c.as_str() == "tmp") {
            context.report(node, format!("path '{}' starts in tmp", path));
        }
    }
}

lintrs::export_rules! {
    "no-tmp-path" => lintrs::native::simple::<TmpPathLiteral>,
}

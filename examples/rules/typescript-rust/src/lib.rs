use lintrs::native::{Rule, RuleContext};
use lintrs::ts::ast::{Kind, Node};
use lintrs::ts::checker::TypeFlags;
use lintrs::ts::core::P;

/// Reports call expressions whose result type is a union.
#[derive(Default)]
struct CallReturnsUnion;

impl Rule for CallReturnsUnion {
    fn listens_to(&self, kind: Kind) -> bool {
        kind == Kind::CallExpression
    }

    fn visit(&self, node: P<Node>, context: &mut RuleContext<'_>) {
        let ty = context.checker.get_type_at_location(node);
        if ty.flags().contains(TypeFlags::Union) {
            context.report(node, "Call returns a union type");
        }
    }
}

lintrs::export_rules! {
    "call-returns-union" => lintrs::native::simple::<CallReturnsUnion>,
}

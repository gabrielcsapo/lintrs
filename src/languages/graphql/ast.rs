//! A graphql-js-shaped AST built from apollo-parser's lossless syntax tree,
//! so rules see the node kinds, children order and token locations that
//! graphql-eslint's rules saw.
//!
//! Nodes are allocated in graphql-js's visitor order (`QueryDocumentKeys`),
//! so iterating ids from zero is a pre-order traversal.

use apollo_parser::cst::{self, CstNode};
use apollo_parser::{SyntaxKind, SyntaxNode, SyntaxToken};

use super::tokens::Token;

pub type NodeId = usize;
pub type TokenId = usize;

macro_rules! kinds {
    ($($kind:ident),* $(,)?) => {
        /// graphql-js's `Kind`.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Kind { $($kind),* }

        impl Kind {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$kind => stringify!($kind)),* }
            }
        }
    };
}

kinds!(
    Name,
    Document,
    OperationDefinition,
    VariableDefinition,
    SelectionSet,
    Field,
    Argument,
    FragmentSpread,
    InlineFragment,
    FragmentDefinition,
    Variable,
    IntValue,
    FloatValue,
    StringValue,
    BooleanValue,
    NullValue,
    EnumValue,
    ListValue,
    ObjectValue,
    ObjectField,
    Directive,
    NamedType,
    ListType,
    NonNullType,
    SchemaDefinition,
    OperationTypeDefinition,
    ScalarTypeDefinition,
    ObjectTypeDefinition,
    FieldDefinition,
    InputValueDefinition,
    InterfaceTypeDefinition,
    UnionTypeDefinition,
    EnumTypeDefinition,
    EnumValueDefinition,
    InputObjectTypeDefinition,
    DirectiveDefinition,
    SchemaExtension,
    ScalarTypeExtension,
    ObjectTypeExtension,
    InterfaceTypeExtension,
    UnionTypeExtension,
    EnumTypeExtension,
    InputObjectTypeExtension,
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Query,
    Mutation,
    Subscription,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Mutation => "mutation",
            Self::Subscription => "subscription",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Node {
    pub kind: Kind,
    /// graphql-js `Location` tokens: the first and last non-comment tokens.
    pub start_token: TokenId,
    pub end_token: TokenId,
    pub parent: Option<NodeId>,
    /// Child nodes in graphql-js visitor order.
    pub children: Vec<NodeId>,
    pub name: Option<NodeId>,
    pub alias: Option<NodeId>,
    pub description: Option<NodeId>,
    /// The type of a field, input value or variable; the inner type of a list
    /// or non-null type; the named type of an operation type definition; a
    /// fragment's type condition.
    pub ty: Option<NodeId>,
    /// An argument's or object field's value; an input value's or variable's
    /// default value.
    pub value: Option<NodeId>,
    pub variable: Option<NodeId>,
    pub selection_set: Option<NodeId>,
    /// Field and directive arguments, or argument definitions.
    pub arguments: Vec<NodeId>,
    pub directives: Vec<NodeId>,
    pub interfaces: Vec<NodeId>,
    pub variable_definitions: Vec<NodeId>,
    /// Definitions, selections, fields, values, union members, operation
    /// types or directive locations, depending on the kind.
    pub items: Vec<NodeId>,
    /// A name, a scalar literal (decoded for strings) or a boolean.
    pub text: String,
    pub operation: Option<Operation>,
    pub block: bool,
    pub repeatable: bool,
}

pub struct Document {
    pub tokens: Vec<Token>,
    pub nodes: Vec<Node>,
}

#[derive(Debug)]
pub struct ShapeError(pub &'static str);

type Built<T> = Result<T, ShapeError>;

fn required<T>(value: Option<T>, what: &'static str) -> Built<T> {
    value.ok_or(ShapeError(what))
}

fn is_trivia(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::WHITESPACE | SyntaxKind::COMMENT | SyntaxKind::COMMA
    )
}

struct Builder<'a> {
    tokens: &'a [Token],
    nodes: Vec<Node>,
}

impl Builder<'_> {
    fn token_id(&self, token: &SyntaxToken) -> Built<TokenId> {
        let offset = usize::from(token.text_range().start());
        self.tokens
            .binary_search_by_key(&offset, |t| t.start)
            .map_err(|_| ShapeError("token missing from the token stream"))
    }

    fn significant_range(&self, syntax: &SyntaxNode) -> Built<(TokenId, TokenId)> {
        let range = syntax.text_range();
        let mut first = syntax.first_token();
        while let Some(token) = first.as_ref().filter(|t| is_trivia(t.kind())) {
            first = token
                .next_token()
                .filter(|next| range.contains_range(next.text_range()));
        }
        let mut last = syntax.last_token();
        while let Some(token) = last.as_ref().filter(|t| is_trivia(t.kind())) {
            last = token
                .prev_token()
                .filter(|prev| range.contains_range(prev.text_range()));
        }
        let first = required(first, "node without tokens")?;
        let last = required(last, "node without tokens")?;
        Ok((self.token_id(&first)?, self.token_id(&last)?))
    }

    fn push(&mut self, kind: Kind, start_token: TokenId, end_token: TokenId) -> NodeId {
        self.nodes.push(Node {
            kind,
            start_token,
            end_token,
            parent: None,
            children: Vec::new(),
            name: None,
            alias: None,
            description: None,
            ty: None,
            value: None,
            variable: None,
            selection_set: None,
            arguments: Vec::new(),
            directives: Vec::new(),
            interfaces: Vec::new(),
            variable_definitions: Vec::new(),
            items: Vec::new(),
            text: String::new(),
            operation: None,
            block: false,
            repeatable: false,
        });
        self.nodes.len() - 1
    }

    fn alloc(&mut self, kind: Kind, syntax: &SyntaxNode) -> Built<NodeId> {
        let (start, end) = self.significant_range(syntax)?;
        Ok(self.push(kind, start, end))
    }

    fn link(&mut self, parent: NodeId, child: NodeId) -> NodeId {
        self.nodes[child].parent = Some(parent);
        self.nodes[parent].children.push(child);
        child
    }

    fn name(&mut self, parent: NodeId, name: Option<cst::Name>) -> Built<NodeId> {
        let name = required(name, "missing name")?;
        let id = self.alloc(Kind::Name, name.syntax())?;
        self.nodes[id].text = name.text().to_string();
        Ok(self.link(parent, id))
    }

    fn set_name(&mut self, parent: NodeId, name: Option<cst::Name>) -> Built<()> {
        let id = self.name(parent, name)?;
        self.nodes[parent].name = Some(id);
        Ok(())
    }

    fn description(&mut self, parent: NodeId, description: Option<cst::Description>) -> Built<()> {
        if let Some(value) = description.and_then(|d| d.string_value()) {
            let id = self.string(&value)?;
            self.link(parent, id);
            self.nodes[parent].description = Some(id);
        }
        Ok(())
    }

    fn string(&mut self, value: &cst::StringValue) -> Built<NodeId> {
        let id = self.alloc(Kind::StringValue, value.syntax())?;
        self.nodes[id].block = value.syntax().text().to_string().starts_with("\"\"\"");
        self.nodes[id].text = String::from(value);
        Ok(id)
    }

    fn directives(&mut self, parent: NodeId, directives: Option<cst::Directives>) -> Built<()> {
        for directive in directives.iter().flat_map(|d| d.directives()) {
            let id = self.alloc(Kind::Directive, directive.syntax())?;
            self.link(parent, id);
            self.set_name(id, directive.name())?;
            self.arguments(id, directive.arguments())?;
            self.nodes[parent].directives.push(id);
        }
        Ok(())
    }

    fn arguments(&mut self, parent: NodeId, arguments: Option<cst::Arguments>) -> Built<()> {
        for argument in arguments.iter().flat_map(|a| a.arguments()) {
            let id = self.alloc(Kind::Argument, argument.syntax())?;
            self.link(parent, id);
            self.set_name(id, argument.name())?;
            let value = self.value(required(argument.value(), "argument value")?)?;
            self.link(id, value);
            self.nodes[id].value = Some(value);
            self.nodes[parent].arguments.push(id);
        }
        Ok(())
    }

    fn value(&mut self, value: cst::Value) -> Built<NodeId> {
        Ok(match value {
            cst::Value::Variable(variable) => self.variable(&variable)?,
            cst::Value::StringValue(value) => self.string(&value)?,
            cst::Value::FloatValue(value) => {
                let id = self.alloc(Kind::FloatValue, value.syntax())?;
                self.nodes[id].text = value.syntax().text().to_string();
                id
            }
            cst::Value::IntValue(value) => {
                let id = self.alloc(Kind::IntValue, value.syntax())?;
                self.nodes[id].text = value.syntax().text().to_string();
                id
            }
            cst::Value::BooleanValue(value) => {
                let id = self.alloc(Kind::BooleanValue, value.syntax())?;
                self.nodes[id].text = if value.true_token().is_some() {
                    "true"
                } else {
                    "false"
                }
                .to_owned();
                id
            }
            cst::Value::NullValue(value) => self.alloc(Kind::NullValue, value.syntax())?,
            cst::Value::EnumValue(value) => {
                let id = self.alloc(Kind::EnumValue, value.syntax())?;
                self.nodes[id].text = value.text().to_string();
                id
            }
            cst::Value::ListValue(list) => {
                let id = self.alloc(Kind::ListValue, list.syntax())?;
                for item in list.values() {
                    let child = self.value(item)?;
                    self.link(id, child);
                    self.nodes[id].items.push(child);
                }
                id
            }
            cst::Value::ObjectValue(object) => {
                let id = self.alloc(Kind::ObjectValue, object.syntax())?;
                for field in object.object_fields() {
                    let field_id = self.alloc(Kind::ObjectField, field.syntax())?;
                    self.link(id, field_id);
                    self.set_name(field_id, field.name())?;
                    let value = self.value(required(field.value(), "object field value")?)?;
                    self.link(field_id, value);
                    self.nodes[field_id].value = Some(value);
                    self.nodes[id].items.push(field_id);
                }
                id
            }
        })
    }

    fn variable(&mut self, variable: &cst::Variable) -> Built<NodeId> {
        let id = self.alloc(Kind::Variable, variable.syntax())?;
        self.set_name(id, variable.name())?;
        Ok(id)
    }

    fn ty(&mut self, parent: NodeId, ty: Option<cst::Type>) -> Built<NodeId> {
        let id = match required(ty, "missing type")? {
            cst::Type::NamedType(named) => self.named_type(&named)?,
            cst::Type::ListType(list) => self.list_type(&list)?,
            cst::Type::NonNullType(non_null) => {
                let id = self.alloc(Kind::NonNullType, non_null.syntax())?;
                let inner = match (non_null.named_type(), non_null.list_type()) {
                    (Some(named), _) => self.named_type(&named)?,
                    (None, Some(list)) => self.list_type(&list)?,
                    (None, None) => return Err(ShapeError("empty non-null type")),
                };
                self.link(id, inner);
                self.nodes[id].ty = Some(inner);
                id
            }
        };
        self.link(parent, id);
        Ok(id)
    }

    fn set_ty(&mut self, parent: NodeId, ty: Option<cst::Type>) -> Built<()> {
        let id = self.ty(parent, ty)?;
        self.nodes[parent].ty = Some(id);
        Ok(())
    }

    fn named_type(&mut self, named: &cst::NamedType) -> Built<NodeId> {
        let id = self.alloc(Kind::NamedType, named.syntax())?;
        self.set_name(id, named.name())?;
        Ok(id)
    }

    fn list_type(&mut self, list: &cst::ListType) -> Built<NodeId> {
        let id = self.alloc(Kind::ListType, list.syntax())?;
        self.set_ty(id, list.ty())?;
        Ok(id)
    }

    fn default_value(&mut self, parent: NodeId, value: Option<cst::DefaultValue>) -> Built<()> {
        if let Some(value) = value.and_then(|d| d.value()) {
            let id = self.value(value)?;
            self.link(parent, id);
            self.nodes[parent].value = Some(id);
        }
        Ok(())
    }

    fn input_values(
        &mut self,
        parent: NodeId,
        values: impl Iterator<Item = cst::InputValueDefinition>,
        into_arguments: bool,
    ) -> Built<()> {
        for value in values {
            let id = self.alloc(Kind::InputValueDefinition, value.syntax())?;
            self.link(parent, id);
            self.description(id, value.description())?;
            self.set_name(id, value.name())?;
            self.set_ty(id, value.ty())?;
            self.default_value(id, value.default_value())?;
            self.directives(id, value.directives())?;
            if into_arguments {
                self.nodes[parent].arguments.push(id);
            } else {
                self.nodes[parent].items.push(id);
            }
        }
        Ok(())
    }

    fn interfaces(
        &mut self,
        parent: NodeId,
        interfaces: Option<cst::ImplementsInterfaces>,
    ) -> Built<()> {
        for named in interfaces.iter().flat_map(|i| i.named_types()) {
            let id = self.named_type(&named)?;
            self.link(parent, id);
            self.nodes[parent].interfaces.push(id);
        }
        Ok(())
    }

    fn fields(&mut self, parent: NodeId, fields: Option<cst::FieldsDefinition>) -> Built<()> {
        for field in fields.iter().flat_map(|f| f.field_definitions()) {
            let id = self.alloc(Kind::FieldDefinition, field.syntax())?;
            self.link(parent, id);
            self.description(id, field.description())?;
            self.set_name(id, field.name())?;
            if let Some(arguments) = field.arguments_definition() {
                self.input_values(id, arguments.input_value_definitions(), true)?;
            }
            self.set_ty(id, field.ty())?;
            self.directives(id, field.directives())?;
            self.nodes[parent].items.push(id);
        }
        Ok(())
    }

    fn union_members(
        &mut self,
        parent: NodeId,
        members: Option<cst::UnionMemberTypes>,
    ) -> Built<()> {
        for named in members.iter().flat_map(|m| m.named_types()) {
            let id = self.named_type(&named)?;
            self.link(parent, id);
            self.nodes[parent].items.push(id);
        }
        Ok(())
    }

    fn enum_values(
        &mut self,
        parent: NodeId,
        values: Option<cst::EnumValuesDefinition>,
    ) -> Built<()> {
        for value in values.iter().flat_map(|v| v.enum_value_definitions()) {
            let id = self.alloc(Kind::EnumValueDefinition, value.syntax())?;
            self.link(parent, id);
            self.description(id, value.description())?;
            self.set_name(id, value.enum_value().and_then(|v| v.name()))?;
            self.directives(id, value.directives())?;
            self.nodes[parent].items.push(id);
        }
        Ok(())
    }

    fn operation_types(
        &mut self,
        parent: NodeId,
        definitions: impl Iterator<Item = cst::RootOperationTypeDefinition>,
    ) -> Built<()> {
        for definition in definitions {
            let id = self.alloc(Kind::OperationTypeDefinition, definition.syntax())?;
            self.link(parent, id);
            self.nodes[id].operation = Some(operation(definition.operation_type())?);
            let named = self.named_type(&required(definition.named_type(), "operation type")?)?;
            self.link(id, named);
            self.nodes[id].ty = Some(named);
            self.nodes[parent].items.push(id);
        }
        Ok(())
    }

    fn variable_definitions(
        &mut self,
        parent: NodeId,
        definitions: Option<cst::VariableDefinitions>,
    ) -> Built<()> {
        for definition in definitions.iter().flat_map(|d| d.variable_definitions()) {
            let id = self.alloc(Kind::VariableDefinition, definition.syntax())?;
            self.link(parent, id);
            let variable = self.variable(&required(definition.variable(), "variable")?)?;
            self.link(id, variable);
            self.nodes[id].variable = Some(variable);
            self.set_ty(id, definition.ty())?;
            self.default_value(id, definition.default_value())?;
            self.directives(id, definition.directives())?;
            self.nodes[parent].variable_definitions.push(id);
        }
        Ok(())
    }

    fn selection_set(&mut self, parent: NodeId, set: Option<cst::SelectionSet>) -> Built<()> {
        let Some(set) = set else {
            return Ok(());
        };
        let id = self.alloc(Kind::SelectionSet, set.syntax())?;
        self.link(parent, id);
        self.nodes[parent].selection_set = Some(id);
        for selection in set.selections() {
            let child = match selection {
                cst::Selection::Field(field) => {
                    let child = self.alloc(Kind::Field, field.syntax())?;
                    self.link(id, child);
                    if let Some(alias) = field.alias() {
                        let alias_id = self.name(child, alias.name())?;
                        self.nodes[child].alias = Some(alias_id);
                    }
                    self.set_name(child, field.name())?;
                    self.arguments(child, field.arguments())?;
                    self.directives(child, field.directives())?;
                    self.selection_set(child, field.selection_set())?;
                    child
                }
                cst::Selection::FragmentSpread(spread) => {
                    let child = self.alloc(Kind::FragmentSpread, spread.syntax())?;
                    self.link(id, child);
                    self.set_name(child, spread.fragment_name().and_then(|f| f.name()))?;
                    self.directives(child, spread.directives())?;
                    child
                }
                cst::Selection::InlineFragment(fragment) => {
                    let child = self.alloc(Kind::InlineFragment, fragment.syntax())?;
                    self.link(id, child);
                    if let Some(named) = fragment.type_condition().and_then(|t| t.named_type()) {
                        let named = self.named_type(&named)?;
                        self.link(child, named);
                        self.nodes[child].ty = Some(named);
                    }
                    self.directives(child, fragment.directives())?;
                    self.selection_set(child, fragment.selection_set())?;
                    child
                }
            };
            self.nodes[id].items.push(child);
        }
        Ok(())
    }

    fn definition(&mut self, definition: cst::Definition) -> Built<NodeId> {
        use cst::Definition as D;
        Ok(match definition {
            D::OperationDefinition(op) => {
                let id = self.alloc(Kind::OperationDefinition, op.syntax())?;
                self.nodes[id].operation = Some(match op.operation_type() {
                    Some(ty) => operation(Some(ty))?,
                    None => Operation::Query,
                });
                if let Some(name) = op.name() {
                    self.set_name(id, Some(name))?;
                }
                self.variable_definitions(id, op.variable_definitions())?;
                self.directives(id, op.directives())?;
                self.selection_set(id, op.selection_set())?;
                id
            }
            D::FragmentDefinition(fragment) => {
                let id = self.alloc(Kind::FragmentDefinition, fragment.syntax())?;
                self.set_name(id, fragment.fragment_name().and_then(|f| f.name()))?;
                let named = required(
                    fragment.type_condition().and_then(|t| t.named_type()),
                    "type condition",
                )?;
                let named = self.named_type(&named)?;
                self.link(id, named);
                self.nodes[id].ty = Some(named);
                self.directives(id, fragment.directives())?;
                self.selection_set(id, fragment.selection_set())?;
                id
            }
            D::DirectiveDefinition(def) => {
                let id = self.alloc(Kind::DirectiveDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.set_name(id, def.name())?;
                if let Some(arguments) = def.arguments_definition() {
                    self.input_values(id, arguments.input_value_definitions(), true)?;
                }
                self.nodes[id].repeatable = def.repeatable_token().is_some();
                for location in def
                    .directive_locations()
                    .iter()
                    .flat_map(|l| l.directive_locations())
                {
                    let location_id = self.alloc(Kind::Name, location.syntax())?;
                    self.nodes[location_id].text =
                        location.text().map(|t| t.to_string()).unwrap_or_default();
                    self.link(id, location_id);
                    self.nodes[id].items.push(location_id);
                }
                id
            }
            D::SchemaDefinition(def) => {
                let id = self.alloc(Kind::SchemaDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.directives(id, def.directives())?;
                self.operation_types(id, def.root_operation_type_definitions())?;
                id
            }
            D::SchemaExtension(def) => {
                let id = self.alloc(Kind::SchemaExtension, def.syntax())?;
                self.directives(id, def.directives())?;
                self.operation_types(id, def.root_operation_type_definitions())?;
                id
            }
            D::ScalarTypeDefinition(def) => {
                let id = self.alloc(Kind::ScalarTypeDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                id
            }
            D::ScalarTypeExtension(def) => {
                let id = self.alloc(Kind::ScalarTypeExtension, def.syntax())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                id
            }
            D::ObjectTypeDefinition(def) => {
                let id = self.alloc(Kind::ObjectTypeDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.set_name(id, def.name())?;
                self.interfaces(id, def.implements_interfaces())?;
                self.directives(id, def.directives())?;
                self.fields(id, def.fields_definition())?;
                id
            }
            D::ObjectTypeExtension(def) => {
                let id = self.alloc(Kind::ObjectTypeExtension, def.syntax())?;
                self.set_name(id, def.name())?;
                self.interfaces(id, def.implements_interfaces())?;
                self.directives(id, def.directives())?;
                self.fields(id, def.fields_definition())?;
                id
            }
            D::InterfaceTypeDefinition(def) => {
                let id = self.alloc(Kind::InterfaceTypeDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.set_name(id, def.name())?;
                self.interfaces(id, def.implements_interfaces())?;
                self.directives(id, def.directives())?;
                self.fields(id, def.fields_definition())?;
                id
            }
            D::InterfaceTypeExtension(def) => {
                let id = self.alloc(Kind::InterfaceTypeExtension, def.syntax())?;
                self.set_name(id, def.name())?;
                self.interfaces(id, def.implements_interfaces())?;
                self.directives(id, def.directives())?;
                self.fields(id, def.fields_definition())?;
                id
            }
            D::UnionTypeDefinition(def) => {
                let id = self.alloc(Kind::UnionTypeDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                self.union_members(id, def.union_member_types())?;
                id
            }
            D::UnionTypeExtension(def) => {
                let id = self.alloc(Kind::UnionTypeExtension, def.syntax())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                self.union_members(id, def.union_member_types())?;
                id
            }
            D::EnumTypeDefinition(def) => {
                let id = self.alloc(Kind::EnumTypeDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                self.enum_values(id, def.enum_values_definition())?;
                id
            }
            D::EnumTypeExtension(def) => {
                let id = self.alloc(Kind::EnumTypeExtension, def.syntax())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                self.enum_values(id, def.enum_values_definition())?;
                id
            }
            D::InputObjectTypeDefinition(def) => {
                let id = self.alloc(Kind::InputObjectTypeDefinition, def.syntax())?;
                self.description(id, def.description())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                if let Some(fields) = def.input_fields_definition() {
                    self.input_values(id, fields.input_value_definitions(), false)?;
                }
                id
            }
            D::InputObjectTypeExtension(def) => {
                let id = self.alloc(Kind::InputObjectTypeExtension, def.syntax())?;
                self.set_name(id, def.name())?;
                self.directives(id, def.directives())?;
                if let Some(fields) = def.input_fields_definition() {
                    self.input_values(id, fields.input_value_definitions(), false)?;
                }
                id
            }
        })
    }
}

fn operation(ty: Option<cst::OperationType>) -> Built<Operation> {
    let ty = required(ty, "operation type")?;
    Ok(if ty.query_token().is_some() {
        Operation::Query
    } else if ty.mutation_token().is_some() {
        Operation::Mutation
    } else {
        Operation::Subscription
    })
}

/// Builds the AST for a document that parsed without errors.
pub fn build(document: &cst::Document, tokens: Vec<Token>) -> Built<Document> {
    let mut builder = Builder {
        tokens: &tokens,
        nodes: Vec::new(),
    };
    // graphql-js's document location runs from `<SOF>` to `<EOF>`.
    let root = builder.push(Kind::Document, 0, tokens.len() - 1);
    for definition in document.definitions() {
        let id = builder.definition(definition)?;
        builder.link(root, id);
        builder.nodes[root].items.push(id);
    }
    let nodes = builder.nodes;
    Ok(Document { tokens, nodes })
}

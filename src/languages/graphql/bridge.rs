use anyhow::{anyhow, bail};
use serde_json::{Value, json};
use std::collections::HashMap;

use super::ast::{self, Kind, Node};
use super::tokens::{self, TokenKind};
use crate::directives::{Comment, CommentKind};
use crate::text::LineIndex;

pub fn comments(text: &str) -> anyhow::Result<Vec<Comment>> {
    let index = LineIndex::new(text);
    let tokens = tokens::tokenize(&index).map_err(|_| anyhow!("Invalid GraphQL token stream"))?;
    Ok(tokens
        .into_iter()
        .filter(|token| token.kind == TokenKind::Comment)
        .map(|token| {
            let value = token.value.unwrap_or_default();
            Comment {
                kind: if value.trim_start().starts_with("eslint") {
                    CommentKind::Block
                } else {
                    CommentKind::Line
                },
                value,
                start: token.start,
                end: token.end,
            }
        })
        .collect())
}

fn fields(node: &Node) -> Value {
    let mut fields = serde_json::Map::new();
    for (key, value) in [
        ("name", node.name),
        ("alias", node.alias),
        ("description", node.description),
        ("variable", node.variable),
        ("selectionSet", node.selection_set),
        (
            if matches!(node.kind, Kind::FragmentDefinition | Kind::InlineFragment) {
                "typeCondition"
            } else {
                "type"
            },
            node.ty,
        ),
        (
            if matches!(
                node.kind,
                Kind::VariableDefinition | Kind::InputValueDefinition
            ) {
                "defaultValue"
            } else {
                "value"
            },
            node.value,
        ),
    ] {
        if let Some(value) = value {
            fields.insert(key.to_owned(), json!(value));
        }
    }
    for (key, values) in [
        ("arguments", &node.arguments),
        ("directives", &node.directives),
        ("interfaces", &node.interfaces),
        ("variableDefinitions", &node.variable_definitions),
    ] {
        fields.insert(key.to_owned(), json!(values));
    }
    let items = match node.kind {
        Kind::Document => Some("definitions"),
        Kind::SelectionSet => Some("selections"),
        Kind::ListValue | Kind::EnumTypeDefinition | Kind::EnumTypeExtension => Some("values"),
        Kind::UnionTypeDefinition | Kind::UnionTypeExtension => Some("types"),
        Kind::SchemaDefinition | Kind::SchemaExtension => Some("operationTypes"),
        Kind::DirectiveDefinition => Some("locations"),
        Kind::ObjectValue
        | Kind::ObjectTypeDefinition
        | Kind::ObjectTypeExtension
        | Kind::InterfaceTypeDefinition
        | Kind::InterfaceTypeExtension
        | Kind::InputObjectTypeDefinition
        | Kind::InputObjectTypeExtension => Some("fields"),
        _ => None,
    };
    if let Some(key) = items {
        fields.insert(key.to_owned(), json!(node.items));
    }
    Value::Object(fields)
}

/// Serialize Apollo syntax without recursively nesting large GraphQL documents.
pub fn parse(text: &str) -> anyhow::Result<Value> {
    let index = LineIndex::new(text);
    let tokens = tokens::tokenize(&index).map_err(|errors| {
        anyhow!(
            "GraphQL lexer: {} at byte {}",
            errors[0].message,
            errors[0].offset
        )
    })?;
    let tree = apollo_parser::Parser::new(text).parse();
    if let Some(error) = tree.errors().next() {
        bail!(
            "GraphQL parser: {} at byte {}",
            error.message(),
            error.index()
        );
    }
    let doc = ast::build(&tree.document(), tokens).map_err(|error| anyhow!(error.0))?;
    let nodes: Vec<_> = doc
        .nodes
        .iter()
        .map(|node| {
            json!({
                "kind": node.kind.as_str(),
                "startToken": node.start_token,
                "endToken": node.end_token,
                "fields": fields(node),
                "text": node.text,
                "operation": node.operation.map(|operation| operation.as_str()),
                "block": node.block,
                "repeatable": node.repeatable,
            })
        })
        .collect();
    let strings: HashMap<_, _> = doc
        .nodes
        .iter()
        .filter(|node| node.kind == Kind::StringValue)
        .map(|node| (doc.tokens[node.start_token].start, node.text.as_str()))
        .collect();
    let tokens: Vec<_> = doc
        .tokens
        .iter()
        .map(|token| {
            let kind = token.kind.description().trim_matches('"');
            let value = match token.kind {
                TokenKind::String | TokenKind::BlockString => strings.get(&token.start).copied(),
                _ => token.value.as_deref(),
            };
            json!({
                "kind": kind,
                "start": token.utf16_start,
                "end": token.utf16_end,
                "line": token.line,
                "column": token.column,
                "value": value,
            })
        })
        .collect();
    Ok(json!({ "nodes": nodes, "tokens": tokens }))
}

/// `--parse-graphql`: a JSON array of documents on stdin, their parse on stdout.
pub fn run() -> anyhow::Result<()> {
    let input = std::io::read_to_string(std::io::stdin().lock())?;
    print!("{}", parse_json(&input)?);
    Ok(())
}

/// The `--parse-graphql` transform as a function, for the in-process binding.
pub fn parse_json(input: &str) -> anyhow::Result<String> {
    let documents: Vec<String> = serde_json::from_str(input)?;
    let parsed = documents
        .iter()
        .map(|text| parse(text))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(serde_json::to_string(&parsed)?)
}

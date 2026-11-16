//! graphql-js's token stream, built from apollo-parser's lexer: commas and
//! whitespace are dropped, comments stay in the stream, and the stream is
//! bracketed by `<SOF>` and `<EOF>` tokens.

use apollo_parser::{Lexer, TokenKind as ApolloKind};

use crate::text::LineIndex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Sof,
    Eof,
    Bang,
    Dollar,
    Amp,
    ParenL,
    ParenR,
    Spread,
    Colon,
    Equals,
    At,
    BracketL,
    BracketR,
    BraceL,
    Pipe,
    BraceR,
    Name,
    Int,
    Float,
    String,
    BlockString,
    Comment,
}

impl TokenKind {
    /// graphql-js's `getTokenKindDesc`.
    pub fn description(self) -> &'static str {
        match self {
            Self::Sof => "<SOF>",
            Self::Eof => "<EOF>",
            Self::Bang => "\"!\"",
            Self::Dollar => "\"$\"",
            Self::Amp => "\"&\"",
            Self::ParenL => "\"(\"",
            Self::ParenR => "\")\"",
            Self::Spread => "\"...\"",
            Self::Colon => "\":\"",
            Self::Equals => "\"=\"",
            Self::At => "\"@\"",
            Self::BracketL => "\"[\"",
            Self::BracketR => "\"]\"",
            Self::BraceL => "\"{\"",
            Self::Pipe => "\"|\"",
            Self::BraceR => "\"}\"",
            Self::Name => "Name",
            Self::Int => "Int",
            Self::Float => "Float",
            Self::String => "String",
            Self::BlockString => "BlockString",
            Self::Comment => "Comment",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Token {
    pub kind: TokenKind,
    /// Byte offsets.
    pub start: usize,
    pub end: usize,
    /// UTF-16 offsets, which graphql-js locations use.
    pub utf16_start: usize,
    pub utf16_end: usize,
    /// graphql-js's one-based line and column; `<SOF>` is at line 0, column 0.
    pub line: u32,
    pub column: u32,
    /// The raw text, or the text after `#` for comments.
    pub value: Option<String>,
}

pub struct LexError {
    pub message: String,
    /// Byte offset of the error.
    pub offset: usize,
}

fn kind_of(kind: ApolloKind, data: &str) -> Option<TokenKind> {
    Some(match kind {
        ApolloKind::Whitespace | ApolloKind::Comma | ApolloKind::Eof => return None,
        ApolloKind::Comment => TokenKind::Comment,
        ApolloKind::Bang => TokenKind::Bang,
        ApolloKind::Dollar => TokenKind::Dollar,
        ApolloKind::Amp => TokenKind::Amp,
        ApolloKind::Spread => TokenKind::Spread,
        ApolloKind::Colon => TokenKind::Colon,
        ApolloKind::Eq => TokenKind::Equals,
        ApolloKind::At => TokenKind::At,
        ApolloKind::LParen => TokenKind::ParenL,
        ApolloKind::RParen => TokenKind::ParenR,
        ApolloKind::LBracket => TokenKind::BracketL,
        ApolloKind::RBracket => TokenKind::BracketR,
        ApolloKind::LCurly => TokenKind::BraceL,
        ApolloKind::RCurly => TokenKind::BraceR,
        ApolloKind::Pipe => TokenKind::Pipe,
        ApolloKind::Name => TokenKind::Name,
        ApolloKind::Int => TokenKind::Int,
        ApolloKind::Float => TokenKind::Float,
        ApolloKind::StringValue if data.starts_with("\"\"\"") => TokenKind::BlockString,
        ApolloKind::StringValue => TokenKind::String,
    })
}

pub fn tokenize(index: &LineIndex) -> Result<Vec<Token>, Vec<LexError>> {
    let text = index.text();
    let (lexed, errors) = Lexer::new(text).lex();
    if !errors.is_empty() {
        return Err(errors
            .iter()
            .map(|error| LexError {
                message: error.message().to_owned(),
                offset: error.index(),
            })
            .collect());
    }
    let mut tokens = vec![Token {
        kind: TokenKind::Sof,
        start: 0,
        end: 0,
        utf16_start: 0,
        utf16_end: 0,
        line: 0,
        column: 0,
        value: None,
    }];
    for token in lexed {
        let Some(kind) = kind_of(token.kind(), token.data()) else {
            continue;
        };
        let start = token.index();
        let end = start + token.data().len();
        let position = index.position(start);
        let value = match kind {
            TokenKind::Comment => Some(token.data()[1..].to_owned()),
            TokenKind::Name | TokenKind::Int | TokenKind::Float => Some(token.data().to_owned()),
            _ => None,
        };
        tokens.push(Token {
            kind,
            start,
            end,
            utf16_start: index.utf16_offset(start),
            utf16_end: index.utf16_offset(end),
            line: position.line,
            column: position.column + 1,
            value,
        });
    }
    let end = text.len();
    let position = index.position(end);
    let utf16_end = index.utf16_offset(end);
    tokens.push(Token {
        kind: TokenKind::Eof,
        start: end,
        end,
        utf16_start: utf16_end,
        utf16_end,
        line: position.line,
        column: position.column + 1,
        value: None,
    });
    Ok(tokens)
}

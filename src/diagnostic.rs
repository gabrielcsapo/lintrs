//! Results in ESLint's `LintResult` JSON shape, which the CI reporter,
//! `eslint-output.json` metrics and ESLint formatters consume.

use serde::{Deserialize, Serialize};

pub const WARNING: u8 = 1;
pub const ERROR: u8 = 2;

/// A replacement over UTF-16 offsets, as in ESLint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fix {
    pub range: [usize; 2],
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "textUtf16")]
    pub text_utf16: Option<Vec<u16>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub desc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    pub fix: Fix,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suppression {
    pub kind: String,
    pub justification: String,
}

/// A diagnostic in ESLint's `LintMessage` shape. Lines and columns are
/// one-based.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LintMessage {
    pub rule_id: Option<String>,
    pub severity: u8,
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub node_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    #[serde(default)]
    pub fatal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(default)]
    pub suggestions: Vec<Suggestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppressions: Option<Vec<Suppression>>,
}

impl LintMessage {
    /// A fatal parse error. ESLint reports these without a rule or end.
    pub fn fatal(message: String, line: u32, column: u32) -> Self {
        Self {
            rule_id: None,
            severity: ERROR,
            message,
            line,
            column,
            node_type: None,
            message_id: None,
            end_line: None,
            end_column: None,
            fatal: true,
            fix: None,
            suggestions: Vec::new(),
            suppressions: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintResult {
    pub file_path: String,
    pub messages: Vec<LintMessage>,
    pub suppressed_messages: Vec<LintMessage>,
    pub error_count: usize,
    pub fatal_error_count: usize,
    pub warning_count: usize,
    pub fixable_error_count: usize,
    pub fixable_warning_count: usize,
    pub used_deprecated_rules: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl LintResult {
    pub fn new(
        file_path: String,
        text: &str,
        messages: Vec<LintMessage>,
        suppressed_messages: Vec<LintMessage>,
    ) -> Self {
        let mut result = Self {
            file_path,
            messages,
            suppressed_messages,
            error_count: 0,
            fatal_error_count: 0,
            warning_count: 0,
            fixable_error_count: 0,
            fixable_warning_count: 0,
            used_deprecated_rules: Vec::new(),
            source: None,
        };
        result.recount();
        if result.error_count + result.warning_count > 0 {
            result.source = Some(text.to_owned());
        }
        result
    }

    fn recount(&mut self) {
        self.error_count = 0;
        self.fatal_error_count = 0;
        self.warning_count = 0;
        self.fixable_error_count = 0;
        self.fixable_warning_count = 0;
        for message in &self.messages {
            if message.fatal {
                self.fatal_error_count += 1;
            }
            let fixable = usize::from(message.fix.is_some());
            if message.severity == ERROR {
                self.error_count += 1;
                self.fixable_error_count += fixable;
            } else {
                self.warning_count += 1;
                self.fixable_warning_count += fixable;
            }
        }
    }

    /// Keeps only results with errors and drops their warnings, like `--quiet`.
    pub fn errors_only(mut self) -> Option<Self> {
        self.messages.retain(|message| message.severity == ERROR);
        if self.messages.is_empty() {
            return None;
        }
        self.suppressed_messages
            .retain(|message| message.severity == ERROR);
        self.recount();
        Some(self)
    }
}

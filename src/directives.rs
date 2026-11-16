//! `eslint-disable` directive handling for every language, ported from
//! ESLint 9's `apply-disable-directives.js` and its directive comment parsing
//! so existing comments suppress, and are reported as unused, exactly as
//! they did under ESLint.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::diagnostic::{ERROR, Fix, LintMessage, Suppression};
use crate::text::{LineIndex, Position};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommentKind {
    Line,
    Block,
}

/// A source comment. `value` excludes the comment markers; `start` and `end`
/// are byte offsets of the whole comment.
#[derive(Clone, Debug)]
pub struct Comment {
    pub value: String,
    pub kind: CommentKind,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirectiveType {
    Disable,
    Enable,
    DisableLine,
    DisableNextLine,
}

struct ParentDirective {
    value: String,
    rule_ids: Vec<String>,
    start: Position,
    /// Byte range of the comment.
    range: (usize, usize),
}

pub struct Directive {
    parent: usize,
    kind: DirectiveType,
    line: u32,
    column: u32,
    rule_id: Option<String>,
    justification: String,
}

/// The directives in a file and the errors found while parsing them.
pub struct Directives {
    parents: Vec<ParentDirective>,
    directives: Vec<Directive>,
    pub problems: Vec<LintMessage>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Toggle {
    Disable,
    Enable,
}

struct Expanded<'a> {
    toggle: Toggle,
    line: u32,
    column: u32,
    rule_id: Option<&'a str>,
    directive: &'a Directive,
}

static SEPARATOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s-{2,}\s").unwrap());
static LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z]+(?:-[a-z]+)*)(?:\s|$)").unwrap());
static ESLINT_DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(eslint(?:-env|-enable|-disable(?:(?:-next)?-line)?)?|exported|globals?)(?:\s|$)")
        .unwrap()
});

struct ParsedDirective<'a> {
    label: &'a str,
    value: &'a str,
    justification: &'a str,
}

fn parse_directive(text: &str) -> Option<ParsedDirective<'_>> {
    let (directive_part, justification) = match SEPARATOR.find(text) {
        Some(separator) => (
            text[..separator.start()].trim(),
            text[separator.end()..].trim(),
        ),
        None => (text.trim(), ""),
    };
    let label = LABEL.captures(directive_part)?.get(1)?;
    Some(ParsedDirective {
        label: label.as_str(),
        value: directive_part[label.end()..].trim(),
        justification,
    })
}

fn directive_type(label: &str) -> Option<DirectiveType> {
    match label {
        "eslint-disable" => Some(DirectiveType::Disable),
        "eslint-enable" => Some(DirectiveType::Enable),
        "eslint-disable-line" => Some(DirectiveType::DisableLine),
        "eslint-disable-next-line" => Some(DirectiveType::DisableNextLine),
        _ => None,
    }
}

/// Splits a rule list, dropping matching surrounding quotes from each id.
fn parse_list_config(value: &str) -> Vec<String> {
    let mut rule_ids: Vec<String> = Vec::new();
    for name in value.split(',') {
        let name = name.trim();
        let bytes = name.as_bytes();
        let unquoted = match (bytes.first(), bytes.last()) {
            (Some(&first @ (b'\'' | b'"')), Some(&last)) if bytes.len() >= 2 && first == last => {
                &name[1..name.len() - 1]
            }
            _ => name,
        };
        if !unquoted.is_empty() && !rule_ids.iter().any(|id| id == unquoted) {
            rule_ids.push(unquoted.to_owned());
        }
    }
    rule_ids
}

fn comment_problem(
    index: &LineIndex,
    comment: &Comment,
    rule_id: Option<&str>,
    message: String,
) -> LintMessage {
    let start = index.position(comment.start);
    let end = index.position(comment.end);
    LintMessage {
        rule_id: rule_id.map(str::to_owned),
        severity: ERROR,
        message,
        line: start.line,
        column: start.column + 1,
        node_type: None,
        message_id: None,
        end_line: Some(end.line),
        end_column: Some(end.column + 1),
        fatal: false,
        fix: None,
        suggestions: Vec::new(),
        suppressions: None,
    }
}

/// Collects disable directives from comments. Directives naming a rule that
/// `is_known_rule` rejects become "Definition for rule ... was not found."
/// errors, as in ESLint.
pub fn collect(
    index: &LineIndex,
    comments: &[Comment],
    language: &str,
    is_known_rule: &dyn Fn(&str) -> bool,
) -> Directives {
    let mut result = Directives {
        parents: Vec::new(),
        directives: Vec::new(),
        problems: Vec::new(),
    };
    for comment in comments {
        let Some(parsed) = parse_directive(&comment.value) else {
            continue;
        };
        if !ESLINT_DIRECTIVE.is_match(parsed.label) {
            continue;
        }
        let kind = directive_type(parsed.label);
        if comment.kind == CommentKind::Line
            && !matches!(
                kind,
                Some(DirectiveType::DisableLine | DirectiveType::DisableNextLine)
            )
        {
            continue;
        }
        let Some(kind) = kind else {
            result.problems.push(comment_problem(
                index,
                comment,
                None,
                format!(
                    "`{}` comments are not supported in {language} files.",
                    parsed.label
                ),
            ));
            continue;
        };
        let rule_ids = parse_list_config(parsed.value);
        let start = index.position(comment.start);
        let end = index.position(comment.end);
        let parent = result.parents.len();
        result.parents.push(ParentDirective {
            value: parsed.value.to_owned(),
            rule_ids: rule_ids.clone(),
            start,
            range: (comment.start, comment.end),
        });
        let targets: Vec<Option<String>> = if rule_ids.is_empty() {
            vec![None]
        } else {
            rule_ids.into_iter().map(Some).collect()
        };
        for rule_id in targets {
            if let Some(id) = rule_id.as_deref().filter(|id| !is_known_rule(id)) {
                result.problems.push(comment_problem(
                    index,
                    comment,
                    Some(id),
                    format!("Definition for rule '{id}' was not found."),
                ));
                continue;
            }
            let position = if kind == DirectiveType::DisableNextLine {
                end
            } else {
                start
            };
            result.directives.push(Directive {
                parent,
                kind,
                line: position.line,
                column: position.column + 1,
                rule_id,
                justification: parsed.justification.to_owned(),
            });
        }
    }
    result
}

fn location_key(line: u32, column: u32) -> (u32, u32) {
    (line, column)
}

struct UnusedDirective<'a> {
    description: String,
    fix: Fix,
    directive: &'a Directive,
}

impl Directives {
    fn individual_removals<'a>(
        &self,
        group: &[&Expanded<'a>],
        parent: &ParentDirective,
        index: &LineIndex,
    ) -> Vec<UnusedDirective<'a>> {
        let text = index.text();
        let list_text = parent.value.trim();
        let list_start = text[parent.range.0..]
            .find(list_text)
            .map_or(parent.range.0, |found| parent.range.0 + found);
        group
            .iter()
            .filter_map(|directive| {
                let rule_id = directive.rule_id?;
                let matched = find_listed_rule(list_text, rule_id)?;
                let matched_text = &list_text[matched.0..matched.1];
                let match_start = list_start + matched.0;
                let first_comma = matched_text.find(',');
                let last_comma = matched_text.rfind(',');
                let (start, end) = match (first_comma, last_comma) {
                    (Some(first), Some(last)) if first != last => {
                        (match_start + first, match_start + last)
                    }
                    _ => (match_start, match_start + matched_text.len()),
                };
                Some(UnusedDirective {
                    description: format!("'{rule_id}'"),
                    fix: Fix {
                        range: [index.utf16_offset(start), index.utf16_offset(end)],
                        text: String::new(),
                    },
                    directive: directive.directive,
                })
            })
            .collect()
    }

    fn process_unused<'a>(
        &self,
        unused: &[&Expanded<'a>],
        index: &LineIndex,
    ) -> Vec<UnusedDirective<'a>> {
        let mut order: Vec<usize> = Vec::new();
        let mut groups: HashMap<usize, Vec<&Expanded<'a>>> = HashMap::new();
        for &directive in unused {
            let parent = directive.directive.parent;
            groups
                .entry(parent)
                .or_insert_with(|| {
                    order.push(parent);
                    Vec::new()
                })
                .push(directive);
        }
        order
            .into_iter()
            .flat_map(|parent_index| {
                let group = &groups[&parent_index];
                let parent = &self.parents[parent_index];
                let used: HashSet<&str> = group.iter().filter_map(|d| d.rule_id).collect();
                if parent.rule_ids.iter().any(|id| !used.contains(id.as_str())) {
                    return self.individual_removals(group, parent, index);
                }
                let rule_ids: Vec<String> = group
                    .iter()
                    .filter_map(|d| d.rule_id.map(|id| format!("'{id}'")))
                    .collect();
                let description = if rule_ids.len() <= 2 {
                    rule_ids.join(" or ")
                } else {
                    format!(
                        "{}, or {}",
                        rule_ids[..rule_ids.len() - 1].join(", "),
                        rule_ids[rule_ids.len() - 1]
                    )
                };
                vec![UnusedDirective {
                    description,
                    fix: Fix {
                        range: [
                            index.utf16_offset(parent.range.0),
                            index.utf16_offset(parent.range.1),
                        ],
                        text: " ".to_owned(),
                    },
                    directive: group[0].directive,
                }]
            })
            .collect()
    }

    fn apply<'a>(
        &self,
        problems: &mut [LintMessage],
        directives: &[Expanded<'a>],
        rules_to_ignore: &HashSet<Option<&str>>,
        index: &LineIndex,
    ) -> Vec<LintMessage> {
        let mut used_disable: HashSet<usize> = HashSet::new();
        for problem in problems.iter_mut() {
            let mut disabling: Vec<usize> = Vec::new();
            for (position, directive) in directives.iter().enumerate() {
                if location_key(directive.line, directive.column)
                    > location_key(problem.line, problem.column)
                {
                    break;
                }
                if directive.rule_id.is_none() || directive.rule_id == problem.rule_id.as_deref() {
                    if directive.toggle == Toggle::Disable {
                        disabling.push(position);
                    } else {
                        disabling.clear();
                    }
                }
            }
            let Some(&last) = disabling.last() else {
                continue;
            };
            let suppressions = disabling.iter().map(|&position| Suppression {
                kind: "directive".to_owned(),
                justification: directives[position].directive.justification.clone(),
            });
            match &mut problem.suppressions {
                Some(existing) => existing.extend(suppressions),
                None => {
                    problem.suppressions = Some(suppressions.collect());
                    used_disable.insert(last);
                }
            }
        }

        let unused_disable: Vec<&Expanded> = directives
            .iter()
            .enumerate()
            .filter(|(position, d)| {
                d.toggle == Toggle::Disable
                    && !used_disable.contains(position)
                    && !rules_to_ignore.contains(&d.rule_id)
            })
            .map(|(_, d)| d)
            .collect();
        let mut unused_enable: Vec<usize> = directives
            .iter()
            .enumerate()
            .filter(|(_, d)| {
                d.directive.kind == DirectiveType::Enable && !rules_to_ignore.contains(&d.rule_id)
            })
            .map(|(position, _)| position)
            .collect();
        if !unused_enable.is_empty() {
            let used = used_enable_directives(directives);
            unused_enable.retain(|position| !used.contains(position));
        }
        let unused_enable: Vec<&Expanded> = unused_enable
            .iter()
            .map(|&position| &directives[position])
            .collect();

        let mut unused = self.process_unused(&unused_disable, index);
        unused.extend(self.process_unused(&unused_enable, index));
        unused
            .into_iter()
            .map(|UnusedDirective { description, fix, directive }| {
                let message = match (directive.kind, description.is_empty()) {
                    (DirectiveType::Enable, false) => format!(
                        "Unused eslint-enable directive (no matching eslint-disable directives were found for {description})."
                    ),
                    (DirectiveType::Enable, true) => {
                        "Unused eslint-enable directive (no matching eslint-disable directives were found).".to_owned()
                    }
                    (_, false) => format!(
                        "Unused eslint-disable directive (no problems were reported from {description})."
                    ),
                    (_, true) => {
                        "Unused eslint-disable directive (no problems were reported).".to_owned()
                    }
                };
                let start = self.parents[directive.parent].start;
                let (line, column) = if directive.kind == DirectiveType::DisableNextLine {
                    (start.line, start.column + 1)
                } else {
                    (directive.line, directive.column)
                };
                LintMessage {
                    rule_id: None,
                    severity: ERROR,
                    message,
                    line,
                    column,
                    node_type: None,
                    message_id: None,
                    end_line: None,
                    end_column: None,
                    fatal: false,
                    fix: Some(fix),
                    suggestions: Vec::new(),
                    suppressions: None,
                }
            })
            .collect()
    }

    /// Marks suppressed problems and appends unused-directive errors, matching
    /// ESLint with `reportUnusedDisableDirectives: "error"`. `problems` must
    /// be sorted by location. Directives for `ignored_rule_ids`, rules that
    /// exist but were not run, are never reported as unused.
    pub fn apply_to(
        &self,
        mut problems: Vec<LintMessage>,
        ignored_rule_ids: &HashSet<String>,
        index: &LineIndex,
    ) -> Vec<LintMessage> {
        let mut block: Vec<Expanded> = self
            .directives
            .iter()
            .filter_map(|d| {
                let toggle = match d.kind {
                    DirectiveType::Disable => Toggle::Disable,
                    DirectiveType::Enable => Toggle::Enable,
                    _ => return None,
                };
                Some(Expanded {
                    toggle,
                    line: d.line,
                    column: d.column,
                    rule_id: d.rule_id.as_deref(),
                    directive: d,
                })
            })
            .collect();
        block.sort_by_key(|d| location_key(d.line, d.column));

        let mut line: Vec<Expanded> = self
            .directives
            .iter()
            .flat_map(|d| {
                let target = match d.kind {
                    DirectiveType::DisableLine => d.line,
                    DirectiveType::DisableNextLine => d.line + 1,
                    _ => return Vec::new(),
                };
                vec![
                    Expanded {
                        toggle: Toggle::Disable,
                        line: target,
                        column: 1,
                        rule_id: d.rule_id.as_deref(),
                        directive: d,
                    },
                    Expanded {
                        toggle: Toggle::Enable,
                        line: target + 1,
                        column: 0,
                        rule_id: d.rule_id.as_deref(),
                        directive: d,
                    },
                ]
            })
            .collect();
        line.sort_by_key(|d| location_key(d.line, d.column));

        let mut rules_to_ignore: HashSet<Option<&str>> = ignored_rule_ids
            .iter()
            .map(|id| Some(id.as_str()))
            .collect();
        // A directive without rule ids can't be judged unused if any rule was skipped.
        if !rules_to_ignore.is_empty() {
            rules_to_ignore.insert(None);
        }

        let block_unused = self.apply(&mut problems, &block, &rules_to_ignore, index);
        let line_unused = self.apply(&mut problems, &line, &rules_to_ignore, index);
        problems.extend(block_unused);
        problems.extend(line_unused);
        problems.sort_by_key(|p| location_key(p.line, p.column));
        problems
    }
}

/// ESLint's `(?:^|\s*,\s*)(['"]?)<ruleId>\1(?:\s*,\s*|$)`, without
/// backreferences: the earliest match wins, preferring a quoted id.
fn find_listed_rule(list_text: &str, rule_id: &str) -> Option<(usize, usize)> {
    let escaped = regex::escape(rule_id);
    ["'", "\"", ""]
        .iter()
        .filter_map(|quote| {
            Regex::new(&format!(
                r"(?:^|\s*,\s*){quote}{escaped}{quote}(?:\s*,\s*|$)"
            ))
            .ok()?
            .find(list_text)
            .map(|found| (found.start(), found.end()))
        })
        .min_by_key(|&(start, _)| start)
}

fn used_enable_directives(directives: &[Expanded]) -> HashSet<usize> {
    let mut enabled: Vec<(Option<&str>, usize)> = Vec::new();
    let mut used = HashSet::new();
    for (position, directive) in directives.iter().enumerate().rev() {
        if directive.toggle == Toggle::Disable {
            if enabled.is_empty() {
                continue;
            }
            match directive.rule_id {
                None => {
                    used.extend(enabled.iter().map(|&(_, enable)| enable));
                    enabled.clear();
                }
                Some(id) => {
                    let enable = enabled
                        .iter()
                        .find(|(rule, _)| *rule == Some(id))
                        .or_else(|| enabled.iter().find(|(rule, _)| rule.is_none()));
                    if let Some(&(_, enable)) = enable {
                        used.insert(enable);
                    }
                }
            }
        } else if directive.rule_id.is_none() {
            enabled.clear();
            enabled.push((None, position));
        } else if let Some(entry) = enabled
            .iter_mut()
            .find(|(rule, _)| *rule == directive.rule_id)
        {
            entry.1 = position;
        } else {
            enabled.push((directive.rule_id, position));
        }
    }
    used
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_labels_values_and_justifications() {
        let parsed = parse_directive(" eslint-disable-next-line a, 'b' -- why").unwrap();
        assert_eq!(parsed.label, "eslint-disable-next-line");
        assert_eq!(parse_list_config(parsed.value), vec!["a", "b"]);
        assert_eq!(parsed.justification, "why");
    }

    #[test]
    fn keeps_unbalanced_quotes() {
        assert_eq!(parse_list_config("'a, \"b\", '"), vec!["'a", "b", "'"]);
    }

    #[test]
    fn finds_quoted_rules_in_lists() {
        assert_eq!(find_listed_rule("a, 'b', c", "b"), Some((1, 8)));
        assert_eq!(find_listed_rule("a", "a"), Some((0, 1)));
        assert_eq!(find_listed_rule("ab", "a"), None);
    }
}

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use serde::Deserialize;

use crate::diagnostic::{LintMessage, LintResult};
use crate::directives::{self, Comment, CommentKind};
use crate::text::LineIndex;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFile {
    file_path: PathBuf,
    text: String,
    messages: Vec<LintMessage>,
    used_deprecated_rules: Vec<serde_json::Value>,
    skipped_rules: HashSet<String>,
    no_inline_config: bool,
    report_unused_disable_directives: u8,
    report_unused_inline_configs: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOutput {
    files: Vec<HostFile>,
    known_rules: HashSet<String>,
}

pub fn finalize(output: HostOutput) -> anyhow::Result<Vec<LintResult>> {
    output
        .files
        .into_iter()
        .map(|file| finalize_file(file, &output.known_rules))
        .collect()
}

fn source_comments(file_path: &Path, text: &str) -> anyhow::Result<Vec<Comment>> {
    let allocator = Allocator::default();
    if file_path
        .extension()
        .is_some_and(|extension| extension == "graphql")
    {
        crate::languages::graphql::bridge::comments(text)
    } else {
        let parsed = Parser::new(&allocator, text, SourceType::from_path(file_path)?).parse();
        if !parsed.diagnostics.is_empty() {
            bail!(
                "cannot finalize {}: Oxc rejected the source",
                file_path.display()
            );
        }
        Ok(parsed
            .program
            .comments
            .iter()
            .map(|comment| Comment {
                value: text
                    [comment.content_span().start as usize..comment.content_span().end as usize]
                    .to_owned(),
                kind: if comment.is_line() {
                    CommentKind::Line
                } else {
                    CommentKind::Block
                },
                start: comment.span.start as usize,
                end: comment.span.end as usize,
            })
            .collect())
    }
}

/// `--host-comments`: sources on stdin, their comments on stdout.
pub fn parse_comments() -> anyhow::Result<()> {
    let input = std::io::read_to_string(std::io::stdin().lock())?;
    print!("{}", parse_comments_json(&input)?);
    Ok(())
}

/// The `--host-comments` transform as a function, for the in-process binding.
pub fn parse_comments_json(input: &str) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Source {
        file_path: PathBuf,
        text: String,
    }
    let sources: Vec<Source> = serde_json::from_str(input)?;
    let comments = sources.into_iter().map(|source| {
        let index = LineIndex::with_js_line_terminators(&source.text, true);
        source_comments(&source.file_path, &source.text).map(|comments| comments.into_iter().map(|comment| {
            let start = index.position(comment.start);
            let end = index.position(comment.end);
            serde_json::json!({
                "type": if comment.kind == CommentKind::Block { "Block" } else { "Line" },
                "value": comment.value,
                "range": [index.utf16_offset(comment.start), index.utf16_offset(comment.end)],
                "loc": { "start": { "line": start.line, "column": start.column }, "end": { "line": end.line, "column": end.column } },
            })
        }).collect::<Vec<_>>())
    }).collect::<anyhow::Result<Vec<_>>>()?;
    Ok(serde_json::to_string(&comments)?)
}

/// The `--finalize-host` transform as a function, for the in-process binding.
pub fn finalize_json(input: &str) -> anyhow::Result<String> {
    crate::output::json(&finalize(serde_json::from_str(input)?)?)
}

fn finalize_file(file: HostFile, known_rules: &HashSet<String>) -> anyhow::Result<LintResult> {
    let is_graphql = file
        .file_path
        .extension()
        .is_some_and(|extension| extension == "graphql");
    let comments = source_comments(&file.file_path, &file.text)?;
    for comment in &comments {
        let value = comment.value.trim();
        if (comment.kind == CommentKind::Block
            && (value.starts_with("global ")
                || value.starts_with("globals ")
                || value.starts_with("exported ")))
            || (file.no_inline_config && value.starts_with("eslint-"))
        {
            bail!(
                "unsupported inline configuration in {} at byte {}; unused-inline severity {}",
                file.file_path.display(),
                comment.start,
                file.report_unused_inline_configs
            );
        }
    }
    let index = LineIndex::with_js_line_terminators(&file.text, !is_graphql);
    let disable_comments: Vec<_> = comments
        .iter()
        .filter(|comment| !comment.value.trim().starts_with("eslint "))
        .cloned()
        .collect();
    let directives = directives::collect(
        &index,
        &disable_comments,
        if is_graphql { "GraphQL" } else { "TypeScript" },
        &|id| known_rules.contains(id),
    );
    let mut all = directives.problems.clone();
    all.extend(file.messages);
    all.sort_by_key(|message| (message.line, message.column));
    let messages: Vec<_> = directives
        .apply_to(all, &file.skipped_rules, &index)
        .into_iter()
        .filter_map(|mut message| {
            if message.rule_id.is_none()
                && (message
                    .message
                    .starts_with("Unused eslint-disable directive")
                    || message
                        .message
                        .starts_with("Unused eslint-enable directive"))
            {
                if file.report_unused_disable_directives == 0 {
                    return None;
                }
                message.severity = file.report_unused_disable_directives;
            }
            Some(message)
        })
        .collect();
    let (suppressed, messages): (Vec<_>, Vec<_>) = messages
        .into_iter()
        .partition(|message| message.suppressions.is_some());
    let mut result = LintResult::new(
        file.file_path.to_string_lossy().into_owned(),
        &file.text,
        messages,
        suppressed,
    );
    result.used_deprecated_rules = file.used_deprecated_rules;
    Ok(result)
}

fn select_host_dir(candidates: &[PathBuf]) -> anyhow::Result<PathBuf> {
    let mut tried = Vec::new();
    for candidate in candidates {
        let script = candidate.join("cli.mjs");
        if script.is_file() {
            return Ok(candidate.clone());
        }
        tried.push(script);
    }
    bail!(
        "cannot find the JavaScript rule host; tried: {}",
        tried
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn host_dir() -> anyhow::Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(directory) = std::env::var("LINTRS_HOST_DIR") {
        candidates.push(PathBuf::from(directory));
    }
    // <prefix>/bin/lintrs resolves the installed host at <prefix>/host.
    if let Ok(executable) = std::env::current_exe()
        && let Ok(canonical) = executable.canonicalize()
        && let Some(prefix) = canonical.parent().and_then(Path::parent)
    {
        candidates.push(prefix.join("host"));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("host"));
    select_host_dir(&candidates)
}

pub fn run(
    config: &Path,
    paths: &[PathBuf],
    quiet: bool,
    json: bool,
    concurrency: &str,
) -> anyhow::Result<bool> {
    let script = host_dir()?.join("cli.mjs");
    let mut command = Command::new("node");
    command
        .args([
            "--conditions=@typescript/source",
            "--experimental-transform-types",
        ])
        .arg(script)
        .arg("--config")
        .arg(config);
    if quiet {
        command.arg("--quiet");
    }
    command.args(["--concurrency", concurrency]);
    if json {
        command.args(["--format", "json"]);
    }
    command.arg("--").args(paths);
    command.env("LINTRS_BINARY", std::env::current_exe()?);
    // The native layout ships lib/liblintrs.node next to bin/lintrs; point the
    // host at it so typed services and native rules work without env setup.
    if std::env::var_os("LINTRS_IN_PROCESS_BINDING").is_none()
        && let Ok(executable) = std::env::current_exe()
        && let Ok(canonical) = executable.canonicalize()
        && let Some(bin) = canonical.parent()
    {
        let binding = bin.join("../lib/liblintrs.node");
        if binding.exists() {
            command.env("LINTRS_IN_PROCESS_BINDING", binding);
            if std::env::var_os("LINTRS_TYPED_NATIVE").is_none() {
                command.env("LINTRS_TYPED_NATIVE", "1");
            }
        }
    }
    let status = command
        .stdin(Stdio::null())
        .status()
        .context("starting JavaScript rule runtime")?;
    match status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => bail!("ESLint-compatible rule host failed: {status}"),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::select_host_dir;

    #[test]
    fn host_dir_prefers_candidates_in_order() {
        let root = tempfile::tempdir().unwrap();
        let env_dir = root.path().join("env-host");
        let prefix_host = root.path().join("prefix/host");
        let manifest_host = root.path().join("repo/host");
        for directory in [&env_dir, &prefix_host, &manifest_host] {
            fs::create_dir_all(directory).unwrap();
        }
        let candidates = vec![env_dir.clone(), prefix_host.clone(), manifest_host.clone()];
        assert!(select_host_dir(&candidates).is_err());
        fs::write(manifest_host.join("cli.mjs"), "").unwrap();
        assert_eq!(select_host_dir(&candidates).unwrap(), manifest_host);
        fs::write(prefix_host.join("cli.mjs"), "").unwrap();
        assert_eq!(select_host_dir(&candidates).unwrap(), prefix_host);
        fs::write(env_dir.join("cli.mjs"), "").unwrap();
        assert_eq!(select_host_dir(&candidates).unwrap(), env_dir);
        assert!(
            select_host_dir(&[PathBuf::from("definitely-missing")])
                .unwrap_err()
                .to_string()
                .contains("definitely-missing")
        );
    }
}

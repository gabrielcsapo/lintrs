use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, ValueEnum};

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    /// ESLint's `unix` formatter.
    Unix,
    /// ESLint's `LintResult[]` JSON.
    Json,
}

/// Runs unchanged ESLint-compatible rules with Rust parsing and type services.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// Flat-config module. Defaults to `eslint.config.mjs`.
    #[arg(short, long)]
    config: Option<PathBuf>,
    /// Finalize JSON diagnostics emitted by the JavaScript rule host.
    #[arg(long, hide = true)]
    finalize_host: bool,
    #[arg(short, long, value_enum, default_value = "unix")]
    format: Format,
    /// Run only error-level rules and report only errors.
    #[arg(long)]
    quiet: bool,
    /// Files or directories to lint.
    #[arg(default_value = ".")]
    paths: Vec<PathBuf>,
}

fn run(cli: &Cli) -> anyhow::Result<bool> {
    if cli.finalize_host {
        let files = serde_json::from_reader(std::io::stdin().lock())?;
        let results = rlint::host::finalize(files)?;
        print!("{}", rlint::output::json(&results)?);
        return Ok(false);
    }
    let config_path = cli
        .config
        .clone()
        .unwrap_or_else(|| PathBuf::from("eslint.config.mjs"));
    rlint::host::run(
        &config_path,
        &cli.paths,
        cli.quiet,
        matches!(cli.format, Format::Json),
    )
}

fn main() -> ExitCode {
    if std::env::args().any(|argument| argument == "--host-comments") {
        return match rlint::host::parse_comments() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("rlint comment parser: {error:#}");
                ExitCode::from(2)
            }
        };
    }
    if std::env::args().any(|argument| argument == "--parse-graphql") {
        return match rlint::languages::graphql::bridge::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("rlint GraphQL parser: {error:#}");
                ExitCode::from(2)
            }
        };
    }
    if std::env::args().any(|argument| argument == "--api") {
        return match rlint::type_api::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("rlint type API: {error:#}");
                ExitCode::from(2)
            }
        };
    }
    let cli = Cli::parse();
    match run(&cli) {
        Ok(false) => ExitCode::SUCCESS,
        Ok(true) => ExitCode::from(1),
        Err(error) => {
            eprintln!("rlint: {error:#}");
            ExitCode::from(2)
        }
    }
}

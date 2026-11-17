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
    /// Lint in parallel worker threads: a positive count, `auto`, or `off`.
    #[arg(long, value_name = "n|auto|off", default_value = "off", allow_hyphen_values = true, value_parser = parse_concurrency)]
    concurrency: Concurrency,
    /// Files or directories to lint.
    #[arg(default_value = ".")]
    paths: Vec<PathBuf>,
}

/// ESLint's `--concurrency` values: `off`, `auto`, or a positive integer.
#[derive(Clone)]
enum Concurrency {
    Off,
    Auto,
    Count(usize),
}

impl Concurrency {
    fn as_host_arg(&self) -> String {
        match self {
            Self::Off => "off".to_owned(),
            Self::Auto => "auto".to_owned(),
            Self::Count(count) => count.to_string(),
        }
    }
}

fn parse_concurrency(value: &str) -> Result<Concurrency, String> {
    match value {
        "off" => Ok(Concurrency::Off),
        "auto" => Ok(Concurrency::Auto),
        _ => value
            .parse::<usize>()
            .ok()
            .filter(|count| *count > 0)
            .map(Concurrency::Count)
            .ok_or_else(|| {
                format!("expected a positive integer, `auto`, or `off`, found `{value}`")
            }),
    }
}

fn run(cli: &Cli) -> anyhow::Result<bool> {
    if cli.finalize_host {
        let input = std::io::read_to_string(std::io::stdin().lock())?;
        print!("{}", lintrs::host::finalize_json(&input)?);
        return Ok(false);
    }
    let config_path = cli
        .config
        .clone()
        .unwrap_or_else(|| PathBuf::from("eslint.config.mjs"));
    lintrs::host::run(
        &config_path,
        &cli.paths,
        cli.quiet,
        matches!(cli.format, Format::Json),
        &cli.concurrency.as_host_arg(),
    )
}

fn main() -> ExitCode {
    if std::env::args().any(|argument| argument == "--host-comments") {
        return match lintrs::host::parse_comments() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("lintrs comment parser: {error:#}");
                ExitCode::from(2)
            }
        };
    }
    if std::env::args().any(|argument| argument == "--parse-graphql") {
        return match lintrs::languages::graphql::bridge::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("lintrs GraphQL parser: {error:#}");
                ExitCode::from(2)
            }
        };
    }
    if std::env::args().any(|argument| argument == "--api") {
        return match lintrs::type_api::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("lintrs type API: {error:#}");
                ExitCode::from(2)
            }
        };
    }
    let cli = Cli::parse();
    match run(&cli) {
        Ok(false) => ExitCode::SUCCESS,
        Ok(true) => ExitCode::from(1),
        Err(error) => {
            eprintln!("lintrs: {error:#}");
            ExitCode::from(2)
        }
    }
}

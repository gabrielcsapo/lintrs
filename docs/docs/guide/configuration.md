# Configuration

lintrs loads a flat config module: `eslint.config.mjs` in the current
directory, or `-c <file>`. It reads the default export (or the export named by
`LINTRS_CONFIG_EXPORT`).

## Supported

- `files` / `ignores`, global ignores, per-file overrides
- `plugins`: JavaScript plugins and [native rule plugins](./packaging)
- `rules` with severities and options
- `languageOptions`: `parserOptions.projectService` / `project` / `programs` / `lintrsProjects`, `globals`,
  `parser`
- `linterOptions.reportUnusedDisableDirectives` and `reportUnusedInlineConfigs`
- inline `/* eslint rule: setting */` comments
- `eslint-disable`, `eslint-disable-next-line`, `eslint-enable`, with `--`
  justifications

Rules use the standard `create(context)` API. Typed rules get
`@typescript-eslint`-compatible `parserServices`.

For `parserOptions.programs`, lintrs selects the first program containing each
file and reconstructs its root files, compiler options, and project references
with the Rust checker. Files must exist on disk; custom compiler hosts and
in-memory source overrides are not reproduced. Referenced projects need their
built declaration outputs. Rules see the TypeScript enum layout installed in
the linted project, with lintrs's bundled TypeScript as a fallback.

Lintrs-specific configurations can provide `parserOptions.lintrsProjects`
instead of constructing JavaScript TypeScript programs. Each entry contains
absolute `fileNames`, TypeScript compiler `options` with numeric enum values, and optional
`projectReferences`, as returned by TypeScript's config-file helpers. Lintrs
selects the first entry listing the linted file as a root, preserves these
inputs, and constructs the program in Rust. Explicit metadata takes precedence
over project discovery, including when `project` and `projectService` are false.
Files outside every entry fail the run. This option is specific to Lintrs;
ESLint still requires real `parserOptions.programs` when using provided programs.
The host gives each metadata object a stable identity so resolver cache keys
stay compact. Its fields and JSON representation remain available to rules;
the original configuration objects are not mutated.

Every enabled rule runs on every file it covers. lintrs never runs oxlint's
built-in rules and ignores `oxlint-disable` comments.

## Enforcing native rule coverage

Pass `--require-native` to reject enabled JavaScript rules in the effective
configuration of every selected file, including rules enabled by inline
comments. Disabled rules do not block the run; with `--quiet`, warning rules
do not block it either. GraphQL files are rejected because they use JavaScript
rules. The check applies to rules executed by lintrs; a separate syntax lint
stage needs its own coverage check.

## Parallel configuration

With `--concurrency`, the main thread discovers candidate paths and each worker
resolves its own file configurations. Workers retain those configurations for
linting, including inline rule settings. All workers finish preparation before
the main thread builds the selected native rule libraries and starts parsing.
This avoids resolving every file's configuration serially and keeps Cargo
processes ahead of Oxlint's large parser allocations. Unmatched files and empty
worker slices do not produce lint results; a run with no configured files fails.

Before matching, lintrs removes file patterns whose literal path prefixes cannot
contain any candidate path. ESLint still performs the actual glob matches,
ignore checks, configuration merges and validation. Function patterns, escaped
patterns and prefixes containing glob syntax are retained conservatively.

## Module compilation cache

The CLI enables Node's module compilation cache before loading the lint host.
It flushes compiled modules before starting workers and shares the cache
directory with them. Each process still initializes its modules, resolves
configuration and runs every applicable lint check; lint results are not cached.

The default directory is `node-compile` under `LINTRS_CACHE_DIR`, or under
`~/.cache/lintrs` when that variable is unset. `NODE_COMPILE_CACHE` selects an
explicit directory, and `NODE_DISABLE_COMPILE_CACHE=1` disables caching. The
CLI leaves implicit caching disabled when `NODE_V8_COVERAGE` is set. An unusable
cache directory does not prevent linting.

Measure empty-cache and warm-cache runs separately: creating bytecode can add
work to the first run. Reuse a cache directory across fresh processes to measure
warm startup, and use `NODE_DISABLE_COMPILE_CACHE=1` for a control.

## File coverage reports

Use `--files-report <path>` to write a JSON array containing every linted file
path. It includes clean files hidden by `--quiet`, so consumers can check file
coverage independently of diagnostic output. An incomplete run does not write a
report; use a fresh destination for each run.

## Not supported

These fail with an error:

- multiple matches for `parserOptions.project`
- processors
- inline global/exported configuration comments
- symlinked discovery paths

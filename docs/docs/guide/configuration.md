# Configuration

lintrs loads a flat config module: `eslint.config.mjs` in the current
directory, or `-c <file>`. It reads the default export (or the export named by
`LINTRS_CONFIG_EXPORT`).

## Supported

- `files` / `ignores`, global ignores, per-file overrides
- `plugins`: JavaScript plugins and [native rule plugins](./packaging)
- `rules` with severities and options
- `languageOptions`: `parserOptions.projectService` / `project`, `globals`,
  `parser`
- `linterOptions.reportUnusedDisableDirectives` and `reportUnusedInlineConfigs`
- inline `/* eslint rule: setting */` comments
- `eslint-disable`, `eslint-disable-next-line`, `eslint-enable`, with `--`
  justifications

Rules use the standard `create(context)` API. Typed rules get
`@typescript-eslint`-compatible `parserServices`.

Every enabled rule runs on every file it covers. lintrs never runs oxlint's
built-in rules and ignores `oxlint-disable` comments.

## Not supported

These fail with an error:

- multiple explicit TypeScript projects
- prebuilt JavaScript programs
- processors
- inline global/exported configuration comments
- symlinked discovery paths

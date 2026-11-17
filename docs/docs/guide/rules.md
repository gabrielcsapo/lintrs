# Rules

A rule is a rule. Whether it's written in JavaScript or Rust, it is enabled,
configured (severity, options, per-file overrides), suppressed
(`eslint-disable`), and reported exactly the same way — in the same
`eslint.config.mjs`, under the same `plugin/rule` id convention.

## Where rules run

| Files                            | JS rules                                     | Rust rules                    |
| -------------------------------- | -------------------------------------------- | ----------------------------- |
| `.ts` / `.tsx` in a project      | ✓ typed via `parserServices`                 | ✓ same checker                |
| `.js` / `.jsx` / `.mjs` / `.cjs` | ✓                                            | TypeScript project files only |
| `.graphql`                       | ✓ incl. schema-aware `@graphql-eslint` rules | ✗ not supported               |

## Which to write

- **JavaScript** for portability and to keep using existing plugins. Rules
  use ESLint's `create(context)` API; see [Limitations](./limitations) for gaps.
- **Rust** for checker-heavy hot rules — they share the program and checker
  and skip the JS rule runtime. See [Benchmarks](/benchmarks).

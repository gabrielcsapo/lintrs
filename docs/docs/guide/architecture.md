# How it works

```mermaid
flowchart TB
  accTitle: How lintrs runs a lint
  accDescr: The Rust CLI reads eslint.config.mjs, runs your JavaScript rules in a Node host and your Rust rules against a shared tsrs type checker, then finalizes every diagnostic in Rust.

  config[/"eslint.config.mjs"/]:::file
  config --> cli(["lintrs CLI<br/><small>Rust binary</small>"]):::rust

  subgraph node ["Node.js"]
    host(["Node host"]):::js
    host --> rules["oxlint JS rule host<br/><small>your ESLint rules</small>"]:::js
  end

  subgraph rust ["Rust"]
    tsrs[("tsrs session<br/><small>program + checker</small>")]:::rust
    native["Native rule libraries<br/><small>nativePlugin crates, dlopen'd</small>"]:::rust
    tsrs ~~~ native
  end

  cli -- "oxlint.json<br/>(plugins: [])" --> host
  cli --> tsrs
  rules -. "typed queries<br/>(parserServices)" .-> tsrs
  native -- "lintrsRunNativeRules" --> tsrs
  rules -- "JSON diagnostics" --> finalize
  native -- "diagnostics" --> finalize
  finalize["Rust finalize<br/><small>eslint-disable · unused directives<br/>--quiet · unix / json output</small>"]:::rust
```

- **Parsing.** oxc parses each file once. The ESTree AST goes to oxlint's
  rule host; rules run unchanged, with fixes, suggestions, selectors, scopes
  and code paths. Syntax-only runs create no checker.
- **Types.** `parserServices` holds the program, node maps and a checker
  proxied to tsrs. Queries batch by node kind per file; caches live until the
  project's last file.
- **Dependencies.** Resolved from prebuilt declarations, not sources.
  Listing `Program.getSourceFiles()` filenames fetches no ASTs.
- **Native rules.** `dlopen`ed libraries link against the shared `liblintrs`:
  one copy of lintrs and tsrs, verified by the ABI fingerprint and a probe
  static.
- **Reporting.** JS and Rust diagnostics share one finalize step:
  `eslint-disable`, unused directives, `--quiet`, output.

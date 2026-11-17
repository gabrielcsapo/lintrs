# Environment variables

## Locations

| Variable                    | Effect                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `LINTRS_BINARY`             | `lintrs` binary the host uses for subprocess work. Set by the binary itself.                    |
| `LINTRS_HOST_DIR`           | Directory with `cli.mjs` and the other `host/*.mjs` modules.                                    |
| `LINTRS_TSRS_SDK`           | tsrs `npm/tsrs` SDK directory (with `package.json` and `src/`). Skips auto-detection and Cargo. |
| `LINTRS_NATIVE_HOME`        | Native layout directory (`lib/` with `liblintrs.*` and `liblintrs.node`).                       |
| `LINTRS_IN_PROCESS_BINDING` | Absolute path to a `.node` copy of `liblintrs`. Uses the in-process binding, not the pipe.      |
| `LINTRS_SDK_DIR`            | Rule-crate SDK directory (`sdk/deps`), instead of `<prefix>/sdk`.                               |
| `LINTRS_CACHE_DIR`          | Cache for source-built rule crates. Default: `~/.cache/lintrs`.                                 |

## Execution

| Variable                | Effect                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `LINTRS_OXLINT_THREADS` | Parser threads per worker under `--concurrency`.                                                                       |
| `TIMING`                | `1`, `all` or a count: per-rule timing table on stderr, as ESLint's `TIMING`. See [Profiling rules](/guide/profiling). |
| `LINTRS_TYPE_PROFILE`   | Path to write type-service timings and the per-rule summary (JSON).                                                    |
| `LINTRS_NATIVE_DEBUG`   | `1` logs native-rule dispatch to stderr.                                                                               |

## Typed native session

| Variable                      | Effect                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `LINTRS_TYPED_NATIVE`         | `1` enables the native typed session for the in-process binding.                            |
| `LINTRS_LAZY_OBJECTS`         | `1` defers native object materialization. Needs `LINTRS_TYPED_NATIVE`.                      |
| `LINTRS_LAZY_PREFETCH`        | `1` prefetches lazy object facts.                                                           |
| `LINTRS_ADAPTIVE_FACTS`       | `1` fuses fact fetches by learned access plans. Needs lazy objects.                         |
| `LINTRS_COMPACT_DECLARATIONS` | `1` uses compact declaration handles. Needs the eager typed binding; not with lazy objects. |
| `LINTRS_FUSED_SYMBOLS`        | `1` fuses symbol queries. Same requirements as compact declarations.                        |
| `LINTRS_TRUE_BULK`            | `1` enables the bulk native query path.                                                     |
| `LINTRS_CONTEXTUAL_BATCH`     | `1` batches contextual type queries. Needs `LINTRS_TYPED_NATIVE` and `LINTRS_TRUE_BULK`.    |

## Internal

| Variable                | Effect                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| `LINTRS_SHARED_SESSION` | Token `--concurrency` workers use to attach to the shared session. |
| `LINTRS_CONFIG_EXPORT`  | Named config export to read. Set by workers.                       |
| `LINTRS_TEST_BINARY`    | Binary the host tests drive. Default: `target/debug/lintrs`.       |

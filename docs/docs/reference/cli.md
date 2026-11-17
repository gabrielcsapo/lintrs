# CLI

```txt
lintrs [--config <file>] [--format unix|json] [--quiet] [--concurrency <n|auto|off>] [paths...]
```

| Flag                           | Meaning                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `-c`, `--config <file>`        | Flat-config module. Default: `eslint.config.mjs`.                                                                    |
| `-f`, `--format <fmt>`         | `unix` (ESLint's unix formatter, default) or `json` (`LintResult[]`).                                                |
| `--quiet`                      | Run only error-level rules; report only errors.                                                                      |
| `--concurrency <n\|auto\|off>` | Lint in parallel worker threads that share one type-checker session. `auto` uses ESLint's heuristic. Default: `off`. |
| `--version`                    | Print the version.                                                                                                   |
| `paths...`                     | Files or directories. Default: `.`.                                                                                  |

| Exit code | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `0`       | No error-severity messages.                                                  |
| `1`       | At least one error-severity message.                                         |
| `2`       | Engine failure (config, parse, transport, host). Never falls back to ESLint. |

```sh
lintrs --config eslint.config.mjs src/**/*.ts
lintrs -c eslint.config.mjs -f json src/**/*.ts > eslint-output.json
lintrs --quiet src
lintrs --concurrency auto src
```

## Profiling

Set `TIMING`, as with ESLint, to see where the time goes. The table is
written to **stderr**, so the lint results on stdout are unchanged and
`-f json` stays parseable.

```sh
TIMING=1 lintrs src                       # slowest 10 rules
TIMING=all lintrs src                     # every rule
TIMING=25 lintrs -f json src > out.json   # slowest 25; results still in out.json
```

Output for `typescript-eslint` `recommendedTypeChecked` on date-fns (1,228
files), trimmed to the slowest five rules and adapter entries:

```txt
Rule                                              | Time (ms) | Relative | Lang | Own (ms) | Adapter (ms) | Checker (ms) | Crossing (ms) | Calls | Node maps (ms)
:-------------------------------------------------|----------:|---------:|:-----|---------:|-------------:|-------------:|--------------:|------:|--------------:
@typescript-eslint/no-misused-promises            |   875.695 |    29.5% | js   |  196.642 |      344.327 |      154.407 |       154.387 | 20593 |         25.932
@typescript-eslint/no-unsafe-assignment           |   759.745 |    25.6% | js   |  122.970 |      209.243 |      234.376 |       147.468 |  5470 |         45.688
@typescript-eslint/unbound-method                 |   240.277 |     8.1% | js   |   30.801 |       72.280 |       51.644 |        83.982 |  3487 |          1.572
@typescript-eslint/no-unsafe-argument             |   218.648 |     7.4% | js   |   39.808 |       68.853 |       35.307 |        64.865 | 12380 |          9.813
@typescript-eslint/no-unnecessary-type-assertion  |   210.924 |     7.1% | js   |   79.633 |       69.093 |       19.104 |        40.251 |  5016 |          2.843

Phase                                           | Time (ms) | Of wall
:-----------------------------------------------|----------:|-------:
Rules (all)                                     |  2968.504 |   60.5%
Type services setup                             |   152.917 |    3.1%
Project build                                   |    52.477 |    1.1%
Outside rules                                   |     3.517 |    0.1%
Unattributed (parse, traversal, config, output) |  1733.147 |   35.3%

Adapter entry                     | Time (ms) | Of adapter |  Calls | Avg (µs)
:---------------------------------|----------:|-----------:|-------:|--------:
wrap                              |   174.783 |      19.5% | 202835 |     0.86
checker.getTypeAtLocation         |   130.059 |      14.5% |  88644 |     1.47
get node.initializer              |    55.132 |       6.2% |  38739 |     1.42
checker.getContextualType         |    54.148 |       6.1% |  44252 |     1.22
get type.flags                    |    30.584 |       3.4% | 367104 |     0.08

Wall time: 4910.561 ms. Time = Own + Adapter + Checker + Crossing + Node maps; Checker is Rust compute, Crossing the JS/Rust boundary.
```

The first three columns match ESLint's `TIMING` table. The rest split each
rule's time:

| Column           | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `Lang`           | `js` for JavaScript rules, `rust` for [Rust rules](/guide/rust-rules).      |
| `Own (ms)`       | The rule's own code.                                                        |
| `Adapter (ms)`   | lintrs' TypeScript-compatibility layer, working on the rule's behalf.       |
| `Checker (ms)`   | Type-checker work, measured in Rust.                                        |
| `Crossing (ms)`  | Moving the rule's checker requests and results between JavaScript and Rust. |
| `Calls`          | Checker requests the rule made.                                             |
| `Node maps (ms)` | Mapping ESTree nodes to TypeScript nodes and back.                          |

The last table lists the adapter's busiest entries: property reads
(`get node.initializer`), checker or object methods
(`checker.getTypeAtLocation`) and `wrap`, each with its calls and average
cost.

Reading the example: `no-misused-promises` spends more time in the adapter
than in its own logic, and its many small requests cost about as much to move
across as the checker spends answering them. In the adapter, `get
node.initializer` averages 1.42 µs per read against 0.08 µs for `get
type.flags`, which points at that read as the one to look at. See [Profiling rules](/guide/profiling) for every
column, phase and the JSON output.

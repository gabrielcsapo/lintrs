// lintrs benchmark: interleaved repeated runs per suite; wall time, peak RSS, parity vs ESLint.
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const repo = resolve(import.meta.dirname, "..");
const bench = join(import.meta.dirname, ".work");
const target = join(bench, "date-fns");
const native = join(repo, "target/lintrs-native");
const { values } = parseArgs({
  options: {
    out: { type: "string", default: join(repo, "docs/bench/results.json") },
  },
});
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Run the benchmark with Node.js 24 or newer");
const node24 = dirname(process.execPath);
const toolchain = /channel\s*=\s*"([^"]+)"/u.exec(
  readFileSync(join(repo, "rust-toolchain.toml"), "utf8"),
)[1];
const runs = Number(process.env.RUNS ?? 7);
const baseEnv = {
  ...process.env,
  PATH: `${node24}:${process.env.PATH}`,
  LINTRS_HOST_DIR: join(repo, "host"),
};
const inProcess = binding => ({
  LINTRS_IN_PROCESS_BINDING: binding,
  LINTRS_TYPED_NATIVE: "1",
  LINTRS_TRUE_BULK: "1",
  LINTRS_CONTEXTUAL_BATCH: "1",
});
const nativeEnv = {
  ...inProcess(join(native, "lib/liblintrs.node")),
  LINTRS_CACHE_DIR: join(bench, "cache"),
  RUSTUP_TOOLCHAIN: toolchain,
};
const eslint = join(repo, "node_modules/.bin/eslint");
const eslintArgs = config => [
  "--no-config-lookup",
  "-c",
  config,
  "-f",
  "json",
  "src/**/*.ts",
];
const lintrsArgs = config => ["-c", config, "-f", "json", "src"];

const suites = [
  {
    id: "typescript-eslint",
    title: "typescript-eslint recommendedTypeChecked",
    description: "An existing typed ESLint config, unchanged.",
    config:
      "typescript-eslint recommendedTypeChecked on src/**/*.ts (tests excluded), parserOptions.project",
    scenarios: [
      {
        id: "eslint",
        name: "ESLint",
        description: "eslint CLI, no cache",
        command: eslint,
        args: eslintArgs("eslint.config.mjs"),
        env: {},
      },
      {
        id: "lintrs",
        name: "lintrs",
        description:
          "lintrs CLI, default transport (tsrs session in a child process)",
        command: join(native, "bin/lintrs"),
        args: lintrsArgs("eslint.config.mjs"),
        env: {},
      },
      {
        id: "lintrs-in-process",
        name: "lintrs (in-process)",
        description: "lintrs CLI with the in-process Node-API binding",
        command: join(native, "bin/lintrs"),
        args: lintrsArgs("eslint.config.mjs"),
        env: inProcess(join(native, "lib/liblintrs.node")),
      },
    ],
  },
  {
    id: "custom-typed-rule",
    title: "One custom typed rule: JS vs Rust",
    description:
      "A single rule that asks the checker for the type of every call expression and reports unions, written once in JS and once in Rust.",
    config:
      "bench/call-returns-union on src/**/*.ts (tests excluded), parserOptions.project",
    scenarios: [
      {
        id: "eslint-js",
        name: "ESLint (JS rule)",
        description: "eslint CLI running the JS rule",
        command: eslint,
        args: eslintArgs("eslint.calls-js.mjs"),
        env: {},
      },
      {
        id: "lintrs-js",
        name: "lintrs (JS rule)",
        description: "lintrs in-process running the same JS rule",
        command: join(native, "bin/lintrs"),
        args: lintrsArgs("eslint.calls-js.mjs"),
        env: nativeEnv,
      },
      {
        id: "lintrs-rust",
        name: "lintrs (Rust rule)",
        description:
          "lintrs in-process running the rule written in Rust (library already built and cached)",
        command: join(native, "bin/lintrs"),
        args: lintrsArgs("eslint.calls-native.mjs"),
        env: nativeEnv,
      },
    ],
  },
];

function once(s) {
  const r = spawnSync("/usr/bin/time", ["-l", s.command, ...s.args], {
    cwd: target,
    env: { ...baseEnv, ...s.env },
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 1)
    throw new Error(`${s.id} exited ${r.status}\n${r.stderr.slice(-2000)}`);
  const results = JSON.parse(r.stdout);
  return {
    wallMs: Number(/([\d.]+) real/u.exec(r.stderr)[1]) * 1000,
    peakRssMB:
      Number(/(\d+)\s+maximum resident set size/u.exec(r.stderr)[1]) / 2 ** 20,
    messages: results.reduce((n, f) => n + f.messages.length, 0),
    results,
  };
}
const stats = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)],
    min: s[0],
    max: s.at(-1),
    samples: xs,
  };
};
// file:line:column:rule -> that rule's messages there, sorted, so several
// messages at one position compare as a set instead of the last one winning.
const keyed = results => {
  const map = new Map();
  for (const f of results)
    for (const m of f.messages) {
      const key = `${f.filePath.replace(/.*\/src\//u, "")}:${m.line}:${m.column}:${m.ruleId}`;
      map.set(key, [...(map.get(key) ?? []), m.message]);
    }
  for (const [key, messages] of map) map.set(key, messages.sort().join("\n"));
  return map;
};

function runSuite(suite) {
  const samples = Object.fromEntries(suite.scenarios.map(s => [s.id, []]));
  const outputs = {};
  for (const s of suite.scenarios) {
    const w = once(s);
    outputs[s.id] = w.results;
    process.stderr.write(
      `${suite.id} warmup ${s.id} ${w.wallMs.toFixed(0)}ms\n`,
    );
  }
  for (let round = 0; round < runs; round++)
    for (let i = 0; i < suite.scenarios.length; i++) {
      const s = suite.scenarios[(i + round) % suite.scenarios.length];
      const r = once(s);
      samples[s.id].push(r);
      process.stderr.write(
        `${suite.id} round ${round} ${s.id} ${r.wallMs.toFixed(0)}ms ${r.peakRssMB.toFixed(0)}MB\n`,
      );
    }
  const [baseline, ...others] = suite.scenarios;
  const ref = keyed(outputs[baseline.id]);
  const parity = Object.fromEntries(
    others.map(s => {
      const other = keyed(outputs[s.id]);
      const differing = [...ref.keys()].filter(
        k => other.has(k) && other.get(k) !== ref.get(k),
      );
      return [
        s.id,
        {
          onlyBaseline: [...ref.keys()].filter(k => !other.has(k)).length,
          onlyThis: [...other.keys()].filter(k => !ref.has(k)).length,
          messageTextDifferences: differing.length,
          // Up to five differing messages, so a difference can be diagnosed
          // from results.json (only present when there are any).
          ...(differing.length === 0
            ? {}
            : {
                examples: differing.slice(0, 5).map(location => ({
                  location,
                  baseline: ref.get(location),
                  [s.id]: other.get(location),
                })),
              }),
        },
      ];
    }),
  );
  return {
    id: suite.id,
    title: suite.title,
    description: suite.description,
    config: suite.config,
    baseline: baseline.id,
    files: outputs[baseline.id].length,
    scenarios: suite.scenarios.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      messages: samples[s.id][0].messages,
      wallMs: stats(samples[s.id].map(r => r.wallMs)),
      peakRssMB: stats(samples[s.id].map(r => r.peakRssMB)),
    })),
    parity,
  };
}

const pkg = name =>
  JSON.parse(
    readFileSync(join(repo, "node_modules", name, "package.json"), "utf8"),
  ).version;
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const out = {
  generatedAt: new Date().toISOString(),
  machine: {
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
  },
  versions: {
    node: execFileSync(join(node24, "node"), ["-v"], {
      encoding: "utf8",
    }).trim(),
    lintrs: `${git(repo, "rev-parse", "--short", "HEAD")}${git(repo, "status", "--porcelain") ? "+working-tree" : ""}`,
    eslint: pkg("eslint"),
    "typescript-eslint": pkg("typescript-eslint"),
    typescript: pkg("typescript"),
    oxlint: pkg("oxlint"),
    tsrs: "c21a36ef",
  },
  target: {
    repo: "https://github.com/date-fns/date-fns",
    ref: "v4.1.0",
    commit: git(target, "rev-parse", "HEAD"),
  },
  method: {
    runs,
    warmups: 1,
    interleaved: true,
    timer: "/usr/bin/time -l (wall-clock 'real' and maximum resident set size)",
    cache:
      "ESLint --cache off; lintrs's Rust rule library prebuilt in its cache before timing",
  },
  suites: suites.map(runSuite),
};
writeFileSync(values.out, JSON.stringify(out, null, 2) + "\n");
for (const suite of out.suites)
  console.log(
    suite.id,
    JSON.stringify(
      suite.scenarios.map(s => [
        s.id,
        s.wallMs.median,
        s.wallMs.min,
        s.wallMs.max,
        Math.round(s.peakRssMB.median),
        s.messages,
      ]),
    ),
    JSON.stringify(suite.parity),
  );

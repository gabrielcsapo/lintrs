import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "./test-support/temporary.mjs";

import { tsrsSdkRoot } from "./type-services/sdk.mjs";

const root = resolve(import.meta.dirname, "..");
const examples = join(root, "examples", "rules");
const docs = join(root, "docs", "docs");
const nativeBin = join(root, "target/lintrs-native/bin/lintrs");
const nativeBinding = join(root, "target/lintrs-native/lib/liblintrs.node");
const haveNative = existsSync(nativeBin) && existsSync(nativeBinding);
const skipNative =
  !haveNative && process.env.CI === undefined ? "native build missing" : false;

const sdk = haveNative ? tsrsSdkRoot(root) : undefined;

function project(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "lintrs-example-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = temporaryDirectory("lintrs-cache-");
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  for (const entry of readdirSync(join(root, "node_modules"))) {
    if (entry.startsWith(".")) continue;
    const source = join(root, "node_modules", entry);
    try {
      symlinkSync(source, join(dir, "node_modules", entry), "dir");
    } catch {}
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        module: "nodenext",
        skipLibCheck: true,
      },
      include: ["**/*.ts"],
    }),
  );
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return { dir, cache };
}

function run(dir, cache, args, { native = false, env = {} } = {}) {
  return spawnSync(nativeBin, args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ...(native
        ? {
            LINTRS_TSRS_SDK: sdk,
            LINTRS_IN_PROCESS_BINDING: nativeBinding,
            LINTRS_TYPED_NATIVE: "1",
            LINTRS_CACHE_DIR: cache,
          }
        : {}),
      ...env,
    },
  });
}

const typedSource = `declare function pick(flag: boolean): string | number;
declare function answer(): number;
pick(true);
answer();
`;

function typescriptConfig(pluginSource) {
  return `import ts from 'typescript-eslint';
import example from ${JSON.stringify(pluginSource)};
export default [{ files: ['**/*.ts'], plugins: { '@typescript-eslint': ts.plugin, example },
 languageOptions: { parser: ts.parser, parserOptions: { projectService: true } },
 rules: { 'example/call-returns-union': 'error' } }];\n`;
}

test(
  "typescript-js example reports the union-returning call",
  { skip: skipNative },
  t => {
    const { dir, cache } = project(t, {
      "sample.ts": typedSource,
      "eslint.config.mjs": typescriptConfig(
        join(examples, "typescript-js/index.mjs"),
      ),
    });
    const result = run(dir, cache, ["-f", "json", "sample.ts"], {
      native: true,
    });
    assert.equal(result.status, 1, result.stderr);
    const [file] = JSON.parse(result.stdout);
    assert.deepEqual(
      file.messages.map(message => [
        message.ruleId,
        message.line,
        message.column,
        message.message,
      ]),
      [["example/call-returns-union", 3, 1, "Call returns a union type"]],
    );
  },
);

test(
  "typescript-rust example reports identical diagnostics to the JS rule",
  { skip: skipNative },
  t => {
    const { dir, cache } = project(t, {
      "sample.ts": typedSource,
      "eslint.config.mjs": typescriptConfig(
        join(examples, "typescript-rust/index.mjs"),
      ),
    });
    const result = run(dir, cache, ["-f", "json", "sample.ts"], {
      native: true,
    });
    assert.equal(result.status, 1, result.stderr);
    const [file] = JSON.parse(result.stdout);
    assert.deepEqual(
      file.messages.map(message => [
        message.ruleId,
        message.line,
        message.column,
        message.message,
      ]),
      [["example/call-returns-union", 3, 1, "Call returns a union type"]],
    );
  },
);

// TIMING on the native layout: the compute clock splits checker calls into
// Rust work and the crossing, and Rust-timed native rules get their own rows.
const timingRow = (stderr, rule) =>
  stderr
    .split("\n")
    .find(line => line.startsWith(`${rule} `))
    ?.split("|")
    .map(cell => cell.trim());

test(
  "TIMING lists the JS example with a checker/crossing split",
  { skip: skipNative },
  t => {
    const { dir, cache } = project(t, {
      "sample.ts": typedSource,
      "eslint.config.mjs": typescriptConfig(
        join(examples, "typescript-js/index.mjs"),
      ),
    });
    const result = run(dir, cache, ["-f", "json", "sample.ts"], {
      native: true,
      env: { TIMING: "all" },
    });
    assert.equal(result.status, 1, result.stderr);
    const row = timingRow(result.stderr, "example/call-returns-union");
    assert.ok(row, result.stderr);
    const [, time, , lang, own, adapter, checker, crossing, calls, nodeMaps] =
      row;
    assert.equal(lang, "js");
    assert.ok(Number(calls) > 0, result.stderr);
    assert.notEqual(
      crossing,
      "-",
      "the in-process binding splits checker time",
    );
    const parts =
      Number(own) +
      Number(adapter) +
      Number(checker) +
      Number(crossing) +
      Number(nodeMaps);
    assert.ok(Math.abs(parts - Number(time)) < 0.01, result.stderr);
    assert.match(result.stderr, /Checker is Rust compute/u);
  },
);

test("TIMING times the Rust example rule in Rust", { skip: skipNative }, t => {
  const { dir, cache } = project(t, {
    "sample.ts": typedSource,
    "eslint.config.mjs": typescriptConfig(
      join(examples, "typescript-rust/index.mjs"),
    ),
  });
  const plain = run(dir, cache, ["-f", "json", "sample.ts"], {
    native: true,
  });
  const timed = run(dir, cache, ["-f", "json", "sample.ts"], {
    native: true,
    env: { TIMING: "all" },
  });
  assert.equal(timed.status, 1, timed.stderr);
  assert.equal(timed.stdout, plain.stdout);
  const row = timingRow(timed.stderr, "example/call-returns-union");
  assert.ok(row, timed.stderr);
  const [, time, , lang, own, adapter, checker, crossing, calls] = row;
  assert.equal(lang, "rust");
  assert.ok(Number(time) > 0);
  assert.equal(own, time);
  assert.deepEqual(
    [adapter, checker, crossing, calls],
    ["0.000", "0.000", "0.000", "0"],
  );
  assert.match(timed.stderr, /^Native rules \(Rust\): dispatch\s+\|/mu);
});

test(
  "graphql-js example lints operations through a custom rule",
  { skip: skipNative },
  t => {
    const { dir, cache } = project(t, {
      "ops.graphql": `query GoodQuery { greeting }
query Bad { greeting }
mutation DoThingMutation { greeting }
{ greeting }
`,
      "eslint.config.mjs": `import plugin from '@graphql-eslint/eslint-plugin';
import example from ${JSON.stringify(join(examples, "graphql-js/index.mjs"))};
export default [{ files: ['**/*.graphql'], plugins: { '@graphql-eslint': plugin, example },
 languageOptions: { parser: plugin.parser, parserOptions: { schemaSdl: 'type Query { greeting: String } type Mutation { greeting: String }' } },
 rules: { 'example/operation-name-suffix': 'error' } }];\n`,
    });
    const result = run(dir, cache, ["-f", "json", "ops.graphql"]);
    assert.equal(result.status, 1, result.stderr);
    const [file] = JSON.parse(result.stdout);
    assert.deepEqual(
      file.messages.map(message => [
        message.ruleId,
        message.line,
        message.column,
        message.message,
      ]),
      [
        [
          "example/operation-name-suffix",
          2,
          1,
          '"Bad" should end with "Query"',
        ],
      ],
    );
  },
);

// Docs code blocks marked `<!-- example: examples/rules/<path> -->` must
// contain exactly that file's content; every example file must be embedded.
test("docs example blocks match the example sources", () => {
  const pattern =
    /<!--\s*example:\s*(examples\/rules\/\S+)\s*-->\s*\n+```[^\n]*\n([\s\S]*?)```/gu;
  const referenced = new Set();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.mdx?$/u.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(pattern)) {
          const example = match[1];
          const file = join(root, example);
          assert.ok(
            existsSync(file),
            `${path}: example file not found: ${example}`,
          );
          referenced.add(example);
          assert.equal(
            match[2].replace(/\n$/u, ""),
            readFileSync(file, "utf8").replace(/\n$/u, ""),
            `${path}: code block out of sync with ${example}`,
          );
        }
      }
    }
  };
  walk(docs);
  const files = [];
  const collect = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "target") collect(path);
      else if (entry.isFile() && entry.name !== "Cargo.lock") files.push(path);
    }
  };
  collect(examples);
  const unreferenced = files.filter(
    file => !referenced.has(file.slice(root.length + 1)),
  );
  assert.deepEqual(unreferenced, [], "example files not embedded in docs");
});

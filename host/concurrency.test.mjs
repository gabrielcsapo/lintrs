// `--concurrency <n|auto|off>` end-to-end through the built lintrs binary:
// parallel runs must produce byte-identical diagnostics to `off`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { workerCount } from "./parallel.mjs";

const root = resolve(import.meta.dirname, "..");
const nativeBin = join(root, "target/lintrs-native/bin/lintrs");
const nativeBinding = join(root, "target/lintrs-native/lib/liblintrs.node");
const haveNative = existsSync(nativeBin) && existsSync(nativeBinding);
const skipNative =
  !haveNative && process.env.CI === undefined ? "native build missing" : false;

function tsrsSdk() {
  const target = /^host: (.+)$/mu.exec(
    spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout,
  )?.[1];
  const metadata = JSON.parse(
    spawnSync(
      "cargo",
      [
        "metadata",
        "--locked",
        "--offline",
        "--filter-platform",
        target,
        "--format-version",
        "1",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ).stdout,
  );
  const dep = metadata.packages.find(item => item.name === "tsrs_api");
  return resolve(dirname(dep.manifest_path), "../../npm/tsrs");
}

const sdk = haveNative ? tsrsSdk() : undefined;

test("workerCount follows ESLint's heuristic", () => {
  assert.equal(workerCount(0, "auto", 8), 1);
  assert.equal(workerCount(1, "auto", 8), 1);
  assert.equal(workerCount(50, "auto", 8), 1);
  assert.equal(workerCount(51, "auto", 8), 2);
  assert.equal(workerCount(101, "auto", 8), 3);
  assert.equal(workerCount(500, "auto", 8), 4); // capped at cpus / 2
  assert.equal(workerCount(1000, "auto", 4), 2);
  assert.equal(workerCount(10, "off", 8), 1);
  assert.equal(workerCount(10, 3, 8), 3);
  assert.equal(workerCount(2, 5, 8), 2); // never more workers than files
});

test(
  "--concurrency produces identical diagnostics to off",
  { skip: skipNative },
  t => {
    const dir = mkdtempSync(join(tmpdir(), "lintrs-concurrency-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cache = mkdtempSync(join(tmpdir(), "lintrs-cache-"));
    t.after(() => rmSync(cache, { recursive: true, force: true }));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    for (const entry of readdirSync(join(root, "node_modules"))) {
      if (entry.startsWith(".")) continue;
      try {
        symlinkSync(
          join(root, "node_modules", entry),
          join(dir, "node_modules", entry),
          "dir",
        );
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
        include: ["src/**/*.ts"],
      }),
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    // Enough files that `auto` picks more than one worker, with types
    // flowing across file boundaries so slices need cross-file types.
    const count = 60;
    for (let i = 0; i < count; i += 1) {
      const next =
        i + 1 < count ? `import type { T${i + 1} } from "./f${i + 1}";\n` : "";
      const debug = i % 10 === 0 ? "debugger;\n" : "";
      writeFileSync(
        join(dir, "src", `f${i}.ts`),
        `${next}export type T${i} = ${i + 1 < count ? `T${i + 1} | ` : ""}string;
export const v${i}: T${i} = "x";
async function run${i}() { await v${i}; }
run${i}();
${debug}`,
      );
    }
    // Code-unit and locale order disagree here ("Zeta" < "alpha" by code
    // unit), so output order must not depend on --concurrency.
    for (const name of ["Zeta", "alpha"])
      writeFileSync(join(dir, "src", `${name}.ts`), "debugger;\n");
    writeFileSync(
      join(dir, "src", "ops.graphql"),
      `query GoodQuery { greeting }\nquery Bad { greeting }\n`,
    );
    writeFileSync(
      join(dir, "eslint.config.mjs"),
      `import ts from 'typescript-eslint';
import graphql from '@graphql-eslint/eslint-plugin';
export default [
 { files: ['src/**/*.ts'], plugins: { '@typescript-eslint': ts.plugin },
   languageOptions: { parser: ts.parser, parserOptions: { projectService: true } },
   rules: { '@typescript-eslint/await-thenable': 'error', 'no-debugger': 'error' } },
 { files: ['src/**/*.graphql'], plugins: { '@graphql-eslint': graphql },
   languageOptions: { parser: graphql.parser, parserOptions: { schemaSdl: 'type Query { greeting: String }' } },
   rules: { '@graphql-eslint/require-operation-name-suffix': 'off' } },
];\n`,
    );

    const env = {
      ...process.env,
      LINTRS_TSRS_SDK: sdk,
      LINTRS_IN_PROCESS_BINDING: nativeBinding,
      LINTRS_TYPED_NATIVE: "1",
      LINTRS_CACHE_DIR: cache,
    };
    const run = args =>
      spawnSync(nativeBin, args, {
        cwd: dir,
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });

    const off = run(["-f", "json", "src"]);
    assert.equal(off.status, 1, `${off.stderr}\n${off.stdout}`);
    const baseline = JSON.parse(off.stdout);
    assert.ok(baseline.length >= count);
    for (const value of ["2", "3", "auto"]) {
      const result = run(["-f", "json", "--concurrency", value, "src"]);
      assert.equal(result.status, 1, `concurrency ${value}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), baseline);
    }

    const quietOff = run(["-f", "json", "--quiet", "src"]);
    const quietParallel = run([
      "-f",
      "json",
      "--quiet",
      "--concurrency",
      "2",
      "src",
    ]);
    assert.equal(quietOff.status, quietParallel.status);
    assert.deepEqual(
      JSON.parse(quietParallel.stdout),
      JSON.parse(quietOff.stdout),
    );

    for (const value of ["0", "-1", "fast"]) {
      const invalid = run(["--concurrency", value, "src"]);
      assert.equal(invalid.status, 2, `value ${value}`);
      assert.match(invalid.stderr, /concurrency/iu);
    }
  },
);

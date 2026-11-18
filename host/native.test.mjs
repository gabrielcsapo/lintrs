import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readdirSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "./test-support/temporary.mjs";

import { tsrsSdkRoot } from "./type-services/sdk.mjs";

import { platformKey } from "./native/build.mjs";
import { NativeRuleTester } from "./native/index.mjs";

const root = resolve(import.meta.dirname, "..");
const nativeBin = join(root, "target/lintrs-native/bin/lintrs");
const nativeBinding = join(root, "target/lintrs-native/lib/liblintrs.node");
const fixtureCrate = join(root, "fixtures/native/demo-rules");
const haveNative = existsSync(nativeBin) && existsSync(nativeBinding);
// In CI the native build is produced by an earlier step; missing is a failure.
const skipNative =
  !haveNative && process.env.CI === undefined ? "native build missing" : false;
const nodeDir = dirname(process.execPath);

const sdk = haveNative ? tsrsSdkRoot(root) : undefined;

// A temp lint project: package.json + tsconfig + the repo's runtime deps
// linked in, plus a generated eslint.config.mjs.
function project(t, { config, files, crates } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lintrs-native-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = temporaryDirectory("lintrs-cache-");
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  for (const entry of [
    "eslint",
    "oxlint",
    "typescript",
    "typescript-eslint",
    "@eslint",
    "@oxlint",
    "@typescript-eslint",
    "espree",
  ]) {
    const source = join(root, "node_modules", entry);
    if (existsSync(source))
      symlinkSync(source, join(dir, "node_modules", entry), "dir");
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
  for (const [name, source] of Object.entries(files ?? {})) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  const crateDir = crates === undefined ? undefined : join(dir, "crate");
  if (crateDir !== undefined)
    cpSync(fixtureCrate, crateDir, { recursive: true });
  writeFileSync(
    join(dir, "eslint.config.mjs"),
    config({ dir, cache, crateDir: crateDir ?? fixtureCrate }),
  );
  return { dir, cache };
}

function run(dir, cache, args, { restricted = false, env = {} } = {}) {
  return spawnSync(nativeBin, args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...(restricted
        ? { PATH: `${nodeDir}:/usr/bin:/bin`, HOME: process.env.HOME }
        : process.env),
      LINTRS_TSRS_SDK: sdk,
      LINTRS_IN_PROCESS_BINDING: nativeBinding,
      LINTRS_TYPED_NATIVE: "1",
      LINTRS_CACHE_DIR: cache,
      RUSTUP_TOOLCHAIN: "1.96.0",
      ...env,
    },
  });
}

test("native rules", { skip: skipNative }, async t => {
  await t.test(
    "prebuilt platform package runs without a toolchain",
    async t => {
      const { dir, cache } = project(t, {
        files: {
          "case.ts": 'let value = "hello";\nconst ok: number = 1;\n',
        },
        config: ({ dir, cache, crateDir }) => {
          // Build the platform package first (toolchain available here).
          const key = platformKey();
          const packaged = spawnSync(
            process.execPath,
            [
              join(root, "host/native/build.mjs"),
              crateDir,
              "--out",
              join(dir, "node_modules", `demo-rules-${key}`),
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                LINTRS_CACHE_DIR: cache,
                RUSTUP_TOOLCHAIN: "1.96.0",
              },
            },
          );
          if (packaged.status !== 0) throw new Error(packaged.stderr);
          return `import { nativePlugin } from ${JSON.stringify(
            `file://${join(root, "host/native/index.mjs")}`,
          )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"],
  prebuilt: { ${JSON.stringify(platformKey())}: ${JSON.stringify(`demo-rules-${platformKey()}`)} } });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`;
        },
      });
      const result = run(dir, cache, ["-f", "json", "case.ts"], {
        restricted: true,
      });
      assert.equal(result.status, 1, result.stderr);
      const [file] = JSON.parse(result.stdout);
      assert.equal(file.messages[0].ruleId, "demo/value-is-string");
      assert.equal(file.messages[0].line, 1);
      assert.equal(file.errorCount, 1);
    },
  );

  await t.test("crate build caches; edits rebuild", async t => {
    const { dir, cache } = project(t, {
      crates: true,
      files: {
        "case.ts": 'let value = "hello";\n',
        "plugin.mjs": "",
      },
      config: ({ dir, cache, crateDir }) => {
        writeFileSync(
          join(dir, "plugin.mjs"),
          `import { nativePlugin } from ${JSON.stringify(
            `file://${join(root, "host/native/index.mjs")}`,
          )};
export default nativePlugin({ name: "demo",
 rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });\n`,
        );
        return `import demo from "./plugin.mjs";
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`;
      },
    });
    const first = run(dir, cache, ["-f", "json", "case.ts"]);
    assert.equal(first.status, 1, first.stderr);
    const entry = join(
      cache,
      "native-rules",
      (await import("node:fs")).readdirSync(join(cache, "native-rules"))[0],
    );
    const log = statSync(join(entry, "build.log")).mtimeMs;
    // Cache hit: works even with no toolchain on PATH.
    const second = run(dir, cache, ["-f", "json", "case.ts"], {
      restricted: true,
    });
    assert.equal(second.status, 1, second.stderr);
    assert.equal(statSync(join(entry, "build.log")).mtimeMs, log);
    // Editing the crate produces a fresh cache entry.
    const lib = join(dir, "crate", "src", "lib.rs");
    writeFileSync(
      lib,
      readFileSync(lib, "utf8").replace("has type string", "is a string"),
    );
    const third = run(dir, cache, ["-f", "json", "case.ts"]);
    assert.equal(third.status, 1, third.stderr);
    const entries = (await import("node:fs")).readdirSync(
      join(cache, "native-rules"),
    );
    assert.equal(entries.length, 2);
    const [file] = JSON.parse(third.stdout);
    assert.equal(file.messages[0].message, "identifier 'value' is a string");
  });

  await t.test(
    "crate build selects the fingerprint rustc through rustup",
    async t => {
      const rustup = spawnSync("rustup", ["--version"], {
        encoding: "utf8",
      });
      if (rustup.error !== undefined || rustup.status !== 0)
        return t.skip("rustup is not installed");
      const cache = temporaryDirectory("lintrs-cache-");
      t.after(() => rmSync(cache, { recursive: true, force: true }));
      const env = { ...process.env, LINTRS_CACHE_DIR: cache };
      // Anywhere but this repo: no rust-toolchain.toml applies, so a default
      // toolchain that predates the fingerprint would fail without rustup.
      delete env.RUSTUP_TOOLCHAIN;
      const result = spawnSync(
        process.execPath,
        [join(root, "host/native/build.mjs"), fixtureCrate],
        { cwd: tmpdir(), env, encoding: "utf8", stdio: "pipe" },
      );
      if (result.status !== 0)
        assert.match(result.stderr, /rustup toolchain install/u);
      else assert.match(result.stdout, /\.(?:dylib|so)\b/u);
    },
  );

  await t.test(
    "mixed JS + native rules; native-only files skip JS",
    async t => {
      const profile = join(
        temporaryDirectory("lintrs-profile-"),
        "profile.json",
      );
      const { dir, cache } = project(t, {
        files: {
          "mixed.ts": 'let value = "x";\nconsole.log("y");\n',
          "native-only.ts": 'let value = "z";\n',
        },
        config: ({ crateDir }) => `import ts from "typescript-eslint";
import { nativePlugin } from ${JSON.stringify(
          `file://${join(root, "host/native/index.mjs")}`,
        )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"],
 plugins: { "@typescript-eslint": ts.plugin, demo },
 languageOptions: { parser: ts.parser, parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } },
 { files: ["mixed.ts"], rules: { "@typescript-eslint/no-unused-vars": "off", "no-console": "error" } }];\n`,
      });
      const result = run(dir, cache, [
        "-f",
        "json",
        "mixed.ts",
        "native-only.ts",
      ]);
      assert.equal(result.status, 1, result.stderr);
      const files = JSON.parse(result.stdout);
      const mixed = files.find(f => f.filePath.endsWith("mixed.ts"));
      const nativeOnly = files.find(f => f.filePath.endsWith("native-only.ts"));
      assert.ok(mixed.messages.some(m => m.ruleId === "demo/value-is-string"));
      assert.ok(mixed.messages.some(m => m.ruleId === "no-console"));
      assert.ok(
        nativeOnly.messages.every(m => m.ruleId === "demo/value-is-string"),
      );
    },
  );

  await t.test("native-only files are recorded with jsSkipped", async t => {
    const profileDir = temporaryDirectory("lintrs-profile-");
    t.after(() => rmSync(profileDir, { recursive: true, force: true }));
    const profile = join(profileDir, "profile.json");
    const { dir, cache } = project(t, {
      files: { "case.ts": 'let value = "x";\n' },
      config: ({ crateDir }) => `import { nativePlugin } from ${JSON.stringify(
        `file://${join(root, "host/native/index.mjs")}`,
      )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`,
    });
    const result = spawnSync(nativeBin, ["-f", "json", "case.ts"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        LINTRS_TSRS_SDK: sdk,
        LINTRS_IN_PROCESS_BINDING: nativeBinding,
        LINTRS_TYPED_NATIVE: "1",
        LINTRS_CACHE_DIR: cache,
        RUSTUP_TOOLCHAIN: "1.96.0",
        LINTRS_TYPE_PROFILE: profile,
      },
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(profile, "utf8"));
    assert.equal(report.nativeRules.length, 1);
    assert.equal(report.nativeRules[0].jsSkipped, true);
    assert.equal(report.nativeRules[0].rules, 1);
  });

  await t.test("options, fix, suggestions, UTF-16 columns", async t => {
    const { dir, cache } = project(t, {
      crates: true,
      files: {
        "fix.ts": '// ünïcödé 😀\nconst s = "é"; const oldName = 1;\n',
      },
      config: ({ crateDir }) => `import { nativePlugin } from ${JSON.stringify(
        `file://${join(root, "host/native/index.mjs")}`,
      )};
const demo = nativePlugin({ name: "demo", rules: ["rename-value", "suggest-rename", "no-non-ascii-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: {
   "demo/rename-value": ["error", { "match": "oldName", "replacement": "newName" }],
   "demo/suggest-rename": ["warn", { "match": "oldName", "replacement": "renamed" }],
   "demo/no-non-ascii-string": "error" } }];\n`,
    });
    const result = run(dir, cache, ["-f", "json", "fix.ts"]);
    assert.equal(result.status, 1, result.stderr);
    const [file] = JSON.parse(result.stdout);
    // Every expectation is derived from the JS (UTF-16) source so non-ASCII
    // on a previous line (incl. an astral char) and earlier on the same
    // line would expose byte/UTF-16 confusion in the native boundary.
    const source = readFileSync(join(dir, "fix.ts"), "utf8");
    const lineStart = source.indexOf("\n") + 1;
    const col = index => index - lineStart + 1;
    const rename = file.messages.find(m => m.ruleId === "demo/rename-value");
    const nameStart = source.indexOf("oldName");
    const nameEnd = nameStart + "oldName".length;
    assert.equal(rename.line, 2);
    assert.equal(rename.column, col(nameStart));
    assert.equal(rename.endLine, 2);
    assert.equal(rename.endColumn, col(nameEnd));
    assert.deepEqual(rename.fix.range, [nameStart, nameEnd]);
    assert.equal(rename.fix.text, "newName");
    const fixed =
      source.slice(0, rename.fix.range[0]) +
      rename.fix.text +
      source.slice(rename.fix.range[1]);
    assert.equal(fixed.includes("const newName = 1;"), true);
    const suggest = file.messages.find(m => m.ruleId === "demo/suggest-rename");
    assert.equal(suggest.severity, 1);
    assert.equal(suggest.suggestions[0].desc, "Replace with 'renamed'");
    assert.deepEqual(suggest.suggestions[0].fix.range, [nameStart, nameEnd]);
    const nonAscii = file.messages.find(
      m => m.ruleId === "demo/no-non-ascii-string",
    );
    const literalStart = source.indexOf('"é"');
    const literalEnd = literalStart + '"é"'.length;
    assert.equal(nonAscii.line, 2);
    assert.equal(nonAscii.column, col(literalStart));
    assert.equal(nonAscii.endLine, 2);
    assert.equal(nonAscii.endColumn, col(literalEnd));
    // --quiet keeps only errors.
    const quiet = run(dir, cache, ["--quiet", "-f", "json", "fix.ts"]);
    const [quietFile] = JSON.parse(quiet.stdout);
    assert.ok(
      quietFile.messages.every(m => m.ruleId !== "demo/suggest-rename"),
    );
  });

  await t.test(
    "eslint-disable and unused-disable directives apply",
    async t => {
      const { dir, cache } = project(t, {
        files: {
          "case.ts":
            '// eslint-disable-next-line demo/value-is-string\nlet value = "x";\n// eslint-disable-next-line demo/value-is-string\nconst n = 1;\n',
        },
        config: ({
          crateDir,
        }) => `import { nativePlugin } from ${JSON.stringify(
          `file://${join(root, "host/native/index.mjs")}`,
        )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 linterOptions: { reportUnusedDisableDirectives: "error" },
 rules: { "demo/value-is-string": "error" } }];\n`,
      });
      const result = run(dir, cache, ["-f", "json", "case.ts"]);
      assert.equal(result.status, 1, result.stderr);
      const [file] = JSON.parse(result.stdout);
      assert.ok(
        file.messages.every(
          m => m.ruleId === null || m.message.includes("Unused"),
        ),
        JSON.stringify(file.messages),
      );
    },
  );

  await t.test("failure modes", async t => {
    // ABI mismatch.
    const { dir, cache } = project(t, {
      files: { "case.ts": 'let value = "x";\n' },
      config: ({ dir, cache, crateDir }) => {
        const pkg = join(dir, "node_modules", `demo-rules-${platformKey()}`);
        mkdirSync(pkg, { recursive: true });
        cpSync(fixtureCrate, join(dir, "src-crate"), { recursive: true });
        const packaged = spawnSync(
          process.execPath,
          [
            join(root, "host/native/build.mjs"),
            join(dir, "src-crate"),
            "--out",
            pkg,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              LINTRS_CACHE_DIR: cache,
              RUSTUP_TOOLCHAIN: "1.96.0",
            },
          },
        );
        if (packaged.status !== 0) throw new Error(packaged.stderr);
        const manifest = JSON.parse(
          readFileSync(join(pkg, "package.json"), "utf8"),
        );
        manifest.lintrs.abi = "lintrs/0.0.0/tsrs-deadbeef/rustc-0.0.0/fake";
        writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
        return `import { nativePlugin } from ${JSON.stringify(
          `file://${join(root, "host/native/index.mjs")}`,
        )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"],
  prebuilt: { ${JSON.stringify(platformKey())}: ${JSON.stringify(`demo-rules-${platformKey()}`)} } });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`;
      },
    });
    const bad = run(dir, cache, ["-f", "json", "case.ts"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /was built for ABI|matching your lintrs/u);

    // Cache miss with no toolchain.
    const miss = run(dir, cache, ["-f", "json", "case.ts"], {
      restricted: true,
    });
    assert.equal(miss.status, 2);
    // (prebuilt resolution fails earlier on ABI — use a crate config instead)
    const { dir: dir2, cache: cache2 } = project(t, {
      crates: true,
      files: { "case.ts": 'let value = "x";\n' },
      config: ({ crateDir }) => `import { nativePlugin } from ${JSON.stringify(
        `file://${join(root, "host/native/index.mjs")}`,
      )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`,
    });
    const noToolchain = run(dir2, cache2, ["-f", "json", "case.ts"], {
      restricted: true,
    });
    assert.equal(noToolchain.status, 2);
    assert.match(noToolchain.stderr, /Rust toolchain|rustc/u);

    // File outside a TS project.
    const { dir: dir3, cache: cache3 } = project(t, {
      files: {
        "src/other/case.ts": 'let value = "x";\n',
        "src/included/ok.ts": "export {};",
      },
      config: ({ dir: projectDir, crateDir }) => {
        writeFileSync(
          join(projectDir, "tsconfig.json"),
          JSON.stringify({ include: ["src/included/*.ts"] }),
        );
        return `import { nativePlugin } from ${JSON.stringify(
          `file://${join(root, "host/native/index.mjs")}`,
        )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`;
      },
    });
    const out = run(dir3, cache3, ["-f", "json", "src/other/case.ts"]);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /not included in a TypeScript project/u);
  });

  await t.test("plain ESLint rejects the native stub", async () => {
    const require = createRequire(import.meta.url);
    const { ESLint } = require("eslint");
    const { nativePlugin } = await import("./native/index.mjs");
    const dir = mkdtempSync(join(tmpdir(), "lintrs-stub-"));
    try {
      writeFileSync(join(dir, "case.ts"), "let value = 1;\n");
      const eslint = new ESLint({
        cwd: dir,
        overrideConfigFile: true,
        overrideConfig: {
          files: ["**/*.ts"],
          plugins: { demo: nativePlugin({ name: "demo", rules: ["x"] }) },
          rules: { "demo/x": "error" },
        },
      });
      await assert.rejects(
        eslint.lintFiles(["case.ts"]),
        /native lintrs rule/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("single-copy probe matches the host", async t => {
    const { dir, cache } = project(t, {
      files: { "case.ts": "let x = 1;\n" },
      config: () => "export default [];\n",
    });
    const require = createRequire(import.meta.url);
    const binding = require(nativeBinding);
    const session = binding.createSession(dir);
    const library = spawnSync(
      process.execPath,
      [join(root, "host/native/build.mjs"), fixtureCrate],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LINTRS_CACHE_DIR: cache,
          RUSTUP_TOOLCHAIN: "1.96.0",
        },
      },
    );
    if (library.status !== 0) throw new Error(library.stderr);
    const out = session.request(
      "lintrsNativeProbe",
      JSON.stringify({ libraries: [library.stdout.trim()] }),
    );
    const probe = JSON.parse(out);
    assert.equal(probe.host > 0, true);
    assert.equal(probe.plugins[library.stdout.trim()], probe.host);
  });

  await t.test("per-file overrides and unix formatter output", async t => {
    const { dir, cache } = project(t, {
      crates: true,
      files: {
        "src/on.ts": 'let value = "x";\n',
        "src/off.ts": 'let value = "x";\n',
      },
      config: ({ crateDir }) => `import { nativePlugin } from ${JSON.stringify(
        `file://${join(root, "host/native/index.mjs")}`,
      )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } },
 { files: ["src/off.ts"], rules: { "demo/value-is-string": "off" } }];\n`,
    });
    const json = run(dir, cache, ["-f", "json", "src/on.ts", "src/off.ts"]);
    assert.equal(json.status, 1, json.stderr);
    const report = JSON.parse(json.stdout);
    const byPath = Object.fromEntries(
      report.map(file => [file.filePath.split("/").pop(), file]),
    );
    assert.equal(byPath["on.ts"].messages[0].ruleId, "demo/value-is-string");
    assert.equal(byPath["off.ts"].messages.length, 0);
    const unix = run(dir, cache, ["-f", "unix", "src/on.ts"]);
    assert.equal(unix.status, 1, unix.stderr);
    assert.match(
      unix.stdout,
      /on\.ts:\d+:\d+: identifier 'value' has type string \[Error\/demo\/value-is-string\]/u,
    );
  });

  await t.test("npm workspace package resolves by crate", async t => {
    const dir = mkdtempSync(join(tmpdir(), "lintrs-native-ws-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cache = temporaryDirectory("lintrs-cache-");
    t.after(() => rmSync(cache, { recursive: true, force: true }));
    const pkg = join(dir, "packages", "lint-rules");
    mkdirSync(join(pkg, "rust"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    cpSync(fixtureCrate, join(pkg, "rust"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@acme/lint-rules",
        version: "0.0.0",
        type: "module",
        main: "index.mjs",
      }),
    );
    writeFileSync(
      join(pkg, "index.mjs"),
      `import { nativePlugin } from ${JSON.stringify(
        `file://${join(root, "host/native/index.mjs")}`,
      )};
export default nativePlugin({ name: "demo", rules: ["value-is-string"],
  crate: new URL("./rust/", import.meta.url) });\n`,
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        type: "commonjs",
        workspaces: ["packages/*"],
        dependencies: {
          "@acme/lint-rules": "0.0.0",
        },
      }),
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
    writeFileSync(join(dir, "src", "case.ts"), 'let value = "x";\n');
    writeFileSync(
      join(dir, "eslint.config.mjs"),
      `import rules from "@acme/lint-rules";
export default [{ files: ["**/*.ts"], plugins: { demo: rules },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`,
    );
    const install = spawnSync(
      "npm",
      ["install", "--offline", "--no-audit", "--no-fund"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr);
    // npm prunes anything not in the lockfile, so the repo's runtime deps are
    // linked in only after install.
    for (const entry of [
      "eslint",
      "oxlint",
      "typescript",
      "typescript-eslint",
      "@eslint",
      "@oxlint",
      "@typescript-eslint",
      "espree",
    ]) {
      const source = join(root, "node_modules", entry);
      if (existsSync(source))
        symlinkSync(source, join(dir, "node_modules", entry), "dir");
    }
    const first = run(dir, cache, ["-f", "json", "src/case.ts"]);
    assert.equal(first.status, 1, first.stderr);
    const [file] = JSON.parse(first.stdout);
    assert.equal(file.messages[0].ruleId, "demo/value-is-string");
    const entry = join(
      cache,
      "native-rules",
      readdirSync(join(cache, "native-rules"))[0],
    );
    const log = statSync(join(entry, "build.log")).mtimeMs;
    const second = run(dir, cache, ["-f", "json", "src/case.ts"], {
      restricted: true,
    });
    assert.equal(second.status, 1, second.stderr);
    assert.equal(statSync(join(entry, "build.log")).mtimeMs, log);
  });

  await t.test(
    "--concurrency produces identical Rust rule diagnostics",
    async t => {
      const { dir, cache } = project(t, {
        crates: true,
        files: {
          "src/case.ts": 'let value = "x";\n',
          "src/other.ts": 'let other = "y";\n',
        },
        config: ({
          crateDir,
        }) => `import { nativePlugin } from ${JSON.stringify(
          `file://${join(root, "host/native/index.mjs")}`,
        )};
const demo = nativePlugin({ name: "demo", rules: ["value-is-string"], crate: ${JSON.stringify(crateDir)} });
export default [{ files: ["**/*.ts"], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "demo/value-is-string": "error" } }];\n`,
      });
      const serial = run(dir, cache, [
        "-f",
        "json",
        "--concurrency",
        "off",
        "src",
      ]);
      assert.equal(serial.status, 1, serial.stderr);
      const parallel = run(dir, cache, [
        "-f",
        "json",
        "--concurrency",
        "2",
        "src",
      ]);
      assert.equal(parallel.status, 1, parallel.stderr);
      assert.deepEqual(JSON.parse(parallel.stdout), JSON.parse(serial.stdout));
    },
  );

  await t.test(
    "rule crate with its own crates.io dependency builds and runs",
    async t => {
      const { dir, cache } = project(t, {
        files: {
          "case.ts": 'const p = "tmp/work/file.txt";\nconst ok = "usr/lib";\n',
        },
        config: ({
          crateDir,
        }) => `import { nativePlugin } from ${JSON.stringify(
          `file://${join(root, "host/native/index.mjs")}`,
        )};
const demo = nativePlugin({ name: "casing", rules: ["no-tmp-path"], crate: ${JSON.stringify(join(root, "fixtures/native/casing-rules"))} });
export default [{ files: ["**/*.ts"], plugins: { casing: demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "casing/no-tmp-path": "error" } }];\n`,
      });
      const result = run(dir, cache, ["-f", "json", "case.ts"]);
      assert.equal(result.status, 1, result.stderr);
      const [file] = JSON.parse(result.stdout);
      assert.equal(file.messages.length, 1);
      assert.equal(file.messages[0].ruleId, "casing/no-tmp-path");
      assert.match(file.messages[0].message, /starts in tmp/u);
    },
  );

  await t.test(
    "a crate depending on a crate lintrs contains fails clearly",
    async t => {
      const dir = mkdtempSync(join(tmpdir(), "lintrs-badcrate-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      mkdirSync(join(dir, "src"), { recursive: true });
      cpSync(join(fixtureCrate, "src/lib.rs"), join(dir, "src/lib.rs"));
      writeFileSync(
        join(dir, "Cargo.toml"),
        `[package]
name = "bad-rules"
version = "0.1.0"
edition = "2024"
publish = false
[workspace]
[lib]
crate-type = ["cdylib"]
[dependencies]
serde_json = "1"
`,
      );
      const built = spawnSync(
        process.execPath,
        [join(root, "host/native/build.mjs"), dir],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            LINTRS_CACHE_DIR: temporaryDirectory("lintrs-cache-"),
            RUSTUP_TOOLCHAIN: "1.96.0",
          },
        },
      );
      assert.equal(built.status, 1);
      assert.match(
        built.stderr,
        /cannot depend on crates lintrs contains|depends on serde_json/u,
      );
      assert.match(built.stderr, /lintrs::native::serde_json/u);
    },
  );

  await t.test("NativeRuleTester validates cases", async t => {
    const tester = new NativeRuleTester({
      plugin: `file://${join(root, "fixtures/native/demo-plugin.mjs")}`,
      binary: nativeBin,
      env: {
        LINTRS_TSRS_SDK: sdk,
        LINTRS_IN_PROCESS_BINDING: nativeBinding,
        LINTRS_TYPED_NATIVE: "1",
        LINTRS_CACHE_DIR: temporaryDirectory("lintrs-tester-cache-"),
        RUSTUP_TOOLCHAIN: "1.96.0",
      },
    });
    tester.run("demo/value-is-string", {
      valid: [{ code: 'let other = "x";\n' }],
      invalid: [
        {
          code: 'let value = "x";\n',
          errors: [
            {
              message: "identifier 'value' has type string",
              line: 1,
              column: 5,
              endLine: 1,
              endColumn: 10,
            },
          ],
        },
      ],
    });
    assert.throws(() =>
      tester.run("demo/value-is-string", {
        invalid: [
          { code: 'let value = "x";\n', errors: [{ message: "nope" }] },
        ],
      }),
    );
    {
      // Non-ASCII before and on the same line as the reported node.
      const code = '// ünïcödé 😀\nconst s = "é"; const oldName = 1;\n';
      const lineStart = code.indexOf("\n") + 1;
      const start = code.indexOf("oldName");
      const end = start + "oldName".length;
      tester.run("demo/rename-value", {
        invalid: [
          {
            code,
            options: [{ match: "oldName", replacement: "newName" }],
            errors: [
              {
                message: "rename 'oldName' to 'newName'",
                line: 2,
                column: start - lineStart + 1,
                endLine: 2,
                endColumn: end - lineStart + 1,
              },
            ],
            output: code.slice(0, start) + "newName" + code.slice(end),
          },
        ],
      });
    }
  });
});

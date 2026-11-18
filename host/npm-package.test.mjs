// End-to-end check of the published npm package layout: pack dist/npm tgzs,
// install them into a project outside the repository and lint through the
// `lintrs` bin launcher. Skips when the native build is absent (except CI,
// where the layout must exist).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

import { platformKey } from "./native/build.mjs";

const root = resolve(import.meta.dirname, "..");
const native = join(root, "target/lintrs-native");
const nodeBin = dirname(process.execPath);

const haveBuild =
  existsSync(join(native, "bin/lintrs")) &&
  existsSync(join(native, "lib/liblintrs.node"));
const runTest = haveBuild || process.env.CI === "true";

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  return result;
}

test(
  "npm package installs and lints through the lintrs launcher",
  { skip: !runTest && "target/lintrs-native is missing" },
  async t => {
    const packed = command("node", [join(root, "scripts/pack-npm.mjs")], {
      cwd: root,
    });
    if (packed.status !== 0) assert.fail(packed.stderr);
    const tgzs = packed.stdout
      .trim()
      .split("\n")
      .map(line => line.trim());
    const mainTgz = tgzs.find(file => /lintrs-cli-\d/u.test(file));
    const platformTgz = tgzs.find(
      file => /lintrs-\w+-arm64|lintrs-\w+-x64/u.test(file) && file !== mainTgz,
    );
    assert.ok(mainTgz && platformTgz, `unexpected pack output: ${tgzs}`);
    const platformPackage = `@lintrs/${platformKey()}`;

    const dir = mkdtempSync(join(tmpdir(), "lintrs-npm-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
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

    // Install the tarballs. Prefer `npm install --offline` so the eslint /
    // oxlint / typescript dependencies resolve from the npm cache; when the
    // cache cannot satisfy them (e.g. an older lockfile version range), fall
    // back to symlinking this checkout's node_modules.
    let installed = command(
      "npm",
      [
        "install",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        mainTgz,
        platformTgz,
      ],
      { cwd: dir },
    );
    if (
      installed.status !== 0 ||
      !existsSync(join(dir, "node_modules/@lintrs/cli/package.json"))
    ) {
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      rmSync(join(dir, "package-lock.json"), { force: true });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      for (const entry of readdirSync(join(root, "node_modules"))) {
        if (entry.startsWith(".") || entry === "lintrs" || entry === "@lintrs")
          continue;
        const source = join(root, "node_modules", entry);
        try {
          symlinkSync(source, join(dir, "node_modules", entry), "dir");
        } catch {}
      }
      const unpack = (tgz, destination) => {
        mkdirSync(destination, { recursive: true });
        const untar = command("tar", [
          "-xzf",
          tgz,
          "-C",
          destination,
          "--strip-components=1",
        ]);
        if (untar.status !== 0) assert.fail(untar.stderr);
      };
      unpack(mainTgz, join(dir, "node_modules/@lintrs/cli"));
      // npm install links each package's bin into node_modules/.bin; do the
      // same, or `npx lintrs` finds no command (fresh CI runners always take
      // this path, since their npm cache is empty).
      const bins = JSON.parse(
        readFileSync(
          join(dir, "node_modules/@lintrs/cli/package.json"),
          "utf8",
        ),
      ).bin;
      mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
      for (const [name, target] of Object.entries(bins)) {
        chmodSync(join(dir, "node_modules/@lintrs/cli", target), 0o755);
        symlinkSync(
          join("..", "@lintrs/cli", target),
          join(dir, "node_modules/.bin", name),
        );
      }
      unpack(platformTgz, join(dir, `node_modules/${platformPackage}`));
      installed = { status: 0, stdout: "", stderr: "symlink fallback" };
    }

    const env = {
      PATH: `${nodeBin}:/usr/bin:/bin`,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LINTRS_CACHE_DIR: mkdtempSync(join(tmpdir(), "lintrs-cache-")),
    };

    // (1) A plain JS rule diagnostic through `npx lintrs`.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "eslint.config.mjs"),
      `export default [{ files: ["**/*.ts"], rules: { "no-debugger": "error" } }];\n`,
    );
    writeFileSync(join(dir, "src/case.ts"), "debugger;\n");
    const lint = command(
      "npx",
      ["lintrs", "--config", "eslint.config.mjs", "src"],
      { cwd: dir, env },
    );
    assert.equal(lint.status, 1, lint.stderr);
    assert.match(lint.stdout, /no-debugger/u);

    // (2) A prebuilt native rule package consumed via `@lintrs/cli/native`.
    const key = platformKey();
    const rulesPackage = join(dir, `node_modules/example-rules-${key}`);
    const built = command(
      "node",
      [
        join(root, "host/native/build.mjs"),
        join(root, "examples/rules/typescript-rust"),
        "--out",
        rulesPackage,
      ],
      { cwd: root, env: { ...process.env } },
    );
    if (built.status !== 0) assert.fail(built.stderr);
    writeFileSync(
      join(dir, "eslint.config.mjs"),
      `import { nativePlugin } from "@lintrs/cli/native";
const example = nativePlugin({ name: "example", rules: ["call-returns-union"],
  prebuilt: { ${JSON.stringify(key)}: "example-rules-${key}" } });
export default [{ files: ["**/*.ts"], plugins: { example },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { "example/call-returns-union": "error" } }];
`,
    );
    writeFileSync(
      join(dir, "src/case.ts"),
      `declare function pick(flag: boolean): string | number;
pick(true);
`,
    );
    const nativeLint = command(
      "npx",
      ["lintrs", "--config", "eslint.config.mjs", "src"],
      { cwd: dir, env },
    );
    assert.equal(nativeLint.status, 1, nativeLint.stderr);
    assert.match(nativeLint.stdout, /call-returns-union/u);

    // (3) Removing the platform package yields a clear error.
    // Only the platform package: @lintrs/cli lives in the same scope.
    rmSync(join(dir, `node_modules/${platformPackage}`), {
      recursive: true,
      force: true,
    });
    const missing = command("npx", ["lintrs", "--version"], {
      cwd: dir,
      env,
    });
    assert.notEqual(missing.status, 0);
    assert.match(
      `${missing.stdout}${missing.stderr}`,
      /@lintrs\/\w+-\w+|platform package .* not installed/u,
    );
  },
);

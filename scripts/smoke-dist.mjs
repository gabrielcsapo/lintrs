import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "");
const platformKey =
  `${process.platform}-${process.arch}` +
  (process.platform === "linux" ? "-gnu" : "");
const binary = join(dist, "bin/rlint");
const project = mkdtempSync(join(tmpdir(), "rlint-dist-smoke-"));
try {
  writeFileSync(join(project, "package.json"), '{"type":"commonjs"}\n');
  // The smoke project stands in for a user's project, which brings its own
  // eslint/typescript-eslint: link the repo's install entries in, not the
  // dist's --omit=dev one. A real node_modules directory (not a symlink) is
  // required so the prebuilt rule package below has somewhere to live.
  mkdirSync(join(project, "node_modules"), { recursive: true });
  for (const entry of readdirSync(
    resolve(import.meta.dirname, "../node_modules"),
  ))
    symlinkSync(
      join(import.meta.dirname, "../node_modules", entry),
      join(project, "node_modules", entry),
      "dir",
    );
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "es2022", module: "nodenext" },
      include: ["*.ts"],
    }),
  );
  writeFileSync(join(project, "sample.ts"), "const value: string = 'x';\n");
  writeFileSync(
    join(project, "eslint.config.mjs"),
    `import ts from 'typescript-eslint';
export default [{ files: ['**/*.ts'],
  languageOptions: { parser: ts.parser, parserOptions: { projectService: true } } },
  { plugins: { smoke: { rules: { typed: {
    meta: { schema: [] },
    create(context) {
      const services = context.sourceCode.parserServices;
      const checker = services.program.getTypeChecker();
      return { Identifier(node) {
        if (node.name !== 'value') return;
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
        if (checker.typeToString(type) === 'string')
          context.report({ node, message: 'typed-smoke-ok' });
      }};
    }
  } } } }, rules: { 'smoke/typed': 'error' } }];
`,
  );
  // The distribution must work without a Rust toolchain on PATH.
  const result = spawnSync(
    binary,
    [
      "--config",
      join(project, "eslint.config.mjs"),
      join(project, "sample.ts"),
    ],
    {
      encoding: "utf8",
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 1) {
    process.stderr.write(
      `expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\n`,
    );
    process.exitCode = 1;
  } else if (!result.stdout.includes("typed-smoke-ok")) {
    process.stderr.write(
      `expected typed-smoke-ok diagnostic, got:\nstdout: ${result.stdout}\nstderr: ${result.stderr}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`dist smoke passed: ${result.stdout.trim()}\n`);
  }

  // Leg 1 (runtime): a prebuilt native rule package must work from the
  // moved distribution with no Rust toolchain on PATH and no sdk/ — the
  // runtime tarball deliberately ships without it. The platform package is
  // built from the repo checkout (its sdk), exactly like a publisher's CI.
  const fixture = resolve(import.meta.dirname, "../fixtures/native/demo-rules");
  const hasSdk = existsSync(join(dist, "sdk", "deps"));
  if (existsSync(join(fixture, "Cargo.toml")) && !hasSdk) {
    const pkg = join(project, "node_modules", `demo-rules-${platformKey}`);
    const built = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../host/native/build.mjs"),
        fixture,
        "--out",
        pkg,
      ],
      { encoding: "utf8" },
    );
    if (built.status !== 0) {
      process.stderr.write(`native package build failed:\n${built.stderr}\n`);
      process.exitCode = 1;
    } else {
      writeFileSync(
        join(project, "eslint.native.config.mjs"),
        `import { nativePlugin } from ${JSON.stringify(
          `file://${join(dist, "host/native/index.mjs")}`,
        )};
const demo = nativePlugin({ name: 'demo', rules: ['value-is-string'],
  prebuilt: { ${JSON.stringify(platformKey)}: 'demo-rules-${platformKey}' } });
export default [{ files: ['**/*.ts'], plugins: { demo },
 languageOptions: { parserOptions: { projectService: true } },
 rules: { 'demo/value-is-string': 'error' } }];
`,
      );
      const native = spawnSync(
        binary,
        [
          "--config",
          join(project, "eslint.native.config.mjs"),
          join(project, "sample.ts"),
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          },
        },
      );
      if (
        native.status !== 1 ||
        !native.stdout.includes("demo/value-is-string")
      ) {
        process.stderr.write(
          `expected demo/value-is-string diagnostic, got ` +
            `${native.status}\nstdout: ${native.stdout}\n` +
            `stderr: ${native.stderr}\n`,
        );
        process.exitCode = 1;
      } else {
        process.stdout.write(
          `dist native smoke passed: ${native.stdout.trim()}\n`,
        );
      }
    }

    // Source builds must fail loudly without the sdk, naming the artifact.
    const noSdk = spawnSync(
      process.execPath,
      [join(dist, "host/native/build.mjs"), fixture],
      {
        encoding: "utf8",
        env: { ...process.env, RLINT_NATIVE_HOME: dist },
      },
    );
    if (noSdk.status === 0 || !noSdk.stderr.includes("rlint-sdk-")) {
      process.stderr.write(
        `expected a missing-sdk error naming rlint-sdk-*, got ` +
          `status ${noSdk.status}\n${noSdk.stderr}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `missing-sdk error passed: ${noSdk.stderr.trim().split("\n")[0]}\n`,
      );
    }
  }

  // Leg 2 (sdk): with rlint-sdk-<version>-<target>.tar.gz extracted next to
  // the runtime prefix, source builds work again.
  const sdkTarball = process.argv[3];
  if (sdkTarball !== undefined) {
    const extracted = spawnSync("tar", ["-xzf", sdkTarball, "-C", dist], {
      encoding: "utf8",
    });
    if (extracted.status !== 0 || !existsSync(join(dist, "sdk", "deps"))) {
      process.stderr.write(`sdk extraction failed: ${extracted.stderr}\n`);
      process.exitCode = 1;
    } else {
      const sourceBuild = spawnSync(
        process.execPath,
        [join(dist, "host/native/build.mjs"), fixture],
        {
          encoding: "utf8",
          env: { ...process.env, RLINT_NATIVE_HOME: dist },
        },
      );
      if (sourceBuild.status !== 0 || !existsSync(sourceBuild.stdout.trim())) {
        process.stderr.write(
          `sdk source build failed:\n${sourceBuild.stderr}\n`,
        );
        process.exitCode = 1;
      } else {
        process.stdout.write(
          `dist sdk smoke passed: ${sourceBuild.stdout.trim()}\n`,
        );
      }
    }
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}

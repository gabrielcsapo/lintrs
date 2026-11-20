import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { scopeConfig } from "./config-scope.mjs";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint"));
const { FlatConfigArray } = eslintRequire("./config/flat-config-array.js");

test("scope pruning preserves ESLint matching, ignores, base paths, AND groups and options", async () => {
  const root = resolve("/tmp/scoped-config");
  const configs = new FlatConfigArray(
    [
      { ignores: ["**/ignored/**", "**/*.generated.ts"] },
      { files: ["**/*.ts"], rules: { "no-debugger": "error" } },
      {
        files: ["packages/backend/**/*.ts", "apps/web/**/*.ts"],
        rules: { "no-alert": "warn" },
      },
      {
        files: [["apps/**", "**/*.test.ts"]],
        rules: { "no-console": ["error", { allow: ["warn"] }] },
      },
      { files: ["apps/{web,web-client}/**/*.ts"], settings: { braces: true } },
      {
        files: ["apps/+(web|web-client)/**/*.ts"],
        settings: { extglob: true },
      },
      {
        files: ["apps/**"],
        ignores: ["**/*.test.ts"],
        settings: { nonTest: true },
      },
      {
        basePath: "apps/web",
        files: ["src/*.ts"],
        settings: { relativeBase: true },
      },
      {
        files: [resolve(root, "apps/web/src/*.ts")],
        settings: { absolute: true },
      },
      { files: ["apps/web-*/**/*.ts"], settings: { prefix: true } },
      { files: ["packages/unused/**/*.ts"], settings: { excluded: true } },
      {
        files: [file => file.endsWith("/special.ts")],
        settings: { functionPattern: true },
      },
    ],
    { basePath: root },
  );
  await configs.normalize();
  const files = [
    "apps/web/src/file.ts",
    "apps/web/src/file.test.ts",
    "apps/web/src/special.ts",
    "apps/web/ignored/file.ts",
    "apps/web/src/file.generated.ts",
    "apps/web-client/src/file.ts",
    "apps/web/src/file.js",
  ].map(file => resolve(root, file));
  const scoped = await scopeConfig({ configs, root }, files);
  assert.ok(scoped.configs.length < configs.length);
  for (const file of files)
    assert.deepEqual(
      scoped.configs.getConfigWithStatus(file),
      configs.getConfigWithStatus(file),
      file,
    );
});

test("scope pruning leaves negated, escaped and function patterns to ESLint", async () => {
  const root = resolve("/tmp/scoped-config");
  const configs = new FlatConfigArray(
    [
      { files: ["**/*.ts"], rules: { "no-debugger": "error" } },
      { files: ["!packages/**"], settings: { negated: true } },
      { files: ["apps/web/src/\\[literal\\].ts"], settings: { escaped: true } },
      {
        files: [[file => file.endsWith(".ts"), "apps/**"]],
        settings: { functionGroup: true },
      },
    ],
    { basePath: root },
  );
  await configs.normalize();
  const files = [resolve(root, "apps/web/src/[literal].ts")];
  const scoped = await scopeConfig({ configs, root }, files);
  for (const file of files)
    assert.deepEqual(
      scoped.configs.getConfigWithStatus(file),
      configs.getConfigWithStatus(file),
    );
});

test("ignore pruning preserves directory ignores, reinclusions, local overrides and base paths", async () => {
  const root = resolve("/tmp/scoped-config");
  const entries = [
    {
      ignores: [
        "packages/unused/**",
        "apps/web/ignored/",
        "apps/web/generated/**",
        "!apps/web/generated/",
        "!apps/web/generated/keep.ts",
      ],
    },
    { files: ["**/*.ts"], rules: { "no-debugger": "error" } },
    {
      files: ["apps/web/**/*.ts"],
      ignores: [
        "packages/unused/**",
        "apps/web/src/skip.ts",
        "!apps/web/src/keep.ts",
      ],
      settings: { local: true },
    },
    {
      files: ["**/*.ts"],
      ignores: ["packages/unused/**"],
      settings: { allIgnoresPruned: true },
    },
    {
      basePath: "apps/web",
      ignores: ["unrelated/**", "src/hidden/", "src/ignored.ts"],
    },
    {
      basePath: "apps/web",
      files: ["**/*.ts"],
      ignores: ["unrelated/**", "src/skip.ts"],
      settings: { relativeBase: true },
    },
    {
      files: ["**/*.ts"],
      ignores: [
        file => file.endsWith("/function.ts"),
        "apps/web/src/\\[literal\\].ts",
      ],
      settings: { opaque: true },
    },
    { name: "unrelated global ignores", ignores: ["packages/unused/**"] },
  ];
  const configs = new FlatConfigArray(entries, { basePath: root });
  await configs.normalize();
  const files = [
    "src/file.ts",
    "src/keep.ts",
    "src/skip.ts",
    "src/ignored.ts",
    "src/hidden/file.ts",
    "ignored/file.ts",
    "generated/keep.ts",
    "generated/skip.ts",
    "src/function.ts",
    "src/[literal].ts",
  ].map(file => resolve(root, "apps/web", file));
  const scoped = await scopeConfig({ configs, root }, files);
  assert.ok(
    scoped.configs.reduce(
      (sum, config) => sum + (config.ignores?.length ?? 0),
      0,
    ) < configs.reduce((sum, config) => sum + (config.ignores?.length ?? 0), 0),
  );
  for (const file of files)
    assert.deepEqual(
      scoped.configs.getConfigWithStatus(file),
      configs.getConfigWithStatus(file),
      file,
    );
  assert.deepEqual(entries[0].ignores[0], "packages/unused/**");
});

test("segment pruning retains matching ancestors and wildcard edge cases", async () => {
  const root = resolve("/tmp/scoped-config");
  const patterns = [
    "**/dist/**",
    "**/*.generated.ts",
    "**/generated/**/file.ts",
    "**/foo?.ts",
    "**/dot.file.ts",
    "**/cash$.ts",
    "**/line*.ts",
    "**/?.ts",
    "**/??.ts",
    "**/{one,two}/**",
    "**/[ab].ts",
    "**/@(one|two)/**",
    "**/+(one|two)/**",
    "**/!(*.test).ts",
    "**/\\[literal\\].ts",
    "./apps/web/**/*.ts",
    "apps/web/../web/**/*.ts",
  ];
  const configs = new FlatConfigArray(
    [
      { files: ["**/*.ts"], settings: { baseline: true } },
      {
        ignores: [
          "**/dist/**",
          "**/generated/**",
          "!**/generated/",
          "!**/generated/keep.ts",
        ],
      },
      ...patterns.map((pattern, index) => ({
        files: [pattern],
        settings: { [`pattern${index}`]: true },
      })),
      ...patterns.map((pattern, index) => ({
        files: ["**/*.ts"],
        ignores: [pattern],
        settings: { [`ignore${index}`]: true },
      })),
    ],
    { basePath: root },
  );
  await configs.normalize();
  const files = [
    "src/file.ts",
    "src/foo1.ts",
    "src/foo.ts",
    "src/dot.file.ts",
    "src/cash$.ts",
    "src/line\nfile.ts",
    "src/😀.ts",
    "src/[literal].ts",
    "dist/file.ts",
    "generated/keep.ts",
    "one/file.ts",
    "two/file.ts",
    "src/a.ts",
    "src/file.test.ts",
    "src/folder.generated.ts/file.ts",
  ].map(file => resolve(root, "apps/web", file));
  for (const file of files) {
    const scoped = await scopeConfig({ configs, root }, [file]);
    assert.deepEqual(
      scoped.configs.getConfigWithStatus(file),
      configs.getConfigWithStatus(file),
      file,
    );
  }
});

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

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

// Randomized differential check: for many generated configurations and
// candidate sets, every candidate must resolve to the same rules (or the same
// "unconfigured" answer) with and without pruning. The seed is fixed so a
// failure reproduces.
test("pruning never changes ESLint's answer for a candidate file", async () => {
  const root = "/repo";
  const filePool = [
    "src/a.ts",
    "src/b.test.ts",
    "src/deep/x/y.ts",
    "src/.hidden/z.ts",
    "dist/out.js",
    "dist/sub/out.d.ts",
    "lib/gen/types.ts",
    "packages/p/src/i.ts",
    "packages/p/dist/i.js",
    "café/naïve.ts",
    "emoji/😀.ts",
    "abc/d.js",
    "axc/d.js",
    ".cache/c.js",
    "test/fixtures/f.ts",
    "a.ts",
    "build.ts",
    "buildings/b.ts",
  ];
  const patternPool = [
    "**/*.ts",
    "*.ts",
    "src/**",
    "src/*.ts",
    "src/**/*.test.ts",
    "dist/",
    "dist/**",
    "**/dist/",
    "**/gen/**",
    "lib/gen",
    "packages/*/dist/**",
    "**/*.d.ts",
    ".cache/",
    "**/.hidden/**",
    "a?c/*.js",
    "emoji/?.ts",
    "emoji/??.ts",
    "café/*.ts",
    "build",
    "build/",
    "**/fixtures",
    "test/**/f.ts",
    "!src/a.ts",
    "**/*.{ts,js}",
    "src/[ab].ts",
    "./src/a.ts",
    "nothing/**",
    "*.nope",
    "src/deep/**/y.ts",
    "*",
  ];
  let seed = 7;
  const random = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const pick = (pool, count) =>
    Array.from({ length: count }, () => pool[random(pool.length)]);
  const plugin = {
    rules: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`r${i}`, { create: () => ({}) }]),
    ),
  };
  let pruned = 0;
  for (let round = 0; round < 300; round++) {
    const entries = Array.from({ length: 1 + random(5) }, (_, i) => {
      const kind = random(4);
      const entry = { rules: { [`t/r${i}`]: "error" } };
      if (kind !== 1)
        entry.files = pick(
          patternPool.filter(pattern => !pattern.startsWith("!")),
          1 + random(3),
        );
      if (kind !== 0) entry.ignores = pick(patternPool, 1 + random(4));
      if (kind === 3) delete entry.rules;
      if (kind === 3) delete entry.files;
      return entry;
    });
    const files = [...new Set(pick(filePool, random(13)))].map(
      file => `${root}/${file}`,
    );
    const build = async () => {
      const configs = new FlatConfigArray(
        [{ plugins: { t: plugin } }, ...entries.map(e => structuredClone(e))],
        { basePath: root },
      );
      await configs.normalize();
      return configs;
    };
    const original = await build();
    const scoped = (await scopeConfig({ configs: await build(), root }, files))
      .configs;
    const patterns = configs =>
      [...configs].reduce(
        (total, entry) =>
          total + (entry.files?.length ?? 0) + (entry.ignores?.length ?? 0),
        0,
      );
    if (patterns(scoped) < patterns(original)) pruned++;
    const answer = (configs, file) => {
      const config = configs.getConfig(file);
      return config === undefined
        ? null
        : Object.keys(config.rules ?? {}).sort();
    };
    for (const file of files)
      assert.deepEqual(
        answer(scoped, file),
        answer(original, file),
        `${file} with ${JSON.stringify(entries)}`,
      );
  }
  // The check is only meaningful if pruning actually happened.
  assert.ok(pruned > 200, `only ${pruned} rounds pruned anything`);
});

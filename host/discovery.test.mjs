import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDiscoveryFilter, discoverFiles } from "./discovery.mjs";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint"));
const { FlatConfigArray } = eslintRequire("./config/flat-config-array.js");

test("discovery preserves conditional paths, scoped ignores, global negations, and unconfigured files", async t => {
  const root = mkdtempSync(join(tmpdir(), "lintrs-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configs = new FlatConfigArray(
    [
      { ignores: ["**/generated/**", "**/blocked.ts", "!**/keep.blocked.ts"] },
      { files: ["**/*.ts"] },
      { files: ["src/scoped/*.graphql"], ignores: ["**/excluded.graphql"] },
      { files: [file => file.endsWith("dynamic.graphql")] },
      { basePath: "nested", files: ["**/*.mts"] },
      { files: [["**/*.tsx", "**/Widget.*"]] },
      { files: ["src/exact/schema.graphql"] },
    ],
    { basePath: root },
  );
  await configs.normalize();
  const paths = [
    "src/main.ts",
    "src/.hidden/file.ts",
    "src/blocked.ts",
    "src/keep.blocked.ts",
    "src/generated/hidden.ts",
    "src/scoped/schema.graphql",
    "src/scoped/excluded.graphql",
    "src/dynamic.graphql",
    "src/unconfigured.graphql",
    "nested/source.mts",
    "outside/source.mts",
    "src/Widget.tsx",
    "src/Other.tsx",
    "src/exact/schema.graphql",
  ];
  const filter = await createDiscoveryFilter(configs, root);
  for (const path of paths) {
    const file = join(root, path);
    assert.equal(
      filter.isPathIgnored(file),
      configs.getConfig(file) === undefined,
      path,
    );
  }
  assert.ok(filter.stats.fallback > 0);
  assert.ok(filter.stats.matched > 0);
  assert.ok(filter.stats.ignored > 0);
  for (const path of paths.filter(path => path.startsWith("src/"))) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  const expected = paths
    .filter(
      path =>
        path.startsWith("src/") &&
        configs.getConfig(join(root, path)) !== undefined,
    )
    .map(path => join(root, path))
    .sort();
  assert.deepEqual(discoverFiles(root, filter).sort(), expected);
});

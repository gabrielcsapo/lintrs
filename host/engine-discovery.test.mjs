import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverFiles, selectFiles } from "./engine.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "lintrs-engine-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of files) {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  return root;
}

test("directory discovery preserves extensions, ordering, ignores, and overlapping inputs", t => {
  const names = [
    "nested/z.ts",
    "nested/a.jsx",
    "nested/b.cts",
    "nested/c.mjs",
    ".hidden/d.tsx",
    "schema.graphql",
    "data.json",
    "ignored/skipped.ts",
  ];
  const root = fixture(t, names);
  const configs = {
    isDirectoryIgnored: path => path === join(root, "ignored"),
    getConfig: file => (file.endsWith(".jsx") ? undefined : {}),
  };
  const paths = [join(root, "nested/z.ts"), root, join(root, "nested")];
  const expected = names
    .filter(name => name !== "data.json" && !name.startsWith("ignored/"))
    .map(name => join(root, name))
    .sort();
  assert.deepEqual(discoverFiles(paths, configs), expected);
  assert.deepEqual(
    selectFiles(paths, configs),
    expected.filter(file => !file.endsWith(".jsx")),
  );
});

test("discovery rejects explicit and nested symlinks, including unsupported extensions", t => {
  const root = fixture(t, ["source.ts", "data.json"]);
  const configs = { isDirectoryIgnored: () => false };
  for (const target of ["source.ts", "data.json"]) {
    const link = join(root, `linked-${target}`);
    symlinkSync(join(root, target), link);
    assert.throws(
      () => discoverFiles([link], configs),
      /Symlink discovery is not implemented/,
    );
    assert.throws(
      () => discoverFiles([root], configs),
      /Symlink discovery is not implemented/,
    );
    rmSync(link);
  }
  const directory = join(root, "linked-directory");
  symlinkSync(root, directory, "dir");
  assert.throws(
    () => discoverFiles([root], configs),
    /Symlink discovery is not implemented/,
  );
});

test("ignored directories remain unvisited and missing explicit inputs still fail", t => {
  const root = fixture(t, ["ignored/source.ts"]);
  symlinkSync(join(root, "missing"), join(root, "ignored/broken-link"));
  const configs = {
    isDirectoryIgnored: path => path === join(root, "ignored"),
    getConfig: () => ({}),
  };
  assert.deepEqual(discoverFiles([root], configs), []);
  assert.throws(
    () => selectFiles([root], configs),
    /No configured files selected/,
  );
  assert.deepEqual(selectFiles([root], configs, { allowEmpty: true }), []);
  assert.throws(() => discoverFiles([join(root, "missing.ts")], configs), {
    code: "ENOENT",
  });
});

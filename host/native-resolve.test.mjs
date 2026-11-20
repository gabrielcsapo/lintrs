import assert from "node:assert/strict";
import { test } from "node:test";

import { createNativeLibraryResolver } from "./native/resolve.mjs";

test("rules and plugin aliases share preparation of the same library", () => {
  const calls = [];
  const resolveLibrary = createNativeLibraryResolver(meta => {
    calls.push(meta);
    return `/built/${calls.length}.so`;
  });
  const first = {
    plugin: "one",
    rule: "first",
    root: "/plugin",
    crate: "rules",
  };
  assert.equal(resolveLibrary(first), "/built/1.so");
  assert.equal(
    resolveLibrary({ ...first, plugin: "alias", rule: "second" }),
    "/built/1.so",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0], first);
  assert.equal(resolveLibrary({ ...first, crate: "other" }), "/built/2.so");
  assert.equal(resolveLibrary({ ...first, root: "/other" }), "/built/3.so");
});

test("prebuilt package mappings and resolution roots stay distinct", () => {
  let calls = 0;
  const resolveLibrary = createNativeLibraryResolver(
    () => `/built/${++calls}.so`,
  );
  const first = {
    plugin: "demo",
    rule: "first",
    root: "/plugin",
    prebuilt: { "linux-x64-gnu": "demo-linux" },
  };
  assert.equal(resolveLibrary(first), "/built/1.so");
  assert.equal(
    resolveLibrary({
      ...first,
      rule: "second",
      prebuilt: { ...first.prebuilt },
    }),
    "/built/1.so",
  );
  assert.equal(
    resolveLibrary({ ...first, prebuilt: { "linux-x64-gnu": "other-linux" } }),
    "/built/2.so",
  );
  assert.equal(resolveLibrary({ ...first, root: "/other" }), "/built/3.so");
});

test("each invocation resolves current source and failed resolutions are retried", () => {
  const meta = {
    plugin: "demo",
    rule: "first",
    root: "/plugin",
    crate: "rules",
  };
  let library = "/before.so";
  const first = createNativeLibraryResolver(() => library);
  assert.equal(first(meta), "/before.so");
  library = "/after.so";
  const second = createNativeLibraryResolver(() => library);
  assert.equal(second(meta), "/after.so");

  let attempts = 0;
  const retry = createNativeLibraryResolver(() => {
    if (++attempts === 1) throw new Error("missing library");
    return library;
  });
  assert.throws(() => retry(meta), /missing library/u);
  assert.equal(retry(meta), "/after.so");
  assert.equal(attempts, 2);
});

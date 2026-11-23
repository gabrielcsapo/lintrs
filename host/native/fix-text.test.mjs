import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeFixText } from "./fix-text.mjs";

test("plain native fixes preserve existing strings", () => {
  assert.equal(nativeFixText({ text: "a\0😀" }), "a\0😀");
});

test("native fixes preserve UTF-16 code units without replacing lone surrogates", () => {
  const units = [0, 0xd800, 0x61, 0xdc00, 0xd83d, 0xde00];
  const text = nativeFixText({ textUtf16: units });
  assert.equal(text.length, units.length);
  assert.deepEqual(
    Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)),
    units,
  );
  assert.equal(nativeFixText({ textUtf16: [] }), "");
});

test("long native fixes avoid the argument count limit", () => {
  const units = Array.from({ length: 200000 }, (_, i) => i % 65536);
  const text = nativeFixText({ textUtf16: units });
  assert.equal(text.length, units.length);
  for (const i of [0, 16383, 16384, 65535, 199999])
    assert.equal(text.charCodeAt(i), units[i]);
});

test("invalid or ambiguous native fix payloads fail explicitly", () => {
  for (const fix of [
    {},
    { text: 4 },
    { textUtf16: "x" },
    { textUtf16: [-1] },
    { textUtf16: [65536] },
    { textUtf16: [0.5] },
    { textUtf16: [null] },
    { text: "x", textUtf16: [120] },
  ])
    assert.throws(() => nativeFixText(fix), /Native.*fix text/);
});

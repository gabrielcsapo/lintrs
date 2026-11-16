import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const bindingPath = process.env.RLINT_IN_PROCESS_BINDING;
const binding =
  bindingPath === undefined
    ? undefined
    : createRequire(import.meta.url)(bindingPath);

test(
  "in-process sessions reject invalid receivers and recover after failed queries",
  { skip: binding === undefined },
  () => {
    assert.throws(() => binding.createSession("relative"), /absolute/u);
    const session = binding.createSession(tmpdir());
    try {
      assert.throws(
        () => session.request.call({}, "initialize", "null"),
        /receiver/u,
      );
      assert.throws(() => session.request("readConfigFile", "{"));
      assert.throws(
        () => session.request("unimplementedRlintMethod", "null"),
        /unknown API method/u,
      );
      const initialized = JSON.parse(session.request("initialize", "null"));
      assert.equal(initialized.currentDirectory, tmpdir());
      assert.equal(typeof initialized.useCaseSensitiveFileNames, "boolean");
      assert.equal(JSON.parse(session.timing()).totals.requestCount, 3);
      session.resetTiming();
      assert.equal(JSON.parse(session.timing()).totals.requestCount, 0);
    } finally {
      session.close();
    }
    session.close();
    assert.throws(() => session.request("initialize", "null"), /closed/u);
  },
);

test(
  "in-process sessions perform real Rust type comparisons and release snapshot handles",
  { skip: binding === undefined },
  t => {
    const directory = mkdtempSync(join(tmpdir(), "rlint-native-binding-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "sample.ts");
    writeFileSync(file, "export const value: string = 'hello';\n");
    const session = binding.createSession(directory);
    t.after(() => session.close());
    const request = (method, params) =>
      JSON.parse(session.request(method, JSON.stringify(params)));
    const created = request("createSnapshot", {
      createPrograms: [
        {
          rootFiles: [file],
          compilerOptions: { strict: true, target: 9 },
        },
      ],
    });
    const project = created.operation.createdPrograms[0];
    const context = { snapshot: created.snapshot, project };
    const string = request("getStringType", context);
    const number = request("getNumberType", context);
    assert.equal(typeof string.id, "number");
    assert.equal(typeof number.id, "number");
    assert.equal(
      request("isTypeAssignableTo", {
        ...context,
        source: string.id,
        target: string.id,
      }),
      true,
    );
    assert.equal(
      request("isTypeAssignableTo", {
        ...context,
        source: string.id,
        target: number.id,
      }),
      false,
    );
    assert.deepEqual(
      request("rlintIsTypeAssignableToMany", {
        ...context,
        source: string.id,
        targets: [string.id, number.id],
      }),
      [true, false],
    );
    for (const invalid of [
      { source: 4_294_967_295, targets: [number.id] },
      { source: string.id, targets: [4_294_967_295] },
      { source: string.id, targets: Array(65).fill(number.id) },
    ])
      assert.throws(() =>
        request("rlintIsTypeAssignableToMany", { ...context, ...invalid }),
      );
    assert.deepEqual(
      request("rlintIsTypeAssignableToMany", {
        ...context,
        source: string.id,
        targets: [string.id, number.id],
      }),
      [true, false],
    );
    const source = session.request(
      "getSourceFile",
      JSON.stringify({ ...context, file }),
    );
    assert.equal(Buffer.isBuffer(source), true);
    assert.ok(source.length > 0);
    request("release", { snapshot: created.snapshot });
    assert.throws(() => request("getStringType", context));
    assert.throws(() =>
      request("rlintIsTypeAssignableToMany", {
        ...context,
        source: string.id,
        targets: [number.id],
      }),
    );
  },
);

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

const bindingPath = process.env.RLINT_IN_PROCESS_BINDING;
const binding =
  bindingPath === undefined
    ? undefined
    : createRequire(import.meta.url)(bindingPath);

function thread(token, params) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const { workerData, parentPort } = require('node:worker_threads');
      const session = require(workerData.binding).attachSession(workerData.token);
      const request = (method, params) => JSON.parse(session.request(method, JSON.stringify(params)) || 'null');
      const created = request('createSnapshot', workerData.params);
      const context = {snapshot: created.snapshot, project: created.operation.createdPrograms[0]};
      const string = session.requestValue('getStringType', context);
      const number = session.requestValue('getNumberType', context);
      for (let index = 0; index < 100; index++) {
        if (session.requestValue('isTypeAssignableTo', {...context, source:string.id, target:number.id})) throw new Error('Incorrect comparison');
      }
      request('release', {snapshot: created.snapshot});
      session.close();
      parentPort.postMessage({created, string, number});
    `,
      { eval: true, workerData: { binding: bindingPath, token, params } },
    );
    let result;
    worker.on("message", message => {
      result = message;
    });
    worker.on("error", reject);
    worker.on("exit", code =>
      code === 0 && result !== undefined
        ? resolve(result)
        : reject(new Error(`Worker exited ${code}`)),
    );
  });
}

test(
  "shared sessions reuse one snapshot across threads and retain it after a worker releases",
  { skip: binding === undefined },
  async t => {
    const directory = mkdtempSync(join(tmpdir(), "rlint-shared-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "sample.ts");
    writeFileSync(file, "export const value: string = 'hello';\n");
    const owner = binding.createSession(directory);
    t.after(() => owner.close());
    const token = owner.share();
    const params = {
      createPrograms: [
        { rootFiles: [file], compilerOptions: { strict: true, target: 9 } },
      ],
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => thread(token, params)),
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(JSON.parse(owner.timing()).shared.snapshotCount, 1);
    assert.deepEqual(await thread(token, params), results[0]);
    const attached = binding.attachSession(token);
    t.after(() => attached.close());
    assert.throws(() => attached.share(), /owning/u);
    assert.throws(
      () => attached.request("release", '{"snapshot":999999999}'),
      /Unknown shared/u,
    );
    assert.throws(() => binding.attachSession("expired"), /Unknown/u);
    owner.close();
    assert.throws(() => binding.attachSession(token), /closed/u);
    assert.throws(() => attached.request("initialize", "null"), /closed/u);
    assert.throws(
      () =>
        attached.requestValue("getStringType", {
          snapshot: results[0].created.snapshot,
          project: results[0].created.operation.createdPrograms[0],
        }),
      /closed/u,
    );
    attached.close();
    attached.close();
  },
);

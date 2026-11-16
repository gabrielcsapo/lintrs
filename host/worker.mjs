import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { HostWorkerRecycleRequired, runHost } from "./engine.mjs";
import { finalizeHost } from "./results.mjs";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let completed = 0;
for await (const line of input) {
  const task = JSON.parse(line);
  process.env.RLINT_CONFIG_EXPORT = task.configExport ?? "default";
  const started = performance.now();
  let result;
  try {
    const output = await runHost({
      configPath: task.configPath,
      paths: task.files,
    });
    const files = finalizeHost(output);
    writeFileSync(`${task.prefix}.json`, JSON.stringify(files));
    result = { status: files.some(file => file.errorCount > 0) ? 1 : 0 };
  } catch (error) {
    const describe = item =>
      item instanceof Error ? (item.stack ?? String(item)) : String(item);
    const failure =
      error instanceof AggregateError
        ? error.errors.map(describe).join("\n")
        : describe(error);
    if (error instanceof HostWorkerRecycleRequired)
      result = { status: 3, retry: true };
    else {
      writeFileSync(`${task.prefix}.stderr`, failure);
      result = { status: 2, failure };
    }
  }
  globalThis.gc?.();
  completed++;
  result.durationMs = performance.now() - started;
  result.rssAfterGc = process.memoryUsage().rss;
  result.recycle =
    result.retry ||
    result.status === 2 ||
    completed >= 8 ||
    result.rssAfterGc > 3 * 1024 ** 3;
  await new Promise(resolve =>
    process.stdout.write(`${JSON.stringify(result)}\n`, resolve),
  );
  if (result.recycle) break;
}
input.close();
process.exit(0);

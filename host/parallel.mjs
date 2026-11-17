// Parallel linting behind `--concurrency <n|auto|off>`: one file selection,
// then either the single-thread runHost path or worker threads sharing one
// type-checker session.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

import { loadConfig } from "./config.mjs";
import { resolveNativeLibrary } from "./native/resolve.mjs";
import { selectFiles } from "./engine.mjs";
import { tsrsSdkRoot } from "./type-services/sdk.mjs";
import { profiler } from "./profile.mjs";

const require = createRequire(import.meta.url);

function describeFailure(error) {
  return error instanceof AggregateError
    ? `${error.stack}\n${error.errors.map(describeFailure).join("\n")}`
    : error instanceof Error
      ? (error.stack ?? String(error))
      : String(error);
}

// ESLint's getWorkerCountFor (eslint/lib/eslint/eslint.js): `auto` is
// ceil(files / 50) capped at half the machine's cores; a count of one means
// the work runs on the main thread.
export function workerCount(files, concurrency, cpus = availableParallelism()) {
  if (concurrency === "off") return 1;
  if (concurrency === "auto") {
    const cap = Math.max(1, Math.floor(cpus / 2));
    return Math.max(1, Math.min(Math.ceil(files / 50), cap));
  }
  return Math.min(concurrency, Math.max(1, files));
}

async function lintFiles(options) {
  if (options.parserBinding !== undefined) {
    const previous = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = options.parserBinding;
    try {
      await import(options.parserLoader);
    } finally {
      if (previous === undefined)
        delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
      else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previous;
    }
  }
  const { runHost } = await import("./engine.mjs");
  const { finalizeHost } = await import("./results.mjs");
  return finalizeHost(
    await runHost({
      configPath: options.configPath,
      paths: options.files,
      quiet: options.quiet,
    }),
  );
}

function runWorker(options, env, threads, profiles) {
  return new Promise((resolveWorker, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: options,
      env,
    });
    threads.push(worker);
    let results;
    worker.on("message", message => {
      if (message.failure !== undefined) reject(new Error(message.failure));
      else {
        results = message.results;
        if (message.profile !== undefined) profiles?.push(message.profile);
      }
    });
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0 || results === undefined)
        reject(new Error(`lintrs worker exited ${code}`));
      else resolveWorker(results);
    });
  });
}

/** `profiles`, when given, collects each worker thread's profiler snapshot
 * (TIMING); the single-thread path profiles into the caller's thread. */
export async function lint({
  configPath,
  paths,
  quiet,
  concurrency,
  profiles,
}) {
  const { configs, rules } = await loadConfig(configPath);
  const files = selectFiles(paths, configs);
  const workers = workerCount(files.length, concurrency);
  if (workers === 1) return lintFiles({ configPath, files, quiet });
  // Build (or find cached) native rule libraries before any worker starts:
  // building forks cargo, which fails with ENOMEM on Linux once a worker has
  // allocated oxlint's raw-transfer buffers in this shared process. Workers
  // then resolve the cached builds without spawning.
  const resolved = new Set();
  for (const file of files)
    for (const [id, setting] of Object.entries(
      configs.getConfig(file).rules ?? {},
    )) {
      const meta = rules.get(id)?.meta?.lintrs;
      if (meta?.native !== true || (setting[0] ?? 0) === 0) continue;
      if (resolved.has(meta)) continue;
      resolved.add(meta);
      resolveNativeLibrary(meta);
    }

  let scratch;
  let owner;
  const threads = [];
  try {
    scratch = mkdtempSync(join(tmpdir(), "lintrs-workers-"));
    const env = { ...process.env };
    // Locating the tsrs SDK in a source checkout runs rustc and cargo. Do it
    // once here, before any worker allocates oxlint's raw-transfer buffers in
    // this shared process (a later fork would fail with ENOMEM on Linux).
    if (env.LINTRS_TSRS_SDK === undefined)
      try {
        env.LINTRS_TSRS_SDK = tsrsSdkRoot(process.cwd());
      } catch {
        // Untyped runs never need the SDK; let typed workers report it.
      }
    if (process.env.LINTRS_IN_PROCESS_BINDING !== undefined) {
      // One owner session shared by every worker keeps a single type
      // checker; workers attach through LINTRS_SHARED_SESSION.
      const binding = require(process.env.LINTRS_IN_PROCESS_BINDING);
      owner = binding.createSession(process.cwd());
      env.LINTRS_SHARED_SESSION = owner.share();
    }
    if (env.LINTRS_OXLINT_THREADS === undefined)
      env.LINTRS_OXLINT_THREADS = String(
        Math.max(1, Math.floor(availableParallelism() / workers)),
      );
    const oxlintRequire = createRequire(require.resolve("oxlint/package.json"));
    const bindingName = {
      darwin: `darwin-${process.arch}`,
      linux: `linux-${process.arch}-gnu`,
      win32: `win32-${process.arch}-msvc`,
    }[process.platform];
    if (bindingName === undefined)
      throw new Error(
        `lintrs workers are not supported on ${process.platform}`,
      );
    const parserBinding = oxlintRequire.resolve(
      `@oxlint/binding-${bindingName}`,
    );
    const parserLoader = pathToFileURL(
      join(dirname(require.resolve("oxlint/package.json")), "dist/bindings.js"),
    ).href;
    const results = (
      await Promise.all(
        Array.from({ length: workers }, (_, index) => {
          const parserCopy = join(scratch, `oxlint-${index}.node`);
          copyFileSync(parserBinding, parserCopy);
          return runWorker(
            {
              configPath,
              quiet,
              files: files.slice(
                Math.floor((index * files.length) / workers),
                Math.floor(((index + 1) * files.length) / workers),
              ),
              parserBinding: parserCopy,
              parserLoader,
            },
            env,
            threads,
            profiles,
          );
        }),
      )
    ).flat();
    // Keep the single-thread order (the engine's code-unit sort) so output
    // is identical regardless of --concurrency.
    const order = new Map(files.map((file, index) => [resolve(file), index]));
    if (
      results.length !== files.length ||
      results.some(result => !order.has(result.filePath))
    )
      throw new Error("lintrs did not return every input file exactly once");
    results.sort((a, b) => order.get(a.filePath) - order.get(b.filePath));
    return results;
  } finally {
    await Promise.all(threads.map(worker => worker.terminate()));
    owner?.close();
    if (scratch !== undefined)
      rmSync(scratch, { recursive: true, force: true });
  }
}

if (!isMainThread) {
  try {
    const results = await lintFiles(workerData);
    parentPort.postMessage({ results, profile: profiler()?.snapshot() });
  } catch (error) {
    parentPort.postMessage({ failure: describeFailure(error) });
  }
}

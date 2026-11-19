// Workers resolve their own file configurations, then share one type-checker
// session. Native libraries build at the preparation barrier, before parsing.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, flushCompileCache } from "node:module";
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
import { discoverFiles, selectFiles } from "./engine.mjs";
import { tsrsSdkRoot } from "./type-services/sdk.mjs";
import { profiler } from "./profile.mjs";
import { inlineConfigs } from "./inline-config.mjs";
import { scopeConfig } from "./config-scope.mjs";

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
      requireNative: options.requireNative,
      loadedConfig: options.loadedConfig,
      inlineOverrides: options.inlineOverrides,
    }),
  );
}

function runWorker(options, env, threads, profiles) {
  const prepared = Promise.withResolvers();
  const completed = Promise.withResolvers();
  completed.promise.catch(() => {});
  const worker = new Worker(new URL(import.meta.url), {
    workerData: options,
    env,
  });
  threads.push(worker);
  const fail = error => {
    prepared.reject(error);
    completed.reject(error);
  };
  let results;
  worker.on("message", message => {
    if (message.failure !== undefined) fail(new Error(message.failure));
    else if (message.prepared !== undefined) prepared.resolve(message.prepared);
    else {
      results = message.results;
      if (message.profile !== undefined) profiles?.push(message.profile);
    }
  });
  worker.on("error", fail);
  worker.on("exit", code => {
    if (code !== 0 || results === undefined)
      fail(new Error(`lintrs worker exited ${code}`));
    else completed.resolve(results);
  });
  return { worker, prepared: prepared.promise, completed: completed.promise };
}

/** `profiles`, when given, collects each worker thread's profiler snapshot
 * (TIMING); the single-thread path profiles into the caller's thread. */
export async function lint({
  configPath,
  paths,
  quiet,
  requireNative,
  concurrency,
  profiles,
}) {
  const loadedConfig = await loadConfig(configPath);
  const { configs } = loadedConfig;
  const files = discoverFiles(paths, configs);
  if (files.length === 0) throw new Error("No configured files selected");
  const workers = workerCount(files.length, concurrency);
  if (workers === 1)
    return lintFiles({
      configPath,
      files,
      quiet,
      requireNative,
      loadedConfig: await scopeConfig(loadedConfig, files),
    });
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
    // Workers need the parent's compiled configuration before it exits.
    flushCompileCache();
    const running = Array.from({ length: workers }, (_, index) => {
      const parserCopy = join(scratch, `oxlint-${index}.node`);
      copyFileSync(parserBinding, parserCopy);
      return runWorker(
        {
          configPath,
          quiet,
          requireNative,
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
    });
    const preparations = await Promise.all(running.map(item => item.prepared));
    const selected = preparations.flatMap(item => item.files);
    if (selected.length === 0) throw new Error("No configured files selected");
    const resolved = new Set();
    for (const preparation of preparations)
      for (const meta of preparation.libraries) {
        const key = JSON.stringify(meta);
        if (resolved.has(key)) continue;
        resolved.add(key);
        resolveNativeLibrary(meta);
      }
    for (const item of running) item.worker.postMessage("start");
    const results = (
      await Promise.all(running.map(item => item.completed))
    ).flat();
    // Keep the single-thread order (the engine's code-unit sort) so output
    // is identical regardless of --concurrency.
    const order = new Map(
      selected.map((file, index) => [resolve(file), index]),
    );
    if (
      results.length !== selected.length ||
      new Set(results.map(result => result.filePath)).size !==
        selected.length ||
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
    const loadedConfig = await scopeConfig(
      await loadConfig(workerData.configPath),
      workerData.files,
    );
    const files = selectFiles(workerData.files, loadedConfig.configs, {
      allowEmpty: true,
    });
    const inlineOverrides = inlineConfigs(
      files,
      loadedConfig.configs,
      loadedConfig.rules,
    );
    const libraries = new Set();
    for (const file of files)
      for (const [id, setting] of Object.entries(
        (inlineOverrides.get(file) ?? loadedConfig.configs.getConfig(file))
          .rules ?? {},
      )) {
        if (setting[0] === 0 || (workerData.quiet && setting[0] === 1))
          continue;
        const meta = loadedConfig.rules.get(id)?.meta?.lintrs;
        if (meta?.native !== true) continue;
        const { plugin, rule, crate, prebuilt, root } = meta;
        libraries.add(JSON.stringify({ plugin, rule, crate, prebuilt, root }));
      }
    const start = new Promise(resolve => parentPort.once("message", resolve));
    parentPort.postMessage({
      prepared: {
        files,
        libraries: [...libraries].map(value => JSON.parse(value)),
      },
    });
    await start;
    const results =
      files.length === 0
        ? []
        : await lintFiles({
            ...workerData,
            files,
            loadedConfig,
            inlineOverrides,
          });
    parentPort.postMessage({ results, profile: profiler()?.snapshot() });
  } catch (error) {
    parentPort.postMessage({ failure: describeFailure(error) });
  }
}

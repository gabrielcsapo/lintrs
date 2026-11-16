import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

function describeFailure(error) {
  return error instanceof AggregateError
    ? `${error.stack}\n${error.errors.map(describeFailure).join("\n")}`
    : error instanceof Error
      ? (error.stack ?? String(error))
      : String(error);
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

function runWorker(options, env, threads) {
  return new Promise((resolveWorker, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: options,
      env,
    });
    threads.push(worker);
    let results;
    worker.on("message", message => {
      if (message.failure !== undefined) reject(new Error(message.failure));
      else results = message.results;
    });
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0 || results === undefined)
        reject(new Error(`rlint worker exited ${code}`));
      else resolveWorker(results);
    });
  });
}

export async function runWorkspace() {
  // The tsrs SDK's #enums/* imports resolve to TypeScript sources only under
  // these flags; re-exec once so direct `node workspace.mjs` works too.
  const sdkFlags = [
    "--conditions=@typescript/source",
    "--experimental-transform-types",
  ];
  if (!sdkFlags.every(flag => process.execArgv.includes(flag))) {
    const { status, error } = spawnSync(
      process.execPath,
      [
        ...sdkFlags,
        ...process.execArgv,
        import.meta.filename,
        ...process.argv.slice(2),
      ],
      { stdio: "inherit", env: process.env },
    );
    if (error !== undefined) throw error;
    process.exit(status ?? 2);
  }
  const started = performance.now();
  const workspace = resolve(process.env.INIT_CWD ?? process.cwd());
  process.chdir(workspace);
  const manifestPath = join(workspace, "package.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { name: basename(workspace) };
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { quiet: { type: "boolean", default: false } },
  });
  if (positionals.length === 0)
    throw new Error("Workspace lint requires at least one source glob");
  const timing = {
    workspace: manifest.name,
    engine: "rlint",
    quiet: values.quiet,
    complete: false,
  };
  let scratch;
  let owner;
  const threads = [];
  try {
    const workers = Number(process.env.RLINT_WORKERS ?? "1");
    const rustThreads = Number(process.env.RLINT_RUST_THREADS ?? workers);
    if (
      ![workers, rustThreads].every(
        value => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error(
        "RLINT_WORKERS and RLINT_RUST_THREADS must be positive integers",
      );
    process.env.RAYON_NUM_THREADS = String(rustThreads);
    process.env.RLINT_OXLINT_THREADS = String(
      Math.max(1, Math.floor(rustThreads / workers)),
    );
    process.env.RLINT_TYPED_NATIVE = "1";
    process.env.RLINT_TRUE_BULK = "1";
    process.env.RLINT_CONTEXTUAL_BATCH = "1";
    const distBinary = join(import.meta.dirname, "../bin/rlint");
    process.env.RLINT_BINARY ??= existsSync(distBinary)
      ? distBinary
      : join(root, "target/rlint-native/bin/rlint");
    scratch = mkdtempSync(join(tmpdir(), "rlint-workspace-"));
    if (process.env.RLINT_IN_PROCESS_BINDING === undefined) {
      // The binding must be loaded in place: librlint.node NEEDs
      // @rpath/librlint.* and libstd resolved relative to its own directory,
      // so a copy would fail to load (or worse, load a second rlint image).
      const distLibrary = join(import.meta.dirname, "../lib/librlint.node");
      const nativeLibrary = join(root, "target/rlint-native/lib/librlint.node");
      const library = existsSync(distLibrary) ? distLibrary : nativeLibrary;
      if (!existsSync(library))
        throw new Error(
          "Run npm run build:native before running workspace lint",
        );
      process.env.RLINT_IN_PROCESS_BINDING = library;
    }
    const configPath = resolve(
      process.env.ESLINT_CONFIG ?? join(workspace, "eslint.config.mjs"),
    );
    const { loadConfig } = await import("./config.mjs");
    const { createDiscoveryFilter, discoverFiles } =
      await import("./discovery.mjs");
    const { configs } = await loadConfig(configPath);
    const filter = await createDiscoveryFilter(configs, dirname(configPath));
    const selected = new Set(
      positionals.flatMap(pattern =>
        globSync(pattern, { cwd: workspace }).map(file =>
          resolve(workspace, file),
        ),
      ),
    );
    const files = discoverFiles(workspace, filter).filter(file =>
      selected.has(file),
    );
    const count = files.length < 400 ? 1 : Math.min(workers, files.length);
    timing.expectedFiles = files.length;
    timing.discoveryMs = performance.now() - started;
    timing.workers = count;
    timing.rustThreads = rustThreads;
    let results;
    if (files.length === 0)
      throw new Error("No workspace source files match the lint configuration");
    else if (count === 1) {
      results = await lintFiles({ configPath, files, quiet: values.quiet });
    } else {
      const binding = require(process.env.RLINT_IN_PROCESS_BINDING);
      owner = binding.createSession(workspace);
      const token = owner.share();
      const oxlintRequire = createRequire(
        require.resolve("oxlint/package.json"),
      );
      const bindingName = {
        darwin: `darwin-${process.arch}`,
        linux: `linux-${process.arch}-gnu`,
        win32: `win32-${process.arch}-msvc`,
      }[process.platform];
      if (bindingName === undefined)
        throw new Error(
          `rlint workers are not supported on ${process.platform}`,
        );
      const parserBinding = oxlintRequire.resolve(
        `@oxlint/binding-${bindingName}`,
      );
      const parserLoader = pathToFileURL(
        join(
          dirname(require.resolve("oxlint/package.json")),
          "dist/bindings.js",
        ),
      ).href;
      results = (
        await Promise.all(
          Array.from({ length: count }, (_, index) => {
            const parserCopy = join(scratch, `oxlint-${index}.node`);
            copyFileSync(parserBinding, parserCopy);
            return runWorker(
              {
                configPath,
                quiet: values.quiet,
                files: files.slice(
                  Math.floor((index * files.length) / count),
                  Math.floor(((index + 1) * files.length) / count),
                ),
                parserBinding: parserCopy,
                parserLoader,
              },
              { ...process.env, RLINT_SHARED_SESSION: token },
              threads,
            );
          }),
        )
      ).flat();
      timing.sharedState = JSON.parse(owner.timing()).shared;
    }
    results.sort((a, b) => a.filePath.localeCompare(b.filePath));
    const expectedFiles = new Set(files);
    if (
      results.some(result => !expectedFiles.has(result.filePath)) ||
      results.length !== files.length ||
      new Set(results.map(result => result.filePath)).size !== files.length
    )
      throw new Error(
        "rlint did not return every workspace input exactly once",
      );
    timing.files = results.length;
    timing.errors = results.reduce((sum, result) => sum + result.errorCount, 0);
    timing.warnings = results.reduce(
      (sum, result) => sum + result.warningCount,
      0,
    );
    const report = values.quiet
      ? results.filter(result => result.errorCount > 0)
      : results;
    writeFileSync("eslint-output.json", JSON.stringify(report));
    const { formatUnix } = await import("./results.mjs");
    process.stdout.write(formatUnix(report));
    timing.complete = true;
    process.exitCode = timing.errors > 0 ? 1 : 0;
  } catch (error) {
    timing.failure = describeFailure(error);
    throw error;
  } finally {
    await Promise.all(threads.map(worker => worker.terminate()));
    owner?.close();
    if (scratch !== undefined)
      rmSync(scratch, { recursive: true, force: true });
    timing.durationMs = performance.now() - started;
    timing.peakProcessRss = process.resourceUsage().maxRSS * 1024;
    writeFileSync("lint-timing.json", JSON.stringify(timing, null, 2));
  }
}

if (!isMainThread) {
  try {
    parentPort.postMessage({ results: await lintFiles(workerData) });
  } catch (error) {
    parentPort.postMessage({ failure: describeFailure(error) });
  }
} else if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(import.meta.filename)
) {
  runWorkspace().catch(error => {
    process.stderr.write(`rlint: ${describeFailure(error)}\n`);
    process.exitCode = 2;
  });
}

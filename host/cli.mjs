import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  formatTiming,
  merge,
  profiler,
  summarize,
  timingLimit,
} from "./profile.mjs";
import { formatUnix } from "./results.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      quiet: { type: "boolean", default: false },
      "require-native": { type: "boolean", default: false },
      "files-report": { type: "string" },
      format: { type: "string", default: "unix" },
      concurrency: { type: "string", default: "off" },
    },
  });
  const concurrency = values.concurrency;
  if (
    concurrency !== "off" &&
    concurrency !== "auto" &&
    !(Number.isSafeInteger(Number(concurrency)) && Number(concurrency) > 0)
  )
    throw new Error(
      `--concurrency expects a positive integer, "auto", or "off"; found ${JSON.stringify(concurrency)}`,
    );
  if (values.config === undefined || process.env.LINTRS_BINARY === undefined) {
    throw new Error(
      "Start the compatibility host through the lintrs Rust binary",
    );
  }
  if (process.env.NODE_V8_COVERAGE === undefined) {
    const cache = enableCompileCache(
      process.env.NODE_COMPILE_CACHE ??
        join(
          process.env.LINTRS_CACHE_DIR ?? join(homedir(), ".cache", "lintrs"),
          "node-compile",
        ),
    );
    if (
      cache.directory !== undefined &&
      process.env.NODE_COMPILE_CACHE === undefined
    )
      process.env.NODE_COMPILE_CACHE = cache.directory;
  }
  const { lint } = await import("./parallel.mjs");
  const profile = profiler();
  const profiles = [];
  const started = performance.now();
  let results = await lint({
    configPath: values.config,
    paths: positionals,
    quiet: values.quiet,
    requireNative: values["require-native"],
    concurrency: /^\d+$/u.test(concurrency) ? Number(concurrency) : concurrency,
    profiles,
  });
  profile?.addWall(performance.now() - started);
  if (values["files-report"] !== undefined)
    writeFileSync(
      values["files-report"],
      `${JSON.stringify(results.map(result => result.filePath))}\n`,
    );
  if (values.quiet) results = results.filter(result => result.errorCount > 0);
  if (values.format === "json") {
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } else {
    process.stdout.write(formatUnix(results));
  }
  process.exitCode = results.some(result => result.errorCount > 0) ? 1 : 0;
  if (profile !== undefined) report(merge([profile.snapshot(), ...profiles]));
}

// TIMING goes to stderr: stdout carries the lint results (and -f json must
// stay parseable), which is where ESLint differs.
function report(snapshot) {
  const limit = timingLimit();
  if (limit !== undefined) process.stderr.write(formatTiming(snapshot, limit));
  const path = process.env.LINTRS_TYPE_PROFILE;
  if (path !== undefined && path !== "") {
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // No type-service profile was written (an untyped run); start fresh.
    }
    writeFileSync(
      path,
      JSON.stringify({ ...existing, timing: summarize(snapshot) }, null, 2),
    );
  }
}

main().catch(error => {
  const details =
    error instanceof AggregateError
      ? error.errors.map(item => String(item)).join("\n")
      : String(error);
  process.stderr.write(`lintrs: ${details}\n`);
  process.exitCode = 2;
});

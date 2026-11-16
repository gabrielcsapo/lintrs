import { parseArgs } from "node:util";

import { runHost } from "./engine.mjs";
import { finalizeHost, formatUnix } from "./results.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      quiet: { type: "boolean", default: false },
      format: { type: "string", default: "unix" },
    },
  });
  if (values.config === undefined || process.env.RLINT_BINARY === undefined) {
    throw new Error(
      "Start the compatibility host through the rlint Rust binary",
    );
  }
  const result = await runHost({
    configPath: values.config,
    paths: positionals,
    quiet: values.quiet,
  });
  let results = finalizeHost(result);
  if (values.quiet) results = results.filter(result => result.errorCount > 0);
  if (values.format === "json") {
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } else {
    process.stdout.write(formatUnix(results));
  }
  process.exitCode = results.some(result => result.errorCount > 0) ? 1 : 0;
}

main().catch(error => {
  const details =
    error instanceof AggregateError
      ? error.errors.map(item => String(item)).join("\n")
      : String(error);
  process.stderr.write(`rlint: ${details}\n`);
  process.exitCode = 2;
});

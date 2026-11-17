// The lintrs binary's helper modes (`--finalize-host`, `--host-comments`,
// `--parse-graphql`), run in process through the binding when it is loaded.
//
// Spawning the binary from the host forks the host process. Once oxlint has
// allocated its raw-transfer buffers (about 6 GiB of writable memory per
// parser thread), Linux's default heuristic overcommit refuses to duplicate
// it and the spawn fails with ENOMEM; --concurrency workers share the process,
// so one worker's buffers break another's spawn. The binding runs the same
// Rust code with no child process. Without a binding (the pipe transport) or
// with an older one, the binary is spawned as before.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

// The binary prints failures with these prefixes; keep them in process.
const prefixes = {
  "finalize-host": "lintrs",
  "host-comments": "lintrs comment parser",
  "parse-graphql": "lintrs GraphQL parser",
};

let resolved;
function inProcess() {
  if (resolved === undefined) {
    const path = process.env.LINTRS_IN_PROCESS_BINDING;
    const binding =
      path === undefined || !isAbsolute(path)
        ? undefined
        : createRequire(import.meta.url)(path);
    resolved =
      typeof binding?.hostCommand === "function" ? binding.hostCommand : null;
  }
  return resolved ?? undefined;
}

/** Runs helper `mode` on `input` (a JSON string); returns its JSON output. */
export function hostCommand(mode, input, maxBuffer) {
  const command = inProcess();
  if (command !== undefined) {
    try {
      return command(mode, input);
    } catch (error) {
      throw new Error(`${prefixes[mode]}: ${error.message}`);
    }
  }
  if (process.env.LINTRS_BINARY === undefined)
    throw new Error("The Rust host binary is missing");
  const result = spawnSync(process.env.LINTRS_BINARY, [`--${mode}`], {
    input,
    encoding: "utf8",
    maxBuffer,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout;
}

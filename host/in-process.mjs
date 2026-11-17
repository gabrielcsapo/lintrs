import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const installed = new Set();

// Node refuses to strip types from files under node_modules, which also
// rejects this client shim when lintrs is installed from npm. Stage a copy
// under the lintrs cache, keyed by the installed package version.
function clientUrl() {
  const here = fileURLToPath(
    new URL("./in-process-client.mjs", import.meta.url),
  );
  if (!here.split(sep).includes("node_modules")) return here;
  const version = JSON.parse(
    readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
  ).version;
  const staged = join(
    process.env.LINTRS_CACHE_DIR ?? join(homedir(), ".cache", "lintrs"),
    `lintrs-host-${version}`,
    "in-process-client.mjs",
  );
  if (!existsSync(staged)) {
    mkdirSync(join(staged, ".."), { recursive: true });
    copyFileSync(here, staged);
  }
  return staged;
}

export function installInProcessClient(source) {
  source = realpathSync(source);
  if (installed.has(source)) return;
  if (typeof registerHooks !== "function")
    throw new Error("The in-process bridge requires Node.js 24");
  const original = pathToFileURL(join(source, "api/sync/client.ts")).href;
  const replacement = pathToFileURL(clientUrl());
  replacement.searchParams.set("sdk", source);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      return result.url === original
        ? { ...result, url: replacement.href }
        : result;
    },
  });
  installed.add(source);
}

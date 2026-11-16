import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const installed = new Set();

export function installInProcessClient(source) {
  source = realpathSync(source);
  if (installed.has(source)) return;
  if (typeof registerHooks !== "function")
    throw new Error("The in-process bridge requires Node.js 24");
  const original = pathToFileURL(join(source, "api/sync/client.ts")).href;
  const replacement = new URL("./in-process-client.mjs", import.meta.url);
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

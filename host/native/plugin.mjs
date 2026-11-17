import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The plugin package's own directory: the module that called nativePlugin.
function callerDirectory() {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const match = /\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?$/u.exec(line.trim());
    if (match === null) continue;
    const file = match[1].startsWith("file:")
      ? fileURLToPath(match[1])
      : match[1];
    if (file !== fileURLToPath(import.meta.url)) return dirname(file);
  }
  return process.cwd();
}

/**
 * Declares an ESLint plugin whose rules are implemented in Rust and run under
 * lintrs. Under plain ESLint the stubs fail loudly.
 *
 * `crate` — path/URL of a local Rust rule crate (built from source by lintrs).
 * `prebuilt` — map of platform keys (`darwin-arm64`, `linux-x64-gnu`, …) to
 * npm package names shipping a compiled rule library.
 */
export function nativePlugin({ name, rules, crate, prebuilt }) {
  if (typeof name !== "string" || name.length === 0)
    throw new Error("nativePlugin: a plugin name is required");
  if (!Array.isArray(rules) || rules.length === 0)
    throw new Error("nativePlugin: rules must list exported rule names");
  const root = callerDirectory();
  return {
    meta: { name, version: "0.0.0" },
    rules: Object.fromEntries(
      rules.map(rule => [
        rule,
        {
          meta: {
            schema: false,
            lintrs: {
              native: true,
              plugin: name,
              rule,
              crate:
                crate === undefined
                  ? undefined
                  : crate instanceof URL
                    ? fileURLToPath(crate)
                    : resolve(String(crate)),
              prebuilt,
              root,
            },
          },
          create() {
            throw new Error(
              `${name}/${rule} is a native lintrs rule; run it with lintrs`,
            );
          },
        },
      ]),
    ),
  };
}

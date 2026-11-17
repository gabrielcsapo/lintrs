import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildCrate, platformKey } from "./build.mjs";
import { nativeAbi } from "./home.mjs";

// meta.lintrs → the rule library on disk. Prebuilt packages are resolved
// through Node resolution from the plugin's root; otherwise the crate is
// built (and cached) from source.
export function resolveNativeLibrary(meta) {
  const { plugin, rule, crate, prebuilt, root } = meta;
  if (prebuilt !== undefined) {
    const key = platformKey();
    const packageName = prebuilt[key];
    if (packageName !== undefined) {
      const require = createRequire(join(root, "noop.js"));
      let manifestPath;
      try {
        manifestPath = require.resolve(`${packageName}/package.json`);
      } catch (error) {
        throw new Error(
          `Cannot resolve the prebuilt native rules package ` +
            `${packageName} for ${plugin}/${rule} from ${root}: ${error.message}`,
        );
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const { library, abi } = manifest.lintrs ?? {};
      if (library === undefined)
        throw new Error(
          `${packageName} has no "lintrs".library entry in its package.json`,
        );
      const expected = nativeAbi();
      if (abi !== expected)
        throw new Error(
          `${packageName} was built for ABI "${abi}" but this lintrs is ` +
            `"${expected}"; install the rule package matching your lintrs version`,
        );
      const path = join(manifestPath, "..", library);
      if (!existsSync(path))
        throw new Error(`${packageName} is missing its rule library ${path}`);
      return resolve(path);
    }
  }
  if (crate !== undefined) return buildCrate(resolve(root, crate));
  throw new Error(
    `The native rule ${plugin}/${rule} ships neither a crate nor a ` +
      `prebuilt package for ${platformKey()}`,
  );
}

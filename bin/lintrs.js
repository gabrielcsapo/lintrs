#!/usr/bin/env node
// lintrs launcher: resolves the platform package holding the Rust binary and
// forwards to it with the JS host location wired up.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS = {
  "darwin-arm64": "@lintrs/darwin-arm64",
  "linux-x64-gnu": "@lintrs/linux-x64-gnu",
};

const key = `${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : ""}`;
const packageName = PLATFORMS[key];
if (packageName === undefined) {
  console.error(
    `lintrs: unsupported platform ${key}. ` +
      `Supported platforms: ${Object.keys(PLATFORMS).join(", ")}.`,
  );
  process.exit(1);
}

const require = createRequire(import.meta.url);
let packageDir;
try {
  packageDir = dirname(require.resolve(`${packageName}/package.json`));
} catch {
  console.error(
    `lintrs: the platform package ${packageName} is not installed. ` +
      `Install lintrs with optional dependencies enabled ` +
      `(npm i -D @lintrs/cli). Supported platforms: ${Object.keys(PLATFORMS).join(", ")}.`,
  );
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
env.LINTRS_HOST_DIR ??= join(root, "host");
env.LINTRS_IN_PROCESS_BINDING ??= join(packageDir, "lib", "liblintrs.node");
env.LINTRS_TYPED_NATIVE ??= "1";

const result = spawnSync(
  join(packageDir, "bin", "lintrs"),
  process.argv.slice(2),
  {
    stdio: "inherit",
    env,
  },
);
if (result.error !== undefined) {
  console.error(
    `lintrs: failed to start ${packageName}/bin/lintrs: ${result.error.message}`,
  );
  process.exit(1);
}
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function tsrsSdkRoot(root) {
  if (process.env.LINTRS_TSRS_SDK !== undefined)
    return resolve(process.env.LINTRS_TSRS_SDK);
  // Installed distributions ship the SDK next to host/ at <dist>/tsrs-sdk.
  const bundled = join(import.meta.dirname, "../../tsrs-sdk");
  if (existsSync(join(bundled, "package.json"))) return bundled;
  const compiler = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (compiler.error !== undefined) throw compiler.error;
  if (compiler.status !== 0) throw new Error(compiler.stderr.trim());
  const target = /^host: (.+)$/mu.exec(compiler.stdout)?.[1];
  if (target === undefined)
    throw new Error("Cannot determine the Rust host target");
  const metadata = spawnSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--offline",
      "--filter-platform",
      target,
      "--format-version",
      "1",
    ],
    {
      // The pinned tsrs checkout belongs to this lintrs checkout, not the linted project.
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (metadata.error !== undefined) throw metadata.error;
  if (metadata.status !== 0) throw new Error(metadata.stderr.trim());
  // tsrs_api is vendored (vendor/tsrs_api); the SDK lives in the tsrs git
  // checkout, found through any of tsrs's other crates.
  const dependency = JSON.parse(metadata.stdout).packages.find(
    item =>
      item.name.startsWith("tsrs_") &&
      item.source?.startsWith("git+https://github.com/oxc-project/tsrs"),
  );
  if (dependency === undefined)
    throw new Error("The pinned tsrs checkout is missing from Cargo metadata");
  return resolve(dirname(dependency.manifest_path), "../../npm/tsrs");
}

// Node refuses to strip types from files under node_modules. When the SDK
// comes from an installed npm package, stage its sources once per version
// under the lintrs cache and load them from there.
function sdkSource(root) {
  const source = join(tsrsSdkRoot(root), "src");
  if (!source.split(sep).includes("node_modules")) return source;
  const version = JSON.parse(
    readFileSync(join(dirname(source), "package.json"), "utf8"),
  ).version;
  const staged = join(
    process.env.LINTRS_CACHE_DIR ?? join(homedir(), ".cache", "lintrs"),
    `tsrs-sdk-${version}`,
  );
  if (!existsSync(join(staged, "src/api/sync/api.ts"))) {
    mkdirSync(staged, { recursive: true });
    cpSync(dirname(source), staged, { recursive: true });
  }
  return join(staged, "src");
}

export async function loadSdk(root) {
  const source = sdkSource(root);
  if (process.env.LINTRS_IN_PROCESS_BINDING !== undefined) {
    const { installInProcessClient } = await import("../in-process.mjs");
    installInProcessClient(source);
  }
  const [api, ast] = await Promise.all([
    import(pathToFileURL(join(source, "api/sync/api.ts")).href),
    import(pathToFileURL(join(source, "ast/index.ts")).href),
  ]);
  return { api, ast };
}

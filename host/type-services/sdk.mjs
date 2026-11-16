import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function tsrsSdkRoot(root) {
  if (process.env.RLINT_TSRS_SDK !== undefined)
    return resolve(process.env.RLINT_TSRS_SDK);
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
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (metadata.error !== undefined) throw metadata.error;
  if (metadata.status !== 0) throw new Error(metadata.stderr.trim());
  const dependency = JSON.parse(metadata.stdout).packages.find(
    item => item.name === "tsrs_api",
  );
  if (dependency === undefined)
    throw new Error(
      "The pinned tsrs API dependency is missing from Cargo metadata",
    );
  return resolve(dirname(dependency.manifest_path), "../../npm/tsrs");
}

export async function loadSdk(root) {
  const source = join(tsrsSdkRoot(root), "src");
  if (process.env.RLINT_IN_PROCESS_BINDING !== undefined) {
    const { installInProcessClient } = await import("../in-process.mjs");
    installInProcessClient(source);
  }
  const [api, ast] = await Promise.all([
    import(pathToFileURL(join(source, "api/sync/api.ts")).href),
    import(pathToFileURL(join(source, "ast/index.ts")).href),
  ]);
  return { api, ast };
}

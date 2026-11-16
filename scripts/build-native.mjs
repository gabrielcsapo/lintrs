#!/usr/bin/env node
// Builds the native layout in target/rlint-native/:
//   bin/rlint            — the CLI (statically linked libstd)
//   lib/librlint.{dylib,so} — the rlint+tsrs dylib native rules link against
//   lib/libstd-*.{dylib,so} — the shared Rust standard library it NEEDs
//   lib/librlint.node    — thin Node-API wrapper; the in-process binding
//   sdk/deps/*.rlib      — metadata for compiling rule crates via
//                          --extern rlint=<lib>/librlint.* -L dependency=<sdk>/deps
// Usage: node scripts/build-native.mjs [--build <prepared dir>] [--out <dir>]

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  rmSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
// prepare.mjs requires its output outside the repository.
const buildDir = resolve(
  option("--build") ?? join(tmpdir(), "rlint-native-build"),
);
const outDir = resolve(option("--out") ?? join(root, "target/rlint-native"));
const darwin = process.platform === "darwin";
const libraryName = darwin ? "librlint.dylib" : "librlint.so";
const stdPattern = darwin ? /^libstd-.*\.dylib$/u : /^libstd-.*\.so$/u;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${commandArgs.join(" ")} failed`);
}

// prepare.mjs is idempotent: it refreshes the rlint sources and the injected
// tsrs_api, so always run it to keep the prepared tree current.
console.log(`[build-native] preparing ${buildDir}`);
run(
  process.execPath,
  [join(root, "type-api/prepare.mjs"), "--output", buildDir],
  { cwd: root },
);

const manifest = join(buildDir, "Cargo.toml");
// The CLI binary keeps a statically linked standard library; only the dylib
// half links libstd dynamically so rule libraries share everything.
console.log("[build-native] cargo build --release -p rlint (binary)");
run(
  "cargo",
  [
    "build",
    "--offline",
    "--release",
    "--manifest-path",
    manifest,
    "-p",
    "rlint",
    "--bin",
    "rlint",
  ],
  { cwd: root },
);

const nativeTarget = join(buildDir, "target-native");
const preferDynamic = "-C prefer-dynamic";
const rustflags = darwin
  ? `${preferDynamic} -C link-args=-Wl,-undefined,dynamic_lookup`
  : preferDynamic;
console.log(
  "[build-native] cargo build --release -p rlint -p rlint-node (prefer-dynamic)",
);
run(
  "cargo",
  [
    "build",
    "--offline",
    "--release",
    "--manifest-path",
    manifest,
    "-p",
    "rlint",
    "-p",
    "rlint-node",
    "--lib",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      RUSTFLAGS: rustflags,
      CARGO_TARGET_DIR: nativeTarget,
    },
  },
);

const release = join(buildDir, "target/release");
const nativeRelease = join(nativeTarget, "release");
const deps = join(nativeRelease, "deps");

const dylib = join(nativeRelease, libraryName);
const wrapper = join(
  nativeRelease,
  darwin ? "librlint_node.dylib" : "librlint_node.so",
);
for (const artifact of [dylib, wrapper])
  if (!existsSync(artifact)) throw new Error(`Missing ${artifact}`);

if (darwin) {
  // The dylib must advertise @rpath so every consumer (wrapper, rule
  // libraries, dlopen) resolves the one already-loaded image by name.
  execFileSync("install_name_tool", ["-id", `@rpath/${libraryName}`, dylib]);
  const needed = execFileSync("otool", ["-L", wrapper], { encoding: "utf8" });
  const dep = needed
    .split("\n")
    .map(line => line.trim().split(" ")[0])
    .find(line => line.endsWith(libraryName));
  if (dep !== undefined && dep !== `@rpath/${libraryName}`)
    execFileSync("install_name_tool", [
      "-change",
      dep,
      `@rpath/${libraryName}`,
      wrapper,
    ]);
  const rpaths = execFileSync("otool", ["-l", wrapper], { encoding: "utf8" });
  if (!rpaths.includes("@loader_path"))
    execFileSync("install_name_tool", ["-add_rpath", "@loader_path", wrapper]);
  const dylibRpaths = execFileSync("otool", ["-l", dylib], {
    encoding: "utf8",
  });
  if (!dylibRpaths.includes("@loader_path"))
    execFileSync("install_name_tool", ["-add_rpath", "@loader_path", dylib]);
} else {
  execFileSync("patchelf", ["--set-soname", libraryName, dylib]);
  execFileSync("patchelf", ["--set-rpath", "$ORIGIN", wrapper]);
}

// The shared libstd lands in deps/ when anything links it dynamically;
// otherwise take it from the sysroot.
let std = readdirSync(nativeRelease).find(name => stdPattern.test(name));
let stdSource = std === undefined ? undefined : join(nativeRelease, std);
if (stdSource === undefined) {
  std = readdirSync(deps).find(name => stdPattern.test(name));
  stdSource = std === undefined ? undefined : join(deps, std);
}
if (stdSource === undefined) {
  const libdir = execFileSync("rustc", ["--print", "target-libdir"], {
    encoding: "utf8",
  }).trim();
  std = readdirSync(libdir).find(name => stdPattern.test(name));
  stdSource = std === undefined ? undefined : join(libdir, std);
}
if (stdSource === undefined)
  throw new Error(`Missing shared libstd next to ${dylib}`);

// Stage into a clean directory so removed artifacts (e.g. .rmeta files an
// older staging rule copied) never linger in the layout.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "bin"), { recursive: true });
mkdirSync(join(outDir, "lib"), { recursive: true });
mkdirSync(join(outDir, "sdk/deps"), { recursive: true });
cpSync(join(release, "rlint"), join(outDir, "bin/rlint"));
cpSync(dylib, join(outDir, "lib", libraryName));
cpSync(stdSource, join(outDir, "lib", std));
cpSync(wrapper, join(outDir, "lib/librlint.node"));

// What rustc needs when compiling a rule crate: .rlib artifacts (metadata +
// fallback objects) for rlint's dependency crates — each is handed to rustc
// via --extern so types match the facade — plus proc-macro dylibs (serde_derive
// and friends are loaded at compile time).
let copied = 0;
for (const entry of readdirSync(deps)) {
  if (
    !entry.endsWith(".rlib") &&
    !entry.endsWith(".dylib") &&
    !entry.endsWith(".so")
  )
    continue;
  if (
    entry.startsWith("librlint-") ||
    entry.startsWith("librlint_node-") ||
    entry === libraryName ||
    entry === `librlint_node.${libraryName.split(".")[1]}`
  )
    continue;
  cpSync(join(deps, entry), join(outDir, "sdk/deps", entry));
  copied += 1;
}

const size = path => statSync(path).size;
const dirSize = path =>
  readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
const report = {
  out: outDir,
  files: {
    "bin/rlint": size(join(outDir, "bin/rlint")),
    [`lib/${libraryName}`]: size(join(outDir, "lib", libraryName)),
    "lib/librlint.node": size(join(outDir, "lib/librlint.node")),
    [`lib/${std}`]: size(join(outDir, "lib", std)),
    "sdk/deps": { files: copied, bytes: dirSize(join(outDir, "sdk/deps")) },
  },
};
writeFileSync(
  join(outDir, "rlint-native.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));

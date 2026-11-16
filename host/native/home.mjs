import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const libraryName =
  process.platform === "darwin" ? "librlint.dylib" : "librlint.so";

// The assembled native layout: { bin, lib } produced by
// scripts/build-native.mjs (a dist ships lib/ next to host/; the sdk ships
// separately — see sdkDeps()).
export function nativeHome() {
  const candidates = [
    process.env.RLINT_NATIVE_HOME,
    resolve(import.meta.dirname, "../../target/rlint-native"),
    resolve(import.meta.dirname, "../.."), // dist: host/../lib
  ];
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      existsSync(join(candidate, "lib", libraryName))
    )
      return candidate;
  }
  throw new Error(
    "The rlint native layout is missing; run npm run build:native " +
      "(or set RLINT_NATIVE_HOME to a directory containing lib/)",
  );
}

export function nativeLibrary() {
  return join(nativeHome(), "lib", libraryName);
}

function targetName() {
  const suffix = process.platform === "linux" ? "-gnu" : "";
  return `${process.platform}-${process.arch}${suffix}`;
}

function rlintVersion() {
  for (const manifest of [
    join(nativeHome(), "package.json"),
    resolve(import.meta.dirname, "../../package.json"),
  ]) {
    try {
      return JSON.parse(readFileSync(manifest, "utf8")).version;
    } catch {}
  }
  return "unknown";
}

// The rule-crate SDK (sdk/deps) ships as a separate tarball; resolve it via
// RLINT_SDK_DIR, then <prefix>/sdk next to lib/, then the dev layout.
export function sdkDeps() {
  const candidates = [
    process.env.RLINT_SDK_DIR && join(process.env.RLINT_SDK_DIR, "deps"),
    join(nativeHome(), "sdk", "deps"),
    resolve(import.meta.dirname, "../../target/rlint-native/sdk/deps"),
  ];
  for (const candidate of candidates)
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  const artifact = `rlint-sdk-${rlintVersion()}-${targetName()}.tar.gz`;
  throw new Error(
    `Compiling rule crates from source needs the rlint SDK, which is not ` +
      `installed next to ${nativeLibrary()}. Download ${artifact} for this ` +
      `rlint and extract it into ${join(nativeHome(), "sdk")} ` +
      `(or set RLINT_SDK_DIR), or use a prebuilt rule package`,
  );
}

export function nativeDeps() {
  return sdkDeps();
}

export function nativeBinding() {
  return join(nativeHome(), "lib", "librlint.node");
}

// The ABI fingerprint this binding was built with; rule libraries and
// prebuilt packages must match it exactly.
export function nativeAbi() {
  const require = createRequire(import.meta.url);
  const binding = require(nativeBinding());
  if (typeof binding.nativeAbi !== "function")
    throw new Error(`${nativeBinding()} does not export nativeAbi`);
  return binding.nativeAbi();
}

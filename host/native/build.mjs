#!/usr/bin/env node
// Builds a native rule crate against the installed lintrs facade, or packages
// a prebuilt library for one platform.
//
//   node host/native/build.mjs <crate-dir>                → build into cache
//   node host/native/build.mjs <crate-dir> --out <dir>    → platform package
//
// Rule crates must NOT declare `lintrs` as a Cargo dependency: they compile
// against the lintrs dylib via --extern so exactly one copy of lintrs+tsrs
// exists in the linting process.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { nativeAbi, nativeDeps, nativeLibrary } from "./home.mjs";

const libraryExtension = process.platform === "darwin" ? "dylib" : "so";

export function platformKey() {
  return `${osPlatform()}-${process.arch}${osPlatform() === "linux" ? "-gnu" : ""}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
}

// A rule crate must consume the facade through --extern, never through a
// Cargo dependency (that would statically embed a second lintrs+tsrs copy).
function checkManifest(crateDir) {
  const manifestPath = join(crateDir, "Cargo.toml");
  if (!existsSync(manifestPath))
    throw new Error(`No Cargo.toml in ${crateDir}`);
  const manifest = readFileSync(manifestPath, "utf8");
  const header = /^\[([^\]]+)\]$/gmu;
  const marks = [...manifest.matchAll(header)];
  const declared = [];
  for (const [index, mark] of marks.entries()) {
    const section = mark[1].trim();
    const body = manifest.slice(
      mark.index + mark[0].length,
      marks[index + 1]?.index,
    );
    if (!/^(?:dev-|build-)?dependencies\b/u.test(section)) continue;
    if (/^\s*lintrs\s*=/mu.test(body))
      throw new Error(
        `${manifestPath} depends on the lintrs crate; rule crates compile ` +
          "against lintrs through --extern instead — remove the dependency",
      );
    for (const dep of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gmu))
      declared.push(dep[1]);
  }
  // Any crate that is also part of lintrs's graph cannot be a plugin
  // dependency: rustc would see two candidates for the name (the sdk's
  // --extern artifact and the plugin's own build) and either fail with an
  // ambiguity error or, worse, link an ABI-incompatible instance at the
  // boundary. Boundary types must come through the facade instead.
  const provided = new Set(
    readdirSync(nativeDeps())
      .map(
        file =>
          /^lib(.+)-[0-9a-f]{16}\.(?:rlib|rmeta|dylib|so)$/u.exec(file)?.[1],
      )
      .filter(Boolean),
  );
  const collisions = declared.filter(dep =>
    provided.has(dep.replaceAll("-", "_")),
  );
  if (collisions.length > 0)
    throw new Error(
      `${manifestPath} depends on ${collisions.join(", ")}, which ` +
        `lintrs already ships in its dependency graph; rule crates cannot ` +
        `depend on crates lintrs contains — use the facade's re-exports ` +
        `(lintrs::native::serde_json, lintrs::native::Value, lintrs::ts::*) or ` +
        `a crate lintrs does not contain`,
    );
  const crateTypeCdylib = /crate-type\s*=\s*\[[^\]]*"cdylib"/u.test(manifest);
  const name = /^\s*name\s*=\s*"([^"]+)"/mu.exec(manifest)?.[1];
  if (name === undefined)
    throw new Error(`${manifestPath} does not name a package`);
  return { name, crateTypeCdylib };
}

function hashCrate(crateDir) {
  const hash = createHash("sha256");
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "target" || entry.name === ".git") continue;
        walk(path);
      } else {
        hash.update(relative(crateDir, path));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(crateDir);
  return hash.digest("hex");
}

export function cacheRoot() {
  return join(
    process.env.LINTRS_CACHE_DIR ?? join(homedir(), ".cache", "lintrs"),
    "native-rules",
  );
}

// mkdir is atomic on every supported filesystem; the lock dir holds a
// done-marker so crashed builds can be retried.
function withLock(directory, action) {
  const lock = `${directory}.lock`;
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 1199)
        throw new Error(`Timed out waiting for the build lock ${lock}`);
      const until = Date.now() + 100;
      while (Date.now() < until);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Builds `crateDir` and returns the path of the produced rule library.
 * Results are cached under LINTRS_CACHE_DIR / ~/.cache/lintrs keyed by the ABI
 * fingerprint and the crate contents.
 */
export function buildCrate(crateDir) {
  crateDir = resolve(crateDir);
  const { name, crateTypeCdylib } = checkManifest(crateDir);
  const abi = nativeAbi();
  const key = createHash("sha256")
    .update(abi)
    .update(hashCrate(crateDir))
    .digest("hex")
    .slice(0, 24);
  const entry = join(cacheRoot(), `${name.replaceAll("-", "_")}-${key}`);
  const library = join(
    entry,
    `lib${name.replaceAll("-", "_")}.${libraryExtension}`,
  );
  if (existsSync(library)) return library;
  mkdirSync(cacheRoot(), { recursive: true });
  return withLock(entry, () => {
    if (existsSync(library)) return library;
    // The rule library must be produced by the same rustc that compiled the
    // binding; mismatched compilers produce incompatible Rust symbols.
    const fingerprintRustc = /\/rustc-([^/]+)/u.exec(abi)?.[1];
    const installHint =
      `install it with \`rustup toolchain install ${fingerprintRustc}\` ` +
      "or use a prebuilt rule package";
    const toolchainEnv = {};
    const rustup = spawnSync("rustup", ["--version"], { encoding: "utf8" });
    if (rustup.error === undefined && rustup.status === 0) {
      // rustup selects the toolchain: use the fingerprint's rustc no matter
      // what the caller's default toolchain is.
      const probe = spawnSync("rustc", ["-V"], {
        encoding: "utf8",
        env: { ...process.env, RUSTUP_TOOLCHAIN: fingerprintRustc },
      });
      const version = probe.stdout?.trim();
      if (
        probe.error !== undefined ||
        probe.status !== 0 ||
        !version.startsWith(`rustc ${fingerprintRustc}`)
      )
        throw new Error(
          `Native rule crates must be built with rustc ${fingerprintRustc}; ` +
            installHint,
        );
      toolchainEnv.RUSTUP_TOOLCHAIN = fingerprintRustc;
    } else {
      let rustc;
      try {
        rustc = execFileSync("rustc", ["-V"], { encoding: "utf8" }).trim();
      } catch {
        throw new Error(
          "Building a native rule crate requires the Rust toolchain on PATH " +
            `(this lintrs needs rustc ${fingerprintRustc}); install it from ` +
            "https://rustup.rs or use a prebuilt rule package",
        );
      }
      if (!rustc.startsWith(`rustc ${fingerprintRustc}`))
        throw new Error(
          `Native rule crates must be built with rustc ${fingerprintRustc} ` +
            `(found ${rustc}); ${installHint}`,
        );
    }
    const target = join(entry, "target");
    const rustflags =
      process.platform === "darwin"
        ? "-C prefer-dynamic -C link-args=-Wl,-undefined,dynamic_lookup"
        : "-C prefer-dynamic";
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "build.log"), `cargo rustc\n`);
    // Every dep artifact from the lintrs build is offered via --extern so
    // types shared with the facade (serde_json::Value, tsrs AST) are the
    // exact same crate instances; the crate's own Cargo deps cover the rest.
    const externs = [];
    for (const file of readdirSync(nativeDeps())) {
      const match = /^lib(.+)-[0-9a-f]{16}\.rlib$/u.exec(file);
      if (match === null) continue;
      externs.push("--extern", `${match[1]}=${join(nativeDeps(), file)}`);
    }
    run(
      "cargo",
      [
        "rustc",
        "--release",
        "--lib",
        ...(crateTypeCdylib ? [] : ["--crate-type", "cdylib"]),
        "--manifest-path",
        join(crateDir, "Cargo.toml"),
        "--target-dir",
        target,
        "--",
        "--extern",
        `lintrs=${nativeLibrary()}`,
        ...externs,
        "-L",
        `dependency=${nativeDeps()}`,
      ],
      { env: { ...process.env, RUSTFLAGS: rustflags, ...toolchainEnv } },
    );
    const release = join(target, "release");
    const built = readdirSync(release).find(
      file =>
        file.startsWith(`lib${name.replaceAll("-", "_")}`) &&
        file.endsWith(`.${libraryExtension}`),
    );
    if (built === undefined)
      throw new Error(`cargo produced no cdylib in ${release}`);
    cpSync(join(release, built), library);
    writeFileSync(
      join(entry, "build.log"),
      `built ${new Date().toISOString()}\n`,
    );
    rmSync(target, { recursive: true, force: true });
    return library;
  });
}

/** Packages an already-buildable crate as a prebuilt platform package. */
export function packageCrate(crateDir, outDir) {
  const library = buildCrate(crateDir);
  mkdirSync(outDir, { recursive: true });
  const file = basename(library);
  cpSync(library, join(outDir, file));
  const manifest = readFileSync(join(resolve(crateDir), "Cargo.toml"), "utf8");
  const pkg = /name\s*=\s*"([^"]+)"/u.exec(manifest)?.[1];
  const version = /version\s*=\s*"([^"]+)"/u.exec(manifest)?.[1] ?? "0.0.0";
  writeFileSync(
    join(outDir, "package.json"),
    JSON.stringify(
      {
        name: `lintrs-rule-${pkg}-${platformKey()}`,
        version,
        lintrs: { library: file, abi: nativeAbi() },
      },
      null,
      2,
    ) + "\n",
  );
  return join(outDir, file);
}

if (process.argv[1] !== undefined) {
  // Compare realpaths: invocation through a symlinked prefix (e.g. /tmp on
  // macOS) must still recognize itself.
  const invoked = realpathSync(process.argv[1]);
  const self = realpathSync(fileURLToPath(import.meta.url));
  if (invoked === self) {
    const { values, positionals } = parseArgs({
      options: { out: { type: "string" } },
      allowPositionals: true,
    });
    const crateDir = positionals[0];
    if (crateDir === undefined) {
      console.error(
        "usage: build.mjs <crate-dir> [--out <platform package dir>]",
      );
      process.exit(1);
    }
    const result =
      values.out === undefined
        ? buildCrate(crateDir)
        : packageCrate(crateDir, resolve(values.out));
    console.log(result);
  }
}

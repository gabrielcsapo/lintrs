// Stages and packs the lintrs npm packages for the CURRENT platform:
//   dist/npm/lintrs/            the JS host + tsrs SDK + bin/lintrs.js launcher
//   dist/npm/@lintrs/<target>/  the Rust binary, dylibs and .node binding
// Run `npm run build:native` first so target/lintrs-native exists.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist/npm");

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout;
}

// Locate the tsrs SDK the same way scripts/dist.mjs does: through the Cargo
// metadata of the prepared build directory (defaults to the standard one).
const native = join(root, "target/lintrs-native");
const libraryName =
  process.platform === "darwin" ? "liblintrs.dylib" : "liblintrs.so";
for (const artifact of [
  join(native, "bin/lintrs"),
  join(native, "lib", libraryName),
  join(native, "lib/liblintrs.node"),
])
  if (!existsSync(artifact))
    throw new Error(`Missing ${artifact}; run npm run build:native first`);

const markerPath = join(
  process.env.LINTRS_PREPARED_BUILD ?? "/tmp/lintrs-native-build",
  "lintrs-build.json",
);
if (!existsSync(markerPath))
  throw new Error(
    `Missing ${markerPath}; run npm run prepare:native -- --output <dir> first`,
  );
const build = dirname(markerPath);
const target = /^host: (.+)$/mu.exec(command("rustc", ["-vV"]))?.[1];
if (target === undefined) throw new Error("Cannot determine Rust host target");
const metadata = JSON.parse(
  command("cargo", [
    "metadata",
    "--offline",
    "--filter-platform",
    target,
    "--format-version",
    "1",
    "--manifest-path",
    join(build, "Cargo.toml"),
  ]),
);
const sibling = metadata.packages.find(
  item =>
    item.name.startsWith("tsrs_") &&
    item.name !== "tsrs_api" &&
    item.source?.startsWith("git+https://github.com/oxc-project/tsrs"),
);
if (sibling === undefined)
  throw new Error("Cannot locate the tsrs checkout through Cargo metadata");
const tsrs = resolve(dirname(sibling.manifest_path), "../..");
const sdk = join(tsrs, "npm/tsrs");
if (!existsSync(join(sdk, "package.json")))
  throw new Error(`The tsrs SDK is missing at ${sdk}`);

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = manifest.version;
const platformDir =
  { darwin: "@lintrs/darwin-arm64", linux: "@lintrs/linux-x64-gnu" }[
    `${process.platform === "linux" ? "linux" : process.platform}`
  ] ??
  (() => {
    throw new Error(
      `Unsupported platform for npm packing: ${process.platform}`,
    );
  })();

rmSync(out, { recursive: true, force: true });

// ---- Main package: lintrs ----
const main = join(out, "lintrs");
mkdirSync(join(main, "bin"), { recursive: true });
cpSync(join(root, "bin/lintrs.js"), join(main, "bin/lintrs.js"));
cpSync(join(root, "host"), join(main, "host"), {
  recursive: true,
  filter: source =>
    !source.endsWith(".test.mjs") &&
    !source.includes(`${join("host", "test-support")}`) &&
    !source.includes(`${join("host", ".fixture")}`) &&
    !source.includes(`${join("host", ".workspace")}`),
});
cpSync(sdk, join(main, "tsrs-sdk"), {
  recursive: true,
  filter: source =>
    !source.startsWith(join(sdk, "test")) &&
    !/tsconfig[^/]*\.json$/u.test(source),
});
cpSync(join(tsrs, "LICENSE"), join(main, "tsrs-sdk/LICENSE"));
for (const file of ["LICENSE", "NOTICE", "README.md"])
  cpSync(join(root, file), join(main, file));
writeFileSync(
  join(main, "package.json"),
  JSON.stringify(
    {
      name: "lintrs",
      version,
      description: manifest.description,
      license: "MIT",
      type: "module",
      engines: { node: ">=24" },
      repository: {
        type: "git",
        url: "https://github.com/gabrielcsapo/lintrs",
      },
      homepage: "https://gabrielcsapo.github.io/lintrs/",
      bin: { lintrs: "bin/lintrs.js" },
      exports: {
        "./native": "./host/native/index.mjs",
        "./package.json": "./package.json",
      },
      files: ["bin", "host", "tsrs-sdk", "LICENSE", "NOTICE", "README.md"],
      dependencies: {
        eslint: manifest.dependencies.eslint,
        oxlint: manifest.dependencies.oxlint,
        typescript: manifest.dependencies.typescript,
      },
      optionalDependencies: {
        "@lintrs/darwin-arm64": version,
        "@lintrs/linux-x64-gnu": version,
      },
    },
    null,
    2,
  ) + "\n",
);

// ---- Platform package: @lintrs/<platform> ----
const platform = join(out, platformDir);
mkdirSync(join(platform, "bin"), { recursive: true });
mkdirSync(join(platform, "lib"), { recursive: true });
cpSync(join(native, "bin/lintrs"), join(platform, "bin/lintrs"));
cpSync(join(native, "lib"), join(platform, "lib"), { recursive: true });
cpSync(join(root, "LICENSE"), join(platform, "LICENSE"));
const platformManifest = {
  name: platformDir,
  version,
  description: `Prebuilt lintrs binary for ${platformDir.split("/")[1]}`,
  license: "MIT",
  repository: { type: "git", url: "https://github.com/gabrielcsapo/lintrs" },
  files: ["bin", "lib"],
};
if (process.platform === "darwin") {
  platformManifest.os = ["darwin"];
  platformManifest.cpu = ["arm64"];
} else {
  platformManifest.os = ["linux"];
  platformManifest.cpu = ["x64"];
  platformManifest.libc = ["glibc"];
}
writeFileSync(
  join(platform, "package.json"),
  JSON.stringify(platformManifest, null, 2) + "\n",
);

for (const directory of [main, platform]) {
  const packed = command("npm", ["pack", "--pack-destination", out], {
    cwd: directory,
  }).trim();
  process.stdout.write(`${join(out, packed.split("\n").pop())}\n`);
}

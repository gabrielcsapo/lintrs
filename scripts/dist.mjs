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
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: { build: { type: "string" } },
});
if (values.build === undefined)
  throw new Error("Specify --build <prepared native build directory>");
const build = resolve(values.build);
const marker = JSON.parse(
  readFileSync(join(build, "rlint-build.json"), "utf8"),
);
if (marker.root !== root)
  throw new Error(`${build} was not prepared from this repository`);

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

const target = /^host: (.+)$/mu.exec(command("rustc", ["-vV"]))?.[1];
if (target === undefined) throw new Error("Cannot determine Rust host target");

// The dist ships the assembled native layout: bin/rlint plus lib/ holding
// the rlint dylib, the .node binding wrapper and the shared libstd. The
// sdk/ tree (metadata for compiling rule crates from source) is published as
// a separate tarball — runtime users with prebuilt rules never need it.
const native = join(root, "target/rlint-native");
const libraryName =
  process.platform === "darwin" ? "librlint.dylib" : "librlint.so";
for (const artifact of [
  join(native, "bin/rlint"),
  join(native, "lib", libraryName),
  join(native, "lib/librlint.node"),
  join(native, "sdk/deps"),
])
  if (!existsSync(artifact))
    throw new Error(`Missing ${artifact}; run npm run build:native first`);

// The prepared manifest keeps tsrs's other crates as git dependencies, so the
// SDK inside the Cargo checkout is located through one of them.
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
const name = `rlint-${manifest.version}-${target}`;
const staging = join(root, "dist", name);
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "bin"), { recursive: true });
cpSync(join(native, "bin/rlint"), join(staging, "bin/rlint"));
cpSync(join(native, "lib"), join(staging, "lib"), { recursive: true });
for (const file of [
  "package.json",
  "package-lock.json",
  "LICENSE",
  "NOTICE",
  "README.md",
])
  cpSync(join(root, file), join(staging, file));
cpSync(join(root, "host"), join(staging, "host"), {
  recursive: true,
  filter: source =>
    !source.endsWith(".test.mjs") &&
    !source.includes(`${join("host", "test-support")}`) &&
    !source.includes(`${join("host", ".fixture")}`) &&
    !source.includes(`${join("host", ".workspace")}`),
});
cpSync(sdk, join(staging, "tsrs-sdk"), {
  recursive: true,
  filter: source =>
    !source.startsWith(join(sdk, "test")) &&
    !/tsconfig[^/]*\.json$/u.test(source),
});
cpSync(join(tsrs, "LICENSE"), join(staging, "tsrs-sdk/LICENSE"));

command("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: staging });
const binding = join(
  staging,
  "node_modules",
  `@oxlint/binding-${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : process.platform === "win32" ? "-msvc" : ""}`,
);
if (!existsSync(join(binding, "package.json")))
  throw new Error(
    `The oxlint platform binding is missing at ${binding}; ` +
      "re-run without --ignore-scripts if optional dependencies were skipped",
  );

const tarball = join(root, "dist", `${name}.tar.gz`);
rmSync(tarball, { force: true });
command("tar", ["-czf", tarball, "-C", dirname(staging), name]);

// The rule-crate SDK ships separately: extracting the sdk tarball into the
// unpacked distribution's root restores <prefix>/sdk.
const sdkName = `rlint-sdk-${manifest.version}-${target}`;
const sdkTarball = join(root, "dist", `${sdkName}.tar.gz`);
rmSync(sdkTarball, { force: true });
command("tar", ["-czf", sdkTarball, "-C", native, "sdk"]);

writeFileSync(
  join(root, "dist", `${name}.json`),
  JSON.stringify({ name, directory: staging, tarball, sdkTarball }, null, 2) +
    "\n",
);
process.stdout.write(`${tarball}\n${sdkTarball}\n`);

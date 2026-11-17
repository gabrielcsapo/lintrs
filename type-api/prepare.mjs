import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { output: { type: "string" } } });
if (values.output === undefined)
  throw new Error("Specify --output <temporary directory>");
const output = resolve(values.output);
const outputRelative = relative(root, output);
if (outputRelative !== ".." && !outputRelative.startsWith("../"))
  throw new Error("The native build directory must be outside the repository");
const marker = join(output, "lintrs-build.json");
if (existsSync(output)) {
  if (
    !existsSync(marker) ||
    JSON.parse(readFileSync(marker, "utf8")).root !== root
  )
    throw new Error(
      "Refusing to overwrite a directory that is not this native build",
    );
}

function command(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout;
}

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2)
    throw new Error(`Expected one occurrence of ${JSON.stringify(before)}`);
  return text.replace(before, after);
}

const target = /^host: (.+)$/mu.exec(command("rustc", ["-vV"]))?.[1];
if (target === undefined) throw new Error("Cannot determine Rust host target");
const metadata = JSON.parse(
  command("cargo", [
    "metadata",
    "--locked",
    "--offline",
    "--filter-platform",
    target,
    "--format-version",
    "1",
  ]),
);
const api = metadata.packages.find(item => item.name === "tsrs_api");
if (
  api === undefined ||
  !api.source?.startsWith("git+https://github.com/oxc-project/tsrs")
)
  throw new Error("Expected the pinned tsrs API git dependency");
const revision = api.source.split("#")[1];
if (!/^[a-f0-9]{40}$/u.test(revision))
  throw new Error("Missing pinned tsrs revision");
const tsrs = resolve(dirname(api.manifest_path), "../..");
const temporaryApi = join(output, "tsrs-source/crates/tsrs_api");
mkdirSync(output, { recursive: true });
cpSync(dirname(api.manifest_path), temporaryApi, { recursive: true });
const apiManifest = join(temporaryApi, "Cargo.toml");
writeFileSync(
  apiManifest,
  replaceOnce(
    readFileSync(apiManifest, "utf8"),
    "[package]",
    '[package]\nworkspace = "../.."',
  ),
);
let tsrsManifest = replaceOnce(
  readFileSync(join(tsrs, "Cargo.toml"), "utf8"),
  'members = ["crates/*"]',
  'members = ["crates/tsrs_api"]',
);
tsrsManifest = tsrsManifest.replace(
  /^(tsrs_\w+) = \{ path = "crates\/[^"\n]+" \}$/gmu,
  `$1 = { git = "https://github.com/oxc-project/tsrs", rev = "${revision}" }`,
);
writeFileSync(join(output, "tsrs-source/Cargo.toml"), tsrsManifest);

const dispatchPath = join(temporaryApi, "src/checker/dispatch.rs");
let dispatch = readFileSync(dispatchPath, "utf8");
dispatch = replaceOnce(
  dispatch,
  '        "getSymbolAtPosition" =>',
  '        "lintrsIsTypeAssignableToManyNative" => ty::lintrs_is_type_assignable_to_many(h, p),\n        "getSymbolAtPosition" =>',
);
dispatch = replaceOnce(
  dispatch,
  "pub const CHECKER_METHODS: &[&str] = &[",
  'pub const CHECKER_METHODS: &[&str] = &[\n    "lintrsIsTypeAssignableToManyNative",',
);
writeFileSync(dispatchPath, dispatch);
const methodsPath = join(temporaryApi, "src/methods.rs");
let methods = readFileSync(methodsPath, "utf8");
methods = replaceOnce(
  methods,
  "pub fn method_info(name: &str) -> Option<&'static MethodInfo> {",
  `pub fn method_info(name: &str) -> Option<&'static MethodInfo> {
    if name == "lintrsIsTypeAssignableToManyNative" {
        return Some(&MethodInfo { name: "lintrsIsTypeAssignableToManyNative", owner: Owner::Checker, status: Status::Partial });
    }`,
);
methods = replaceOnce(
  methods,
  "pub fn params_type(method: &str) -> Option<&'static str> {",
  `pub fn params_type(method: &str) -> Option<&'static str> {
    if method == "lintrsIsTypeAssignableToManyNative" {
        return Some("LintrsAssignabilityBatchParams");
    }`,
);
writeFileSync(methodsPath, methods);
const handlersPath = join(temporaryApi, "src/checker/handlers_types.rs");
writeFileSync(
  handlersPath,
  readFileSync(handlersPath, "utf8") +
    "\n" +
    readFileSync(join(import.meta.dirname, "assignability_bulk.rs"), "utf8") +
    "\n" +
    readFileSync(join(import.meta.dirname, "contextual_bulk.rs"), "utf8"),
);
const symbolHandlersPath = join(
  temporaryApi,
  "src/checker/handlers_symbols.rs",
);
writeFileSync(
  symbolHandlersPath,
  readFileSync(symbolHandlersPath, "utf8") +
    "\n" +
    readFileSync(join(import.meta.dirname, "compact_symbol_facts.rs"), "utf8"),
);
// Native rule libraries: a new module plus the dispatcher branch appended
// through typed_checker.rs.
writeFileSync(
  join(temporaryApi, "src/native_rules.rs"),
  readFileSync(join(import.meta.dirname, "native_rules_module.rs"), "utf8"),
);
const libPath = join(temporaryApi, "src/lib.rs");
writeFileSync(
  libPath,
  replaceOnce(
    readFileSync(libPath, "utf8"),
    "pub mod wire;",
    "pub mod wire;\npub mod native_rules;",
  ),
);
for (const [destination, fragment] of [
  ["src/checker.rs", "typed_checker.rs"],
  ["src/session.rs", "typed_session.rs"],
  ["src/checker/setup.rs", "typed_setup.rs"],
  ["src/checker/registry.rs", "file_symbol_registry.rs"],
  ["src/checker/registry.rs", "compact_declaration_registry.rs"],
  ["src/checker/registry.rs", "checker_gate_registry.rs"],
  ["src/checker/tests.rs", "file_symbol_index_tests.rs"],
  ["src/checker/tests.rs", "contextual_bulk_tests.rs"],
  ["src/checker/tests.rs", "compact_symbol_facts_tests.rs"],
  ["src/checker/lease_tests.rs", "checker_gate_tests.rs"],
]) {
  const path = join(temporaryApi, destination);
  writeFileSync(
    path,
    readFileSync(path, "utf8") +
      "\n" +
      readFileSync(join(import.meta.dirname, fragment), "utf8"),
  );
}

const symbolIndexPath = join(temporaryApi, "src/checker/symbol_index.rs");
let symbolIndex = readFileSync(symbolIndexPath, "utf8");
symbolIndex = replaceOnce(
  symbolIndex,
  "use rustc_hash::FxHashSet;",
  "use rustc_hash::{FxHashMap, FxHashSet};",
);
symbolIndex = replaceOnce(
  symbolIndex,
  "    found: Option<P<Symbol>>,",
  "    found: Option<P<Symbol>>,\n    collected: Option<FxHashMap<u64, P<Symbol>>>,",
);
symbolIndex = replaceOnce(
  symbolIndex,
  "        if id == self.id {",
  "        if let Some(index) = self.collected.as_mut() { index.insert(id, symbol); }\n        if id == self.id && self.collected.is_none() {",
);
symbolIndex = replaceOnce(
  symbolIndex,
  "seen: FxHashSet::default(), found: None",
  "seen: FxHashSet::default(), found: None, collected: None",
);
writeFileSync(
  symbolIndexPath,
  symbolIndex +
    "\n" +
    readFileSync(join(import.meta.dirname, "file_symbol_index.rs"), "utf8"),
);

const registryPath = join(temporaryApi, "src/checker/registry.rs");
let registry = readFileSync(registryPath, "utf8");
registry = replaceOnce(
  registry,
  "    symbols: FxHashMap<u64, P<Symbol>>,",
  "    symbols: FxHashMap<u64, P<Symbol>>,\n    file_symbols: FxHashMap<usize, FxHashMap<u64, P<Symbol>>>,\n    compact_declaration_positions: FxHashMap<u64, std::sync::Arc<tsrs_api_codec::PositionMap>>,\n    checker_gates: FxHashMap<usize, std::sync::Arc<super::lease::ApiCheckerGatePin>>,",
);
registry = replaceOnce(
  registry,
  "        st.symbols = FxHashMap::default();",
  "        st.symbols = FxHashMap::default();\n        st.file_symbols = FxHashMap::default();\n        st.compact_declaration_positions = FxHashMap::default();",
);
registry = replaceOnce(
  registry,
  "        let retained = std::mem::take(&mut st.retained);",
  "        let checker_gates = std::mem::take(&mut st.checker_gates);\n        let retained = std::mem::take(&mut st.retained);",
);
registry = replaceOnce(
  registry,
  "        drop(st);\n        for snapshot in retained {",
  "        drop(st);\n        drop(checker_gates);\n        for snapshot in retained {",
);
writeFileSync(registryPath, registry);

const leasePath = join(temporaryApi, "src/checker/lease.rs");
let lease = readFileSync(leasePath, "utf8");
lease = replaceOnce(
  lease,
  "// refers to it, so a key never outlives its program while in use. Keys never leave this module.",
  "// or snapshot pin refers to it. Snapshot registries release pins before releasing their programs.",
);
lease = replaceOnce(
  lease,
  "    gate: Arc<Gate>,",
  "    gate: Option<Arc<Gate>>,\n    pin: Option<Arc<ApiCheckerGatePin>>,",
);
lease = replaceOnce(
  lease,
  "    let lease = |gate: Arc<Gate>| ApiCheckerLease { key, gate };",
  "    acquire_gate(key, gate)\n}\n\nfn acquire_gate(key: usize, gate: Arc<Gate>) -> CheckerResult<ApiCheckerLease> {",
);
lease = replaceOnce(
  lease,
  "        Ok(()) => Ok(lease(gate)),",
  "        Ok(()) => Ok(ApiCheckerLease { key, gate: Some(gate), pin: None }),",
);
lease = replaceOnce(
  lease,
  "            forget_if_unused(key, &gate);",
  "            forget_if_unused(key, gate);",
);
const cleanup = "\nfn forget_if_unused(key: usize, gate: &Arc<Gate>) {";
if (lease.split(cleanup).length !== 2)
  throw new Error("Expected one checker gate cleanup implementation");
lease = lease.slice(0, lease.indexOf(cleanup));
writeFileSync(
  leasePath,
  lease +
    "\n" +
    readFileSync(join(import.meta.dirname, "checker_gate_reuse.rs"), "utf8"),
);

const setupPath = join(temporaryApi, "src/checker/setup.rs");
let setup = replaceOnce(
  readFileSync(setupPath, "utf8"),
  "use super::symbol_index::source_file_symbol;\n",
  "",
);
setup = replaceOnce(
  setup,
  "source_file_symbol(source_file.unwrap(), r.id)",
  "sd.scope.registry.cached_file_symbol(source_file.unwrap(), r.id)?",
);
setup = replaceOnce(
  setup,
  "        let lease = super::lease::acquire(program)?;",
  "        let lease = if super::lease::reuse_enabled() {\n            sd.scope.registry.acquire_checker_gate(program)?\n        } else {\n            super::lease::acquire(program)?\n        };",
);
writeFileSync(setupPath, setup);

const crate = output;
cpSync(join(root, "src"), join(crate, "src"), { recursive: true });
cpSync(join(root, "lintrs-node"), join(crate, "lintrs-node"), {
  recursive: true,
});
cpSync(join(root, "build.rs"), join(crate, "build.rs"));
{
  const source = join(root, "host");
  const destination = join(crate, "host");
  if (!existsSync(destination)) symlinkSync(source, destination, "dir");
  else if (realpathSync(destination) !== source)
    throw new Error(
      `Unexpected existing native build directory: ${destination}`,
    );
}
const manifest =
  readFileSync(join(root, "Cargo.toml"), "utf8") +
  '\n[patch."https://github.com/oxc-project/tsrs"]\ntsrs_api = { path = "tsrs-source/crates/tsrs_api" }\n';
writeFileSync(join(output, "Cargo.toml"), manifest);
cpSync(join(root, "Cargo.lock"), join(output, "Cargo.lock"));
cpSync(join(root, ".cargo"), join(output, ".cargo"), { recursive: true });
writeFileSync(
  join(output, "lintrs-build.json"),
  JSON.stringify(
    {
      root,
      revision,
      patchedDependency: "tsrs_api",
      addedPackages: [],
      handler: "lintrsIsTypeAssignableToManyNative",
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  JSON.stringify({
    output,
    revision,
    build: [
      "cargo",
      "build",
      "--offline",
      "--release",
      "--manifest-path",
      join(output, "Cargo.toml"),
      "-p",
      "lintrs",
      "--features",
      "typed-native",
    ],
  }) + "\n",
);

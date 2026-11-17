import { realpathSync, writeFileSync } from "node:fs";

import { createAccessPlans } from "./access-plans.mjs";
import { profiler } from "./profile.mjs";
import { compatibility } from "./type-services/adapter.mjs";
import { nodeMaps } from "./type-services/node-maps.mjs";
import { projectForFile } from "./type-services/project.mjs";
import { loadSdk } from "./type-services/sdk.mjs";

export async function createTypeServices({ configs, files, root }) {
  const projects = new Map();
  for (const file of files) {
    const options = configs.getConfig(file).languageOptions.parserOptions ?? {};
    projects.set(file, projectForFile(file, options, root));
  }
  const untyped = file => {
    const options = configs.getConfig(file).languageOptions.parserOptions ?? {};
    const unavailableMap = {
      get() {
        throw new Error(
          `Syntax-only TypeScript node maps are unsupported: ${file}`,
        );
      },
      has() {
        throw new Error(
          `Syntax-only TypeScript node maps are unsupported: ${file}`,
        );
      },
    };
    return {
      program: null,
      esTreeNodeToTSNodeMap: unavailableMap,
      tsNodeToESTreeNodeMap: unavailableMap,
      emitDecoratorMetadata: !!options.emitDecoratorMetadata,
      experimentalDecorators: !!options.experimentalDecorators,
      isolatedDeclarations: !!options.isolatedDeclarations,
    };
  };
  untyped.runNative = file => {
    throw new Error(
      `Native rules require ${file} to be included in a tsconfig project`,
    );
  };
  if (![...projects.values()].some(Boolean)) return untyped;
  if (process.env.LINTRS_BINARY === undefined)
    throw new Error("The Rust type server binary is missing");
  const sdk = await loadSdk(root);
  const lazyObjects = process.env.LINTRS_LAZY_OBJECTS === "1";
  const contextualBatch = process.env.LINTRS_CONTEXTUAL_BATCH === "1";
  const compactDeclarations = process.env.LINTRS_COMPACT_DECLARATIONS === "1";
  const fusedSymbols = process.env.LINTRS_FUSED_SYMBOLS === "1";
  if (
    (compactDeclarations || fusedSymbols) &&
    (process.env.LINTRS_TYPED_NATIVE !== "1" || lazyObjects)
  )
    throw new Error(
      "Compact declaration and fused symbol access require the eager typed native binding",
    );
  if (
    contextualBatch &&
    (process.env.LINTRS_TYPED_NATIVE !== "1" ||
      process.env.LINTRS_TRUE_BULK !== "1")
  )
    throw new Error("Contextual type batching requires the typed bulk binding");
  const adaptive = process.env.LINTRS_ADAPTIVE_FACTS === "1";
  if (adaptive && !lazyObjects)
    throw new Error("Adaptive node facts require lazy objects");
  const plans = adaptive ? createAccessPlans() : undefined;
  if (lazyObjects && process.env.LINTRS_TYPED_NATIVE !== "1")
    throw new Error("Lazy objects require the typed native binding");
  const profilePath = process.env.LINTRS_TYPE_PROFILE;
  const projectTimings = [];
  const lazyStats = [];
  const symbolStats = [];
  const api = new sdk.api.API({
    tsserverPath: process.env.LINTRS_BINARY,
    cwd: root,
    collectTiming: profilePath !== undefined,
  });
  const profile = profiler();
  if (profile !== undefined) {
    // Every checker round trip goes through these client methods, for both
    // the in-process binding and the child-process transport. Wrapping the
    // instance bills each call to the rule (or phase) that made it.
    for (const name of [
      "request",
      "apiRequest",
      "apiRequestBinary",
      "batchRequests",
      "direct",
      "nodeFacts",
      "objectProperty",
    ]) {
      const method = api.client[name];
      if (typeof method !== "function") continue;
      api.client[name] = function (first, ...rest) {
        const label =
          typeof first === "string" && name !== "nodeFacts" ? first : name;
        return profile.charge("checker", label, () =>
          method.call(this, first, ...rest),
        );
      };
    }
  }
  // In-process sessions publish Rust's compute time into this buffer after
  // each request (see src/in_process.rs), splitting checker calls into Rust
  // work and the JS/Rust crossing. The child-process transport has none.
  const session = api.client.session;
  if (profile !== undefined && typeof session?.profileClock === "function") {
    // [0] compute, [1] requests, [2] whole native callback (older bindings
    // leave it at zero, which only drops the conversion split).
    const clock = new Float64Array(3);
    session.profileClock(clock);
    profile.setComputeClock(
      () => clock[0],
      () => clock[2],
    );
  }
  const profiledMap = map => {
    if (profile === undefined) return map;
    const wrapped = { ...map };
    for (const name of ["get", "has"])
      if (typeof map[name] === "function")
        wrapped[name] = (...args) =>
          profile.charge("nodeMaps", name, () => map[name](...args));
    return wrapped;
  };
  const snapshots = new Map();
  const remaining = new Map();
  for (const project of projects.values()) {
    if (project !== undefined)
      remaining.set(project, (remaining.get(project) ?? 0) + 1);
  }
  const nativeRuns = [];
  const ensureEntry = projectPath => {
    let entry = snapshots.get(projectPath);
    if (entry === undefined && profile !== undefined)
      return profile.phase("Project build", () => createEntry(projectPath));
    if (entry === undefined) entry = createEntry(projectPath);
    return entry;
  };
  const createEntry = projectPath => {
    let entry;
    {
      const start = performance.now();
      const config = api.readConfigFile(projectPath);
      if (config.error !== undefined)
        throw new Error(
          `Cannot read ${projectPath}: ${JSON.stringify(config.error)}`,
        );
      const parsed = api.parseJsonConfigFileContent(config.config, {
        configFileName: projectPath,
      });
      if (parsed.errors.length > 0)
        throw new Error(
          `Cannot parse ${projectPath}: ${JSON.stringify(parsed.errors)}`,
        );
      const snapshot = api.createSnapshot({
        createPrograms: [
          {
            rootFiles: parsed.fileNames,
            compilerOptions: {
              ...parsed.options,
              disableSourceOfProjectReferenceRedirect: true,
            },
            options: { projectReferences: parsed.projectReferences },
          },
        ],
      });
      projectTimings.push({
        path: projectPath,
        durationMs: performance.now() - start,
      });
      const program = snapshot.operation.createdPrograms[0];
      const project =
        program === undefined ? undefined : snapshot.getProject(program.id);
      if (project === undefined)
        throw new Error(`tsrs did not open ${projectPath}`);
      entry = {
        project,
        snapshot,
        // The pinned SDK client can call the compact extension without generic per-item envelopes.
        adapter: compatibility(
          sdk,
          project,
          (source, targets) =>
            api.client.apiRequest("lintrsIsTypeAssignableToMany", {
              snapshot: snapshot.id,
              project: project.id,
              source: source.id,
              targets: targets.map(target => target.id),
            }),
          lazyObjects
            ? {
                plans,
                property: (kind, handle, property) =>
                  api.client.objectProperty(
                    snapshot.id,
                    project.id,
                    kind,
                    handle,
                    property,
                  ),
                nodes: (nodes, mask, fields) => {
                  const file = nodes[0].getSourceFile();
                  if (!nodes.every(node => node.getSourceFile() === file))
                    throw new Error(
                      "Native node facts require one source file per batch",
                    );
                  const indices = Uint32Array.from(nodes, node => {
                    const index = Number(
                      node.id.slice(0, node.id.indexOf(".")),
                    );
                    if (!Number.isSafeInteger(index) || index < 1)
                      throw new Error("Invalid remote node index");
                    return index;
                  });
                  return api.client.nodeFacts(
                    snapshot.id,
                    project.id,
                    file.fileName,
                    indices,
                    mask,
                    fields,
                  );
                },
              }
            : undefined,
          contextualBatch
            ? nodes =>
                api.client
                  .apiRequest("lintrsGetContextualTypes", {
                    snapshot: snapshot.id,
                    project: project.id,
                    locations: nodes.map(node => node.id),
                  })
                  .map(data =>
                    data == null
                      ? undefined
                      : project.checker.objectRegistry.getOrCreateType(data),
                  )
            : undefined,
          compactDeclarations || fusedSymbols
            ? {
                compact: compactDeclarations,
                locations: nodes =>
                  api.client.apiRequest("lintrsGetSymbolFacts", {
                    snapshot: snapshot.id,
                    project: project.id,
                    locations: nodes.map(node => node.id),
                    resolveAliases: fusedSymbols,
                    includeDeclarations: compactDeclarations,
                  }),
                alias: symbol =>
                  api.client.apiRequest("lintrsGetAliasedSymbolFacts", {
                    snapshot: snapshot.id,
                    project: project.id,
                    symbol: symbol.reference,
                    includeDeclarations: compactDeclarations,
                  }),
              }
            : undefined,
        ),
      };
      snapshots.set(projectPath, entry);
    }
    return entry;
  };
  const services = (file, sourceCode) => {
    const projectPath = projects.get(file);
    if (projectPath === undefined) return untyped(file);
    const entry = ensureEntry(projectPath);
    const rawFile = entry.project.program.getSourceFile(file);
    if (rawFile === undefined)
      throw new Error(`File is outside its tsrs project: ${file}`);
    if (rawFile.text.replace(/^\uFEFF/u, "") !== sourceCode.text)
      throw new Error(`Rust type snapshot differs from linted source: ${file}`);
    const built = nodeMaps(sourceCode, rawFile, entry.adapter, sdk);
    const maps = {
      ...built,
      esTreeNodeToTSNodeMap: profiledMap(built.esTreeNodeToTSNodeMap),
      tsNodeToESTreeNodeMap: profiledMap(built.tsNodeToESTreeNodeMap),
    };
    return {
      ...maps,
      program: entry.adapter.program,
      emitDecoratorMetadata:
        !!entry.project.parsedCommandLine.options.emitDecoratorMetadata,
      experimentalDecorators:
        !!entry.project.parsedCommandLine.options.experimentalDecorators,
      isolatedDeclarations:
        !!entry.project.parsedCommandLine.options.isolatedDeclarations,
      getTypeAtLocation: node =>
        entry.adapter.checker.getTypeAtLocation(
          maps.esTreeNodeToTSNodeMap.get(node),
        ),
      getSymbolAtLocation: node =>
        entry.adapter.checker.getSymbolAtLocation(
          maps.esTreeNodeToTSNodeMap.get(node),
        ),
      getContextualType: node =>
        entry.adapter.checker.getContextualType(
          maps.esTreeNodeToTSNodeMap.get(node),
        ),
      getResolvedSignature: node =>
        entry.adapter.checker.getResolvedSignature(
          maps.esTreeNodeToTSNodeMap.get(node),
        ),
      getTypeFromTypeNode: node =>
        entry.adapter.checker.getTypeFromTypeNode(
          maps.esTreeNodeToTSNodeMap.get(node),
        ),
      getTypeOfSymbolAtLocation: (symbol, node) =>
        entry.adapter.checker.getTypeOfSymbolAtLocation(
          symbol,
          maps.esTreeNodeToTSNodeMap.get(node),
        ),
    };
  };
  if (plans !== undefined) services.withRule = plans.withRule;
  services.finish = file => {
    plans?.finishFile();
    const project = projects.get(file);
    if (project === undefined) return;
    const count = remaining.get(project) - 1;
    remaining.set(project, count);
    if (count === 0) {
      const stats = snapshots.get(project)?.adapter.lazyStats();
      if (stats !== undefined) lazyStats.push({ path: project, ...stats });
      const symbols = snapshots.get(project)?.adapter.symbolStats();
      if (symbols !== undefined)
        symbolStats.push({ path: project, ...symbols });
      snapshots.get(project)?.snapshot.dispose();
      snapshots.delete(project);
    }
  };
  services.runNative = (file, { libraries, rules, jsSkipped }) => {
    const projectPath = projects.get(file);
    if (projectPath === undefined)
      throw new Error(
        `Native rules require ${file} to be included in a tsconfig project`,
      );
    if (api.client.nativeMethods?.has("lintrsRunNativeRules") !== true)
      throw new Error(
        "Native rules require the in-process binding " +
          "(LINTRS_IN_PROCESS_BINDING) built with the typed-native feature",
      );
    const entry = ensureEntry(projectPath);
    if (process.env.LINTRS_NATIVE_DEBUG === "1")
      console.error("runNative", {
        projectPath,
        file,
        names: entry.project.program.getSourceFileNames?.(),
      });
    const start = performance.now();
    const diagnostics = api.client.apiRequest("lintrsRunNativeRules", {
      snapshot: entry.snapshot.id,
      project: entry.project.id,
      file,
      libraries,
      rules,
    });
    nativeRuns.push({
      file,
      rules: rules.length,
      jsSkipped: jsSkipped === true,
      durationMs: performance.now() - start,
    });
    return diagnostics;
  };
  services.close = () => {
    if (
      profile !== undefined &&
      typeof session?.nativeRuleTiming === "function"
    )
      profile.addNative(JSON.parse(session.nativeRuleTiming()));
    try {
      if (profilePath !== undefined)
        writeFileSync(
          profilePath,
          JSON.stringify(
            {
              projects: projectTimings,
              api: api.getTimingInfo(),
              // The in-process binding's own totals, including the split of
              // typed calls into argument decoding and result encoding, which
              // the SDK's combined timing does not carry.
              ...(typeof session?.timing === "function"
                ? { binding: JSON.parse(session.timing()).totals }
                : {}),
              ...(api.client.nativeStats === undefined
                ? {}
                : { native: api.client.nativeStats }),
              ...(lazyObjects ? { lazy: lazyStats } : {}),
              ...(compactDeclarations || fusedSymbols
                ? { symbolFacts: symbolStats }
                : {}),
              ...(plans === undefined ? {} : { accessPlans: plans.stats }),
              ...(nativeRuns.length === 0 ? {} : { nativeRules: nativeRuns }),
            },
            null,
            2,
          ),
        );
    } finally {
      api.close();
    }
  };
  return services;
}

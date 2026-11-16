import { realpathSync, writeFileSync } from "node:fs";

import { createAccessPlans } from "./access-plans.mjs";
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
  if (process.env.RLINT_BINARY === undefined)
    throw new Error("The Rust type server binary is missing");
  const sdk = await loadSdk(root);
  const lazyObjects = process.env.RLINT_LAZY_OBJECTS === "1";
  const contextualBatch = process.env.RLINT_CONTEXTUAL_BATCH === "1";
  const compactDeclarations = process.env.RLINT_COMPACT_DECLARATIONS === "1";
  const fusedSymbols = process.env.RLINT_FUSED_SYMBOLS === "1";
  if (
    (compactDeclarations || fusedSymbols) &&
    (process.env.RLINT_TYPED_NATIVE !== "1" || lazyObjects)
  )
    throw new Error(
      "Compact declaration and fused symbol access require the eager typed native binding",
    );
  if (
    contextualBatch &&
    (process.env.RLINT_TYPED_NATIVE !== "1" ||
      process.env.RLINT_TRUE_BULK !== "1")
  )
    throw new Error("Contextual type batching requires the typed bulk binding");
  const adaptive = process.env.RLINT_ADAPTIVE_FACTS === "1";
  if (adaptive && !lazyObjects)
    throw new Error("Adaptive node facts require lazy objects");
  const plans = adaptive ? createAccessPlans() : undefined;
  if (lazyObjects && process.env.RLINT_TYPED_NATIVE !== "1")
    throw new Error("Lazy objects require the typed native binding");
  const profilePath = process.env.RLINT_TYPE_PROFILE;
  const projectTimings = [];
  const lazyStats = [];
  const symbolStats = [];
  const api = new sdk.api.API({
    tsserverPath: process.env.RLINT_BINARY,
    cwd: root,
    collectTiming: profilePath !== undefined,
  });
  const snapshots = new Map();
  const remaining = new Map();
  for (const project of projects.values()) {
    if (project !== undefined)
      remaining.set(project, (remaining.get(project) ?? 0) + 1);
  }
  const nativeRuns = [];
  const ensureEntry = projectPath => {
    let entry = snapshots.get(projectPath);
    if (entry === undefined) {
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
            api.client.apiRequest("rlintIsTypeAssignableToMany", {
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
                  .apiRequest("rlintGetContextualTypes", {
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
                  api.client.apiRequest("rlintGetSymbolFacts", {
                    snapshot: snapshot.id,
                    project: project.id,
                    locations: nodes.map(node => node.id),
                    resolveAliases: fusedSymbols,
                    includeDeclarations: compactDeclarations,
                  }),
                alias: symbol =>
                  api.client.apiRequest("rlintGetAliasedSymbolFacts", {
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
    const maps = nodeMaps(sourceCode, rawFile, entry.adapter, sdk);
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
    if (api.client.nativeMethods?.has("rlintRunNativeRules") !== true)
      throw new Error(
        "Native rules require the in-process binding " +
          "(RLINT_IN_PROCESS_BINDING) built with the typed-native feature",
      );
    const entry = ensureEntry(projectPath);
    if (process.env.RLINT_NATIVE_DEBUG === "1")
      console.error("runNative", {
        projectPath,
        file,
        names: entry.project.program.getSourceFileNames?.(),
      });
    const start = performance.now();
    const diagnostics = api.client.apiRequest("rlintRunNativeRules", {
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
    try {
      if (profilePath !== undefined)
        writeFileSync(
          profilePath,
          JSON.stringify(
            {
              projects: projectTimings,
              api: api.getTimingInfo(),
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

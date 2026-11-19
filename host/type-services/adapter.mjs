import { createLazyObjects } from "../lazy-objects.mjs";
import { createFlags } from "./flags.mjs";
import { createQueries } from "./queries.mjs";
import { IdentityMap, NodeProxies } from "./state.mjs";
import { createWrap } from "./wrap.mjs";
import { createWrapping, displayParts, docTags } from "./wrapping.mjs";

// Assembles the shared adapter context, then the layered factories in
// dependency order: lazy object handles, source-file/declaration wrappers,
// batched checker queries, and finally the generic wrap proxy.
export function compatibility(
  sdk,
  project,
  compareTargets,
  native,
  contextualTypes,
  symbolFacts,
  targetTypeScript,
) {
  const ctx = {
    sdk,
    project,
    compareTargets,
    native,
    contextualTypes,
    symbolFacts,
    cache: new IdentityMap(),
    originals: new IdentityMap(),
    methods: new IdentityMap(),
    symbolDocs: new IdentityMap(),
    signatureDocs: new IdentityMap(),
    declarationHeaders: new Map(),
    nodeProxies: new NodeProxies(),
    compactOriginals: new IdentityMap(),
    aliasedSymbols: new IdentityMap(),
    symbolStats: { headers: 0, nodes: 0, hydrations: 0, aliasHits: 0 },
    sourceFiles: new Map(),
    sourceFileResolvers: new IdentityMap(),
    ...createFlags(sdk, targetTypeScript),
  };
  ctx.lazy =
    native === undefined
      ? undefined
      : createLazyObjects({
          sdk,
          project,
          flags: ctx.flags,
          readProperty: native.property,
          wrap: (...args) => ctx.wrap(...args),
          legacyWrap: value => ctx.wrap(value, true),
          docTags,
          displayParts,
          plans: native.plans,
        });
  Object.assign(ctx, createWrapping(ctx));
  Object.assign(ctx, createQueries(ctx));
  ctx.wrap = createWrap(ctx);
  const { wrap, sourceFile, prepareFile } = ctx;
  const checker = wrap(project.checker);
  let allSourceFiles;
  const program = new Proxy(wrap(project.program), {
    get(target, key) {
      if (key === "getTypeChecker") return () => checker;
      if (key === "getRootFileNames")
        return () => project.parsedCommandLine.fileNames;
      if (key === "getSourceFiles")
        return () =>
          (allSourceFiles ??= project.program
            .getSourceFileNames()
            .map(fileName => sourceFile(fileName)));
      return Reflect.get(target, key);
    },
  });
  return {
    ts: ctx.ts,
    wrap,
    checker,
    program,
    prepareFile,
    lazyStats: () => ctx.lazy?.stats,
    symbolStats: () =>
      symbolFacts === undefined ? undefined : ctx.symbolStats,
  };
}

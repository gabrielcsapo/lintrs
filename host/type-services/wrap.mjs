import { createGetHandler } from "./proxy-get.mjs";

// `wrap` is the identity-preserving front door to the tsc-compatible proxies:
// lazy handles, compact declaration handles, source files, and cached proxy
// identity are all resolved here before the generic get/has traps apply.
export function createWrap(ctx) {
  const {
    sdk,
    project,
    lazy,
    symbolFacts,
    cache,
    originals,
    nodeProxies,
    compactOriginals,
    declarationHeaders,
    sourceFileResolvers,
    sourceFile,
    handleId,
    compactDeclaration,
  } = ctx;
  const handlerFor = createGetHandler(ctx);
  return function wrap(
    value,
    legacy = false,
    resolvedCompact = false,
    sourceFileBody = false,
  ) {
    if (value === null || typeof value !== "object") return value;
    if (sourceFileResolvers.has(value)) return value;
    if (symbolFacts?.compact && compactOriginals.has(value)) return value;
    if (lazy !== undefined && !legacy) {
      if (lazy.originals.has(value)) return value;
      if (typeof value.isUnionType === "function")
        return lazy.type({ id: value.id, flags: value.flags }, value);
      if (value instanceof sdk.api.Symbol)
        return lazy.symbol(
          { reference: value.reference, flags: value.flags },
          value,
        );
    }
    if (value instanceof sdk.api.NodeHandle)
      return symbolFacts?.compact && declarationHeaders.has(handleId(value))
        ? compactDeclaration(value)
        : wrap(value.resolve());
    if (
      !sourceFileBody &&
      value.kind === sdk.ast.SyntaxKind.SourceFile &&
      typeof value.fileName === "string"
    )
      return sourceFile(value.fileName, value);
    if (!symbolFacts?.compact && cache.has(value)) return cache.get(value);
    const isNode =
      typeof value.kind === "number" && typeof value.pos === "number";
    if (isNode && !resolvedCompact) {
      if (nodeProxies.has(value.id)) return nodeProxies.get(value.id);
      if (symbolFacts?.compact && declarationHeaders.has(value.id))
        return compactDeclaration(new sdk.api.NodeHandle(value.id, project));
    }
    if (cache.has(value)) return cache.get(value);
    const isHeritageType =
      isNode &&
      value.kind === sdk.ast.SyntaxKind.TypeReference &&
      value.parent?.kind === sdk.ast.SyntaxKind.HeritageClause;
    const heritageExpression = node => {
      if (node.kind !== sdk.ast.SyntaxKind.QualifiedName) return false;
      let parent = node.parent;
      while (parent?.kind === sdk.ast.SyntaxKind.QualifiedName)
        parent = parent.parent;
      return (
        parent?.kind === sdk.ast.SyntaxKind.TypeReference &&
        parent.parent?.kind === sdk.ast.SyntaxKind.HeritageClause
      );
    };
    const isHeritageExpression = isNode && heritageExpression(value);
    const isType = typeof value.isUnionType === "function";
    const isSymbol = value instanceof sdk.api.Symbol;
    const isSignature = value instanceof sdk.api.Signature;
    const proxy = new Proxy(
      value,
      handlerFor({
        isNode,
        isType,
        isSymbol,
        isSignature,
        isHeritageType,
        isHeritageExpression,
      }),
    );
    cache.set(value, proxy);
    originals.set(proxy, value);
    if (isNode && !resolvedCompact) nodeProxies.set(value.id, proxy);
    return proxy;
  };
}

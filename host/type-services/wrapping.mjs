import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const displayParts = text =>
  text === undefined ? undefined : [{ text, kind: "text" }];
export const docTags = tags =>
  tags.map(tag => ({
    ...tag,
    ...(typeof tag.text === "string" ? { text: displayParts(tag.text) } : {}),
  }));

// Source-file, declaration-header, and identity layers of the tsc-compatible
// object wrappers. `ctx` carries the shared adapter state assembled in
// adapter.mjs; `ctx.wrap` and `ctx.lazy` are assigned after these helpers are
// created, so references through `ctx` resolve lazily exactly like the
// original closures.
export function createWrapping(ctx) {
  const {
    sdk,
    project,
    flags,
    kinds,
    symbolFacts,
    sourceFiles,
    sourceFileResolvers,
    compactOriginals,
    originals,
    declarationHeaders,
    nodeProxies,
    aliasedSymbols,
    symbolStats,
  } = ctx;

  const sourceFile = (fileName, existing) => {
    let entry = sourceFiles.get(fileName);
    if (entry !== undefined) {
      if (existing !== undefined) entry.raw = existing;
      return entry.proxy;
    }
    entry = { raw: existing };
    const raw = () => {
      entry.raw ??= project.program.getSourceFile(fileName);
      if (entry.raw === undefined)
        throw new Error(`Source file left its Rust snapshot: ${fileName}`);
      return entry.raw;
    };
    const body = () => ctx.wrap(raw(), false, false, true);
    // Rules can filter the program's files without materializing dependency ASTs.
    const proxy = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "fileName") return fileName;
          if (key === "kind") return ts.SyntaxKind.SourceFile;
          if (key === "isDeclarationFile")
            return ts.isDeclarationFileName(fileName);
          if (key === "getSourceFile") return () => proxy;
          return Reflect.get(body(), key);
        },
        has(_target, key) {
          return (
            ["fileName", "kind", "isDeclarationFile", "getSourceFile"].includes(
              key,
            ) || Reflect.has(body(), key)
          );
        },
        ownKeys: () => Reflect.ownKeys(body()),
        getOwnPropertyDescriptor(_target, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(body(), key);
          return descriptor === undefined
            ? undefined
            : { ...descriptor, configurable: true };
        },
        getPrototypeOf: () => Reflect.getPrototypeOf(body()),
      },
    );
    entry.proxy = proxy;
    sourceFiles.set(fileName, entry);
    sourceFileResolvers.set(proxy, raw);
    return proxy;
  };
  const unwrap = value => {
    if (value === null || typeof value !== "object") return value;
    if (sourceFileResolvers.has(value)) return sourceFileResolvers.get(value)();
    if (symbolFacts?.compact && compactOriginals.has(value))
      return compactOriginals.get(value)();
    if (ctx.lazy?.originals.has(value)) return ctx.lazy.originals.get(value);
    if (originals.has(value)) return originals.get(value);
    if (Array.isArray(value)) return value.map(unwrap);
    return value;
  };
  const seedDeclarations = headers => {
    if (!symbolFacts.compact) return;
    for (const header of headers) {
      if (!declarationHeaders.has(header.id)) symbolStats.headers++;
      declarationHeaders.set(header.id, header);
    }
  };
  const readSymbols = nodes => {
    const response = symbolFacts.locations(nodes);
    seedDeclarations(response.declarations);
    return response.results.map(result => {
      if (result.symbol === null) return undefined;
      const symbol = project.checker.objectRegistry.getOrCreateSymbol(
        result.symbol,
      );
      if (result.alias !== undefined)
        aliasedSymbols.set(
          symbol,
          project.checker.objectRegistry.getOrCreateSymbol(result.alias),
        );
      return symbol;
    });
  };
  const handleId = handle => `${handle.index}.${handle.kind}.${handle.path}`;
  const compactDeclaration = handle => {
    const id = handleId(handle);
    if (nodeProxies.has(id)) return nodeProxies.get(id);
    const header = declarationHeaders.get(id);
    let resolved;
    const raw = () => {
      if (resolved === undefined) {
        symbolStats.hydrations++;
        resolved = handle.resolve();
      }
      return resolved;
    };
    const fallback = () => ctx.wrap(raw(), false, true);
    const proxy = new Proxy(
      {},
      {
        get(target, key) {
          if (Object.hasOwn(target, key)) return Reflect.get(target, key);
          if (key === "id" || key === "pos" || key === "end")
            return header[key];
          if (key === "flags") return flags.node(header.flags);
          if (
            key === "kind" &&
            header.kind !== sdk.ast.SyntaxKind.TypeReference &&
            header.kind !== sdk.ast.SyntaxKind.QualifiedName
          ) {
            const kind = kinds.get(header.kind);
            if (kind === undefined)
              throw new Error(
                `Unsupported declaration SyntaxKind: ${header.kind}`,
              );
            return kind;
          }
          if (key === "text" && header.text !== undefined) return header.text;
          return Reflect.get(fallback(), key);
        },
        has(target, key) {
          if (Object.hasOwn(target, key)) return true;
          if (["id", "pos", "end", "flags", "kind"].includes(key)) return true;
          return Reflect.has(fallback(), key);
        },
        ownKeys(target) {
          return [
            ...new Set([
              ...Reflect.ownKeys(target),
              ...Reflect.ownKeys(fallback()),
            ]),
          ];
        },
        getOwnPropertyDescriptor(target, key) {
          const own = Reflect.getOwnPropertyDescriptor(target, key);
          if (own !== undefined) return own;
          const descriptor = Reflect.getOwnPropertyDescriptor(fallback(), key);
          return descriptor === undefined
            ? undefined
            : { ...descriptor, configurable: true };
        },
        getPrototypeOf() {
          return Reflect.getPrototypeOf(fallback());
        },
      },
    );
    compactOriginals.set(proxy, raw);
    nodeProxies.set(id, proxy);
    symbolStats.nodes++;
    return proxy;
  };
  return {
    sourceFile,
    unwrap,
    seedDeclarations,
    readSymbols,
    handleId,
    compactDeclaration,
  };
}

export function createLazyObjects({
  sdk,
  project,
  flags,
  readProperty,
  wrap,
  legacyWrap,
  docTags,
  displayParts,
  plans,
}) {
  const registry = project.checker.objectRegistry;
  const types = new Map();
  const symbols = new Map();
  const originals = new WeakMap();
  const seeds = new WeakMap();
  const stats = { types: 0, symbols: 0, properties: 0, hydrations: 0 };
  const typePredicates = {
    isUnion: "Union",
    isUnionType: "Union",
    isIntersection: "Intersection",
    isIntersectionType: "Intersection",
    isLiteral: "Literal",
    isLiteralType: "Literal",
    isStringLiteral: "StringLiteral",
    isStringLiteralType: "StringLiteral",
    isNumberLiteral: "NumberLiteral",
    isNumberLiteralType: "NumberLiteral",
    isTypeParameter: "TypeParameter",
  };
  const scalarTypeProperties = new Set([
    "intrinsicName",
    "isThisType",
    "readonly",
    "fixedLength",
    "elementFlags",
    "texts",
  ]);
  const symbolKey = reference =>
    reference.kind === sdk.api.SymbolOwnerKind.File
      ? `file:${reference.file.nodeId}:${reference.id}`
      : `snapshot:${reference.snapshot}:${reference.id}`;

  function create(kind, header, fallback) {
    const handle = kind === "type" ? header.id : header.reference;
    const values = new Map();
    const prefetched = new Set();
    const methods = new Map();
    let hydrated = fallback;
    const read = property => {
      plans?.read(proxy, property);
      if (prefetched.delete(property)) plans.stats.usedFields++;
      if (!values.has(property)) {
        stats.properties++;
        values.set(property, readProperty(kind, handle, property));
      }
      return values.get(property);
    };
    const raw = () => {
      if (hydrated === undefined) {
        stats.hydrations++;
        const data = read("__hydrate");
        hydrated =
          kind === "type"
            ? registry.getOrCreateType(data)
            : registry.getOrCreateSymbol(data);
      }
      return hydrated;
    };
    const bind = (name, fn) => {
      if (!methods.has(name)) methods.set(name, fn);
      return methods.get(name);
    };
    const typeBit = name => (header.flags & sdk.api.TypeFlags[name]) !== 0;
    const objectFlags = () => read("objectFlags") ?? 0;
    const referenceType = () =>
      typeBit("Object") &&
      (objectFlags() & sdk.api.ObjectFlags.Reference) !== 0;
    const underlying = new Proxy(
      kind === "type"
        ? { id: header.id, flags: header.flags }
        : { id: header.reference.id, reference: header.reference },
      {
        get(target, key) {
          if (Reflect.has(target, key)) return Reflect.get(target, key);
          if (kind === "type" && key === "isUnionType")
            return bind("raw:isUnionType", () => typeBit("Union"));
          if (kind === "type" && key === "isTypeReference")
            return bind("raw:isTypeReference", referenceType);
          const item = Reflect.get(raw(), key);
          return typeof item === "function" ? item.bind(raw()) : item;
        },
      },
    );
    const proxy = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "id")
            return kind === "type" ? header.id : header.reference.id;
          if (key === "flags") return flags[kind](header.flags);
          if (key === "getFlags")
            return bind(key, () => flags[kind](header.flags));
          if (kind === "type") {
            if (typePredicates[key] !== undefined)
              return bind(key, () => typeBit(typePredicates[key]));
            if (key === "isUnionOrIntersection")
              return bind(
                key,
                () => typeBit("Union") || typeBit("Intersection"),
              );
            if (key === "objectFlags") return flags.object(objectFlags());
            if (key === "isClass")
              return bind(
                key,
                () => !!(objectFlags() & sdk.api.ObjectFlags.Class),
              );
            if (key === "isClassOrInterface")
              return bind(
                key,
                () =>
                  typeBit("Object") &&
                  !!(objectFlags() & sdk.api.ObjectFlags.ClassOrInterface),
              );
            if (scalarTypeProperties.has(key)) return read(key);
            if (key === "symbol" || key === "aliasSymbol") {
              const value = read(key);
              return value === undefined ? undefined : symbol(value);
            }
            if (key === "getSymbol" || key === "getAliasSymbol")
              return bind(
                key,
                () => proxy[key === "getSymbol" ? "symbol" : "aliasSymbol"],
              );
            if (key === "value") {
              const value = read(key);
              if (typeBit("BigIntLiteral") && value !== undefined) {
                const bigint = BigInt(value);
                return {
                  negative: bigint < 0n,
                  base10Value: String(bigint < 0n ? -bigint : bigint),
                };
              }
              return typeBit("NumberLiteral") && typeof value === "string"
                ? Number(value)
                : value;
            }
          } else {
            if (key === "reference") return header.reference;
            if (key === "escapedName") return read("name");
            if (key === "name") {
              const name = read("name");
              return name.startsWith("___") ? name.slice(1) : name;
            }
            if (key === "getName" || key === "getEscapedName")
              return bind(
                key,
                () => proxy[key === "getName" ? "name" : "escapedName"],
              );
            if (key === "checkFlags") return read(key);
            if (key === "declarations") {
              plans?.read(proxy, key);
              if (!values.has("wrappedDeclarations")) {
                const handles = read(key);
                values.set(
                  "wrappedDeclarations",
                  handles === undefined || handles.length === 0
                    ? undefined
                    : wrap(
                        handles.map(
                          handle => new sdk.api.NodeHandle(handle, project),
                        ),
                      ),
                );
              }
              return values.get("wrappedDeclarations");
            }
            if (key === "valueDeclaration") {
              const handle = read(key);
              return handle === undefined
                ? undefined
                : wrap(new sdk.api.NodeHandle(handle, project));
            }
            if (key === "getDeclarations")
              return bind(key, () => proxy.declarations);
            if (key === "parent" || key === "exportSymbol") {
              const value = read(key);
              return value === undefined
                ? key === "exportSymbol"
                  ? proxy
                  : undefined
                : symbol(value);
            }
            if (key === "getJsDocTags")
              return bind(key, () => {
                if (!values.has("jsDocTags"))
                  values.set(
                    "jsDocTags",
                    docTags(project.checker.getJsDocTagsOfSymbol(underlying)),
                  );
                return values.get("jsDocTags");
              });
            if (key === "getDocumentationComment")
              return bind(
                key,
                () =>
                  displayParts(
                    project.checker.getDocumentationCommentOfSymbol(underlying),
                  ) ?? [],
              );
          }
          return Reflect.get(legacyWrap(raw()), key);
        },
        has(_target, key) {
          if (key === "id" || key === "flags" || key === "getFlags")
            return true;
          if (kind === "type" && typePredicates[key] !== undefined) return true;
          return Reflect.has(legacyWrap(raw()), key);
        },
      },
    );
    originals.set(proxy, underlying);
    seeds.set(proxy, (properties, fields) => {
      for (const field of fields) {
        if (values.has(field)) continue;
        values.set(field, properties?.[field]);
        prefetched.add(field);
      }
    });
    return proxy;
  }

  function type(header, fallback) {
    if (!types.has(header.id)) {
      stats.types++;
      types.set(header.id, create("type", header, fallback));
    }
    return types.get(header.id);
  }

  function symbol(header, fallback, fields = []) {
    const key = symbolKey(header.reference);
    if (!symbols.has(key)) {
      stats.symbols++;
      symbols.set(key, create("symbol", header, fallback));
    }
    const value = symbols.get(key);
    if (fields.length > 0) seeds.get(value)(header.properties, fields);
    return value;
  }

  return { type, symbol, originals, stats };
}

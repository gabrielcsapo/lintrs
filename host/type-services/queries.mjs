import { profiler } from "../profile.mjs";
import { IdentityMap } from "./state.mjs";

// Checker-query routing: memoization, per-kind batching, native node-fact
// batches, the assignability bulk extension, and fused symbol reads.
export function createQueries(ctx) {
  const {
    sdk,
    project,
    lazy,
    native,
    contextualTypes,
    symbolFacts,
    methods,
    aliasedSymbols,
    symbolStats,
    seedDeclarations,
    readSymbols,
    unwrap,
  } = ctx;
  const cachedQueries = new Set([
    "getTypeAtLocation",
    "getSymbolAtLocation",
    "getTypeFromTypeNode",
    "getContextualType",
    // no-misused-promises asks for the same (call, index) once per signature
    // parameter it visits; 44% of these requests were exact repeats.
    "getContextualTypeForArgumentAtIndex",
    "getResolvedSignature",
    "getBaseConstraintOfType",
    "getTypeOfSymbolAtLocation",
    "getTypeOfSymbol",
    "getDeclaredTypeOfSymbol",
    "getTypeArguments",
    "typeToString",
    "getAliasedSymbol",
    "getImmediateAliasedSymbol",
    "getApparentType",
    "getNonNullableType",
    "getBaseTypes",
    "getBaseTypeOfLiteralType",
    "getWidenedType",
    "getAwaitedType",
    "getPromisedTypeOfPromise",
    "getReturnTypeOfSignature",
    "getSignaturesOfType",
    "getTypePredicateOfSignature",
    "getExportsOfModule",
    "getPropertiesOfType",
    "getPropertyOfType",
    "getTypeOfPropertyOfType",
    "isTypeAssignableTo",
    "isArrayType",
    "isArrayLikeType",
    "isTupleType",
  ]);
  const literalGroups = new IdentityMap();
  const indexedUnions = new WeakSet();
  const indexUnion = (type, members) => {
    if (lazy !== undefined) {
      type = unwrap(ctx.wrap(type));
      members = members?.map(member => unwrap(ctx.wrap(member)));
    }
    if (!type.isUnionType() || indexedUnions.has(type)) return;
    indexedUnions.add(type);
    if (
      members === undefined ||
      members.length < 16 ||
      !members.every(
        member => (member.flags & sdk.api.TypeFlags.StringLiteral) !== 0,
      )
    )
      return;
    for (let start = 0; start < members.length; start += 64) {
      const group = members.slice(start, start + 64);
      for (const member of group)
        if (!literalGroups.has(member)) literalGroups.set(member, group);
    }
  };
  let batches = new Map();
  let nodesByKind = new Map();
  // Sparse rules query only a few nodes of each kind. Delay prefetch until
  // repeated queries justify fetching the remaining nodes in that file.
  const adaptiveQueries = new Set([
    "getSymbolAtLocation",
    ...(process.env.LINTRS_ADAPTIVE_TYPE_QUERIES === "1"
      ? ["getTypeAtLocation"]
      : []),
  ]);
  const ADAPTIVE_THRESHOLD = 16;
  let asked = new Map();
  const prepareFile = nodes => {
    nodesByKind = nodes;
    batches = new Map();
    asked = new Map();
  };
  const batchedQueries = new Set([
    "getTypeAtLocation",
    "getSymbolAtLocation",
    ...(contextualTypes === undefined ? [] : ["getContextualType"]),
  ]);
  const nativeQueries = {
    getTypeAtLocation: { mask: 1, column: "types", convert: lazy?.type },
    getSymbolAtLocation: { mask: 2, column: "symbols", convert: lazy?.symbol },
    getContextualType: {
      mask: 4,
      column: "contextualTypes",
      convert: lazy?.type,
    },
  };
  const prefetchNative = process.env.LINTRS_LAZY_PREFETCH === "1";
  const query = (owner, key, fn, args, memo) => {
    if (
      symbolFacts !== undefined &&
      owner === project.checker &&
      key === "getAliasedSymbol" &&
      args.length === 1
    ) {
      const symbol = args[0];
      if (!aliasedSymbols.has(symbol)) {
        const response = symbolFacts.alias(symbol);
        seedDeclarations(response.declarations);
        aliasedSymbols.set(
          symbol,
          project.checker.objectRegistry.getOrCreateSymbol(response.symbol),
        );
      } else symbolStats.aliasHits++;
      return aliasedSymbols.get(symbol);
    }
    const operation = nativeQueries[key];
    if (
      native !== undefined &&
      owner === project.checker &&
      operation !== undefined &&
      args.length === 1 &&
      !Array.isArray(args[0])
    ) {
      const node = args[0];
      let results = batches.get(key);
      if (results === undefined) {
        results = new IdentityMap();
        batches.set(key, results);
      }
      if (!results.has(node)) {
        const candidates = nodesByKind.get(node?.kind);
        const nodes =
          prefetchNative && candidates?.has(node) ? [...candidates] : [node];
        for (let start = 0; start < nodes.length; start += 256) {
          const group = nodes.slice(start, start + 256);
          const fields =
            key === "getSymbolAtLocation"
              ? (native.plans?.fields(key, node.kind) ?? [])
              : [];
          const values = native.nodes(group, operation.mask, fields)[
            operation.column
          ];
          if (fields.length > 0) {
            native.plans.stats.fusedQueries++;
            native.plans.stats.fusedFields += fields.length * group.length;
          }
          if (!Array.isArray(values) || values.length !== group.length)
            throw new Error("Invalid native node-fact response");
          for (const [index, candidate] of group.entries())
            results.set(
              candidate,
              values[index] == null
                ? undefined
                : operation.convert(values[index], undefined, fields),
            );
        }
      }
      return results.get(node);
    }
    if (
      owner === project.checker &&
      key === "isTypeAssignableTo" &&
      args.length === 2 &&
      (args[0]?.flags & sdk.api.TypeFlags.StringLiteral) !== 0 &&
      (args[1]?.flags & sdk.api.TypeFlags.StringLiteral) !== 0
    ) {
      const group = literalGroups.get(args[1]);
      if (group !== undefined) {
        const missing = group.filter(target => !memo.has(target));
        if (missing.length > 0) {
          const values = ctx.compareTargets(args[0], missing);
          if (
            !Array.isArray(values) ||
            values.length !== missing.length ||
            !values.every(value => typeof value === "boolean")
          )
            throw new Error("Invalid Rust assignability batch response");
          for (const [index, target] of missing.entries())
            memo.set(target, values[index]);
        }
        return memo.get(args[1]);
      }
    }
    if (
      owner !== project.checker ||
      !batchedQueries.has(key) ||
      args.length !== 1
    )
      return fn.apply(owner, args);
    const node = args[0];
    const single = () =>
      symbolFacts !== undefined && key === "getSymbolAtLocation"
        ? readSymbols([node])[0]
        : fn.apply(owner, args);
    const candidates = nodesByKind.get(node?.kind);
    if (candidates === undefined || !candidates.has(node)) return single();
    let results = batches.get(key);
    if (results === undefined) {
      results = new IdentityMap();
      batches.set(key, results);
    }
    if (!results.has(node) && adaptiveQueries.has(key)) {
      let byKind = asked.get(key);
      if (byKind === undefined) {
        byKind = new Map();
        asked.set(key, byKind);
      }
      const count = (byKind.get(node.kind) ?? 0) + 1;
      byKind.set(node.kind, count);
      if (count <= ADAPTIVE_THRESHOLD) {
        const value = single();
        results.set(node, value);
        return value;
      }
    }
    if (!results.has(node)) {
      // Nodes already answered keep their answers (and identities).
      const nodes = [...candidates].filter(
        candidate => !results.has(candidate),
      );
      for (let start = 0; start < nodes.length; start += 256) {
        const group = nodes.slice(start, start + 256);
        const values =
          key === "getContextualType"
            ? contextualTypes(group)
            : symbolFacts !== undefined && key === "getSymbolAtLocation"
              ? readSymbols(group)
              : fn.call(owner, group);
        if (!Array.isArray(values) || values.length !== group.length)
          throw new Error("Invalid batched checker response");
        for (const [index, candidate] of group.entries())
          results.set(candidate, values[index]);
      }
    }
    return results.get(node);
  };
  const profile = profiler();
  // A rule callback the adapter calls (a checker method taking a function)
  // is the rule's own code again, not adapter work.
  const resume = profile === undefined ? fn => fn() : profile.resume;
  const ownerKind = owner =>
    owner === project.checker
      ? "checker"
      : owner === project.program
        ? "program"
        : typeof owner.isUnionType === "function"
          ? "type"
          : owner instanceof sdk.api.Symbol
            ? "symbol"
            : owner instanceof sdk.api.Signature
              ? "signature"
              : typeof owner.kind === "number" && typeof owner.pos === "number"
                ? "node"
                : "object";
  const invoke = (owner, key, fn) => {
    let bound = methods.get(owner);
    if (bound === undefined) {
      bound = new Map();
      methods.set(owner, bound);
    }
    if (!bound.has(key)) {
      const memo =
        (owner === project.checker && cachedQueries.has(key)) ||
        (typeof owner.isUnionType === "function" && key === "getProperty")
          ? new Map()
          : undefined;
      const call = (...args) => {
        const rawArgs = args.map(argument =>
          typeof argument === "function"
            ? (...items) => {
                const wrapped = items.map(ctx.wrap);
                return unwrap(resume(() => argument(...wrapped)));
              }
            : unwrap(argument),
        );
        let entry;
        if (memo !== undefined) {
          entry = memo.get(rawArgs.length);
          if (entry === undefined) {
            entry = new Map();
            memo.set(rawArgs.length, entry);
          }
          for (let index = 0; index < rawArgs.length - 1; index++) {
            const argument = rawArgs[index];
            if (!entry.has(argument)) entry.set(argument, new Map());
            entry = entry.get(argument);
          }
        }
        const last = rawArgs.at(-1);
        let result;
        if (entry?.has(last)) result = entry.get(last);
        else {
          result = ctx.wrap(query(owner, key, fn, rawArgs, entry));
          entry?.set(last, result);
        }
        if (owner === project.checker && key === "getSymbolAtLocation")
          native?.plans?.observe(result, key, rawArgs[0]?.kind);
        return result;
      };
      // TIMING: the bound method's own work (unwrapping, memo lookups,
      // building and wrapping results) is adapter work; its checker
      // requests still bill as checker time. Labelled "<owner>.<method>".
      const label =
        profile === undefined
          ? undefined
          : `${ownerKind(owner)}.${String(key)}`;
      bound.set(
        key,
        profile === undefined
          ? call
          : (...args) =>
              profile.active("adapter")
                ? call(...args)
                : profile.charge("adapter", label, () => call(...args)),
      );
    }
    return bound.get(key);
  };
  return { indexUnion, prepareFile, query, invoke };
}

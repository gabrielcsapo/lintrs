import { profiler } from "../profile.mjs";
import { displayParts, docTags } from "./wrapping.mjs";

// TIMING labels for property reads, "get <kind>.<property>", built once per
// kind and property (array indices collapse to "[index]").
const readLabels = new Map();
const readLabel = (kind, key) => {
  let labels = readLabels.get(kind);
  if (labels === undefined) {
    labels = new Map();
    readLabels.set(kind, labels);
  }
  let label = labels.get(key);
  if (label === undefined) {
    const name =
      typeof key === "symbol"
        ? `[${key.description}]`
        : kind === "array" && /^\d+$/u.test(key)
          ? "[index]"
          : key;
    label = `get ${kind}.${name}`;
    labels.set(key, label);
  }
  return label;
};
const typeProperties = {
  symbol: "getSymbol",
  aliasSymbol: "getAliasSymbol",
  types: "getTypes",
  target: "getTarget",
  freshType: "getFreshType",
  regularType: "getRegularType",
  typeParameters: "getTypeParameters",
  outerTypeParameters: "getOuterTypeParameters",
  localTypeParameters: "getLocalTypeParameters",
  thisType: "getThisType",
  aliasTypeArguments: "getAliasTypeArguments",
  objectType: "getObjectType",
  indexType: "getIndexType",
  checkType: "getCheckType",
  extendsType: "getExtendsType",
  baseType: "getBaseType",
  constraint: "getConstraint",
  default: "getDefault",
  trueType: "getTrueType",
  falseType: "getFalseType",
  resolvedBaseTypes: "getBaseTypes",
};
const mappedTypeProperties = {
  typeParameter: "getTypeParameterOfMappedType",
  constraintType: "getConstraintTypeOfMappedType",
  nameType: "getNameTypeOfMappedType",
  templateType: "getTemplateTypeOfMappedType",
};
const typeMethods = {
  isUnion: "isUnionType",
  isIntersection: "isIntersectionType",
  isLiteral: "isLiteralType",
  isStringLiteral: "isStringLiteralType",
  isNumberLiteral: "isNumberLiteralType",
  isTypeParameter: "isTypeParameter",
  isClassOrInterface: "isClassOrInterface",
};

// The `get`/`has` traps of the main wrapper proxy: tsc-compatible property
// access over tsrs nodes, types, symbols, signatures, maps, and arrays.
export function createGetHandler(ctx) {
  const {
    ts,
    sdk,
    project,
    lazy,
    native,
    flags,
    kinds,
    intrinsicTypeNodes,
    symbolFacts,
    symbolDocs,
    signatureDocs,
  } = ctx;
  // Node fields that hold a SyntaxKind rather than a child node need the same
  // translation as `kind`: tsrs numbers several tokens and keywords
  // differently from TypeScript (ExtendsKeyword is 95 in tsrs, 96 in
  // TypeScript, where 95 is ExportKeyword).
  const kindFields = new Map([
    [sdk.ast.SyntaxKind.PrefixUnaryExpression, "operator"],
    [sdk.ast.SyntaxKind.PostfixUnaryExpression, "operator"],
    [sdk.ast.SyntaxKind.TypeOperator, "operator"],
    [sdk.ast.SyntaxKind.HeritageClause, "token"],
    [sdk.ast.SyntaxKind.MetaProperty, "keywordToken"],
    [sdk.ast.SyntaxKind.ImportAttributes, "token"],
  ]);
  const handlerFor = ({
    isNode,
    isType,
    isSymbol,
    isSignature,
    isHeritageType,
    isHeritageExpression,
  }) => ({
    get(target, key) {
      if (target === project.checker && key === "getTypeArguments")
        return type =>
          ctx.unwrap(type).isTypeReference()
            ? ctx.invoke(target, key, target[key])(type)
            : [];
      if (target === project.checker && key === "getTypeFromTypeNode")
        return node => {
          // TypeScript returns any for these unbound factory nodes.
          if (node?.pos < 0 && intrinsicTypeNodes.has(node.kind))
            return ctx.wrap(target.getAnyType());
          return ctx.invoke(target, key, target[key])(node);
        };
      if (target === project.checker && key === "getTypeAtLocation")
        return node => {
          if (node !== undefined)
            return ctx.invoke(target, key, target[key])(node);
          if (ctx.errorType === undefined) {
            const raw = target.getAnyType();
            ctx.errorType = new Proxy(ctx.wrap(raw), {
              get(type, property) {
                return property === "intrinsicName"
                  ? "error"
                  : Reflect.get(type, property);
              },
            });
            ctx.originals.set(ctx.errorType, raw);
          }
          return ctx.errorType;
        };
      if (target === project.checker && key === "getSymbolAtLocation")
        return node =>
          [
            sdk.ast.SyntaxKind.ImportKeyword,
            sdk.ast.SyntaxKind.NewKeyword,
          ].includes(ctx.unwrap(node)?.kind)
            ? undefined
            : ctx.invoke(target, key, target[key])(node);
      if (
        target === project.checker &&
        key === "getShorthandAssignmentValueSymbol"
      )
        return node =>
          node == null ? undefined : ctx.invoke(target, key, target[key])(node);
      if (isNode && key === "kind") {
        if (isHeritageType) return ts.SyntaxKind.ExpressionWithTypeArguments;
        if (isHeritageExpression) return ts.SyntaxKind.PropertyAccessExpression;
        const kind = kinds.get(target.kind);
        if (kind === undefined)
          throw new Error(
            `Unsupported tsrs SyntaxKind: ${sdk.ast.SyntaxKind[target.kind]}`,
          );
        return kind;
      }
      if (isNode && kindFields.get(target.kind) === key) {
        const kind = kinds.get(target[key]);
        if (kind === undefined)
          throw new Error(
            `Unsupported tsrs SyntaxKind in ${sdk.ast.SyntaxKind[target.kind]}.${key}: ${sdk.ast.SyntaxKind[target[key]]}`,
          );
        return kind;
      }
      if (isHeritageType && key === "expression")
        return ctx.wrap(target.typeName);
      if (isHeritageExpression && key === "expression")
        return ctx.wrap(target.left);
      if (isHeritageExpression && key === "name") return ctx.wrap(target.right);
      if (
        isNode &&
        target.kind === sdk.ast.SyntaxKind.TypeParameter &&
        key === "default"
      )
        return ctx.wrap(target.defaultType);
      // TypeScript 6 stores this module marker as a property, outside SymbolFlags.
      if (
        isSymbol &&
        key === "constEnumOnlyModule" &&
        (target.flags & sdk.api.SymbolFlags.ConstEnumOnlyModule) !== 0
      )
        return true;
      if (key === "flags") {
        if (isType) return flags.type(target.flags);
        if (isNode) return flags.node(target.flags);
        if (isSymbol) return flags.symbol(target.flags);
      }
      if (isType) {
        if (key === "minLength" && target.fixedLength !== undefined)
          return (target.elementFlags ?? []).filter(
            flag =>
              (flag &
                (sdk.api.ElementFlags.Required |
                  sdk.api.ElementFlags.Variadic)) !==
              0,
          ).length;
        if (
          key === "intrinsicName" &&
          (target.flags & sdk.api.TypeFlags.BooleanLiteral) !== 0 &&
          typeof target.value === "boolean"
        )
          return String(target.value);
        if (
          key === "escapedName" &&
          (target.flags & sdk.api.TypeFlags.UniqueESSymbol) !== 0
        ) {
          const symbol = target.getSymbol();
          if (symbol === undefined)
            throw new Error("A unique symbol type has no symbol");
          return `__@${symbol.escapedName}@${symbol.id}`;
        }
        if (key === "target" && !target.isTypeReference()) return undefined;
        if (key === "objectFlags") return flags.object(target.objectFlags ?? 0);
        if (key === "isUnionOrIntersection")
          return () => target.isUnionType() || target.isIntersectionType();
        if (key === "isClass")
          return () => !!(target.objectFlags & sdk.api.ObjectFlags.Class);
        if (key === "getFlags") return () => flags.type(target.flags);
        if (key === "getTypeArguments")
          return () =>
            ctx.invoke(
              project.checker,
              "getTypeArguments",
              project.checker.getTypeArguments,
            )(target);
        if (key === "typeArguments" || key === "resolvedTypeArguments")
          return target.isTypeReference()
            ? ctx.invoke(
                project.checker,
                "getTypeArguments",
                project.checker.getTypeArguments,
              )(target)
            : undefined;
        if (
          key === "aliasTypeArguments" &&
          target.aliasTypeArguments.length === 0
        )
          return undefined;
        if (key === "value" && typeof target.value === "bigint")
          return {
            negative: target.value < 0n,
            base10Value: String(
              target.value < 0n ? -target.value : target.value,
            ),
          };
        if (
          mappedTypeProperties[key] !== undefined &&
          (target.objectFlags & sdk.api.ObjectFlags.Mapped) !== 0
        )
          return ctx.wrap(
            target.objectRegistry.fetchOptionalType(
              target,
              mappedTypeProperties[key],
              target[key] ?? false,
            ),
          );
        if (typeProperties[key] !== undefined) {
          const result = target[typeProperties[key]]();
          if (key === "types") ctx.indexUnion(target, result);
          return ctx.wrap(result);
        }
        if (typeMethods[key] !== undefined)
          return ctx.invoke(target, key, target[typeMethods[key]]);
      }
      if (isSymbol) {
        if (key === "declarations" && target.declarations.length === 0)
          return undefined;
        if (key === "getName") return () => target.name;
        if (key === "getEscapedName") return () => target.escapedName;
        if (key === "getFlags") return () => flags.symbol(target.flags);
        if (key === "getDeclarations")
          return () =>
            target.declarations.length === 0
              ? undefined
              : ctx.wrap(target.declarations);
        if (key === "getJsDocTags")
          return () => {
            if (!symbolDocs.has(target))
              symbolDocs.set(
                target,
                docTags(target.getJsDocTags(project.checker)),
              );
            return symbolDocs.get(target);
          };
        if (key === "getDocumentationComment")
          return () =>
            displayParts(target.getDocumentationComment(project.checker)) ?? [];
        const property = {
          parent: "getParent",
          members: "getMembers",
          exports: "getExports",
          exportSymbol: "getExportSymbol",
        }[key];
        if (property !== undefined) return ctx.wrap(target[property]());
      }
      if (isSignature) {
        if (key === "getJsDocTags")
          return () => {
            if (signatureDocs.has(target)) return signatureDocs.get(target);
            const declaration = target.declaration?.resolve();
            if (declaration === undefined) return [];
            const tags = sdk.ast.getJSDocTags(declaration).map(tag => ({
              name: tag.tagName.text,
              text: displayParts(sdk.ast.getTextOfJSDocComment(tag.comment)),
            }));
            signatureDocs.set(target, tags);
            return tags;
          };
        const property = {
          parameters: "getParameters",
          typeParameters: "getTypeParameters",
          thisParameter: "getThisParameter",
          target: "getTarget",
        }[key];
        if (property !== undefined) return ctx.wrap(target[property]());
        if (key === "getDeclaration") return () => ctx.wrap(target.declaration);
      }
      if (target instanceof Map) {
        if (key === "get") return name => ctx.wrap(target.get(name));
        if (key === "values")
          return function* () {
            for (const item of target.values()) yield ctx.wrap(item);
          };
        if (key === Symbol.iterator || key === "entries")
          return function* () {
            for (const [name, item] of target) yield [name, ctx.wrap(item)];
          };
        const item = Reflect.get(target, key, target);
        return typeof item === "function" ? item.bind(target) : item;
      }
      if (Array.isArray(target)) {
        if (
          lazy !== undefined &&
          ["includes", "indexOf", "lastIndexOf"].includes(key)
        )
          return (item, ...rest) =>
            target.map(value => ctx.wrap(value))[key](ctx.wrap(item), ...rest);
        if (key === Symbol.iterator || key === "values")
          return function* () {
            for (const item of target) yield ctx.wrap(item);
          };
        if (key === "entries")
          return function* () {
            for (const [index, item] of target.entries())
              yield [index, ctx.wrap(item)];
          };
      }
      const item = Reflect.get(target, key, target);
      return typeof item === "function"
        ? ctx.invoke(target, key, item)
        : ctx.wrap(item);
    },
    has(target, key) {
      if (
        isType &&
        key === "typeParameter" &&
        (target.objectFlags & sdk.api.ObjectFlags.Mapped) !== 0
      )
        return true;
      if (isType && target[key] === undefined) return false;
      return Reflect.has(target, key);
    },
  });
  // TIMING: property reads on wrapped types, symbols, signatures and nodes
  // are adapter work, billed to the rule doing the reading.
  const profile = profiler();
  if (profile === undefined) return handlerFor;
  return options => {
    const handler = handlerFor(options);
    const { get } = handler;
    const kind = options.isType
      ? "type"
      : options.isSymbol
        ? "symbol"
        : options.isSignature
          ? "signature"
          : options.isNode
            ? "node"
            : undefined;
    handler.get = (target, key) => {
      // Nested inside other adapter work, a read is part of that entry.
      const frame = profile.active("adapter")
        ? undefined
        : profile.enter(
            "adapter",
            readLabel(
              kind ??
                (Array.isArray(target)
                  ? "array"
                  : target instanceof Map
                    ? "map"
                    : "object"),
              key,
            ),
          );
      try {
        return get.call(handler, target, key);
      } finally {
        profile.exit(frame);
      }
    };
    return handler;
  };
}

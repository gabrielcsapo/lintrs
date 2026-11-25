import { IdentityMap } from "./state.mjs";

const nodeKinds = {
  Program: ["SourceFile"],
  Literal: [
    "StringLiteral",
    "NumericLiteral",
    "BigIntLiteral",
    "TrueKeyword",
    "FalseKeyword",
    "NullKeyword",
    "RegularExpressionLiteral",
  ],
  BinaryExpression: ["BinaryExpression"],
  SequenceExpression: ["BinaryExpression"],
  ImportExpression: ["CallExpression"],
  ExportAllDeclaration: ["ExportDeclaration"],
  ExportNamedDeclaration: ["ExportDeclaration"],
  TSDeclareFunction: ["FunctionDeclaration"],
  LogicalExpression: ["BinaryExpression"],
  AssignmentExpression: ["BinaryExpression"],
  UnaryExpression: [
    "PrefixUnaryExpression",
    "TypeOfExpression",
    "VoidExpression",
    "DeleteExpression",
  ],
  UpdateExpression: ["PrefixUnaryExpression", "PostfixUnaryExpression"],
  MemberExpression: [
    "PropertyAccessExpression",
    "ElementAccessExpression",
    "QualifiedName",
  ],
  ArrayExpression: ["ArrayLiteralExpression"],
  ObjectExpression: ["ObjectLiteralExpression"],
  ArrayPattern: ["ArrayBindingPattern", "ArrayLiteralExpression"],
  ObjectPattern: ["ObjectBindingPattern", "ObjectLiteralExpression"],
  Property: [
    "PropertyAssignment",
    "ShorthandPropertyAssignment",
    "BindingElement",
    "MethodDeclaration",
    "GetAccessor",
    "SetAccessor",
  ],
  VariableDeclaration: ["VariableStatement", "VariableDeclarationList"],
  VariableDeclarator: ["VariableDeclaration"],
  FunctionExpression: [
    "FunctionExpression",
    "MethodDeclaration",
    "GetAccessor",
    "SetAccessor",
  ],
  ArrowFunctionExpression: ["ArrowFunction"],
  BlockStatement: ["Block", "ModuleBlock"],
  ConditionalExpression: ["ConditionalExpression"],
  ChainExpression: [
    "CallExpression",
    "PropertyAccessExpression",
    "ElementAccessExpression",
  ],
  ThisExpression: ["ThisKeyword"],
  Super: ["SuperKeyword"],
  SpreadElement: ["SpreadElement", "SpreadAssignment"],
  RestElement: ["Parameter", "BindingElement"],
  AssignmentPattern: ["Parameter", "BindingElement"],
  MethodDefinition: [
    "MethodDeclaration",
    "GetAccessor",
    "SetAccessor",
    "Constructor",
  ],
  PropertyDefinition: ["PropertyDeclaration"],
  TemplateLiteral: ["TemplateExpression", "NoSubstitutionTemplateLiteral"],
  TaggedTemplateExpression: ["TaggedTemplateExpression"],
  TSTypeAnnotation: [],
  TSTypeParameter: ["TypeParameter"],
  TSTypeReference: ["TypeReference"],
  TSQualifiedName: ["QualifiedName"],
  TSInterfaceBody: ["InterfaceDeclaration"],
  TSInterfaceHeritage: ["ExpressionWithTypeArguments", "TypeReference"],
  TSClassImplements: ["ExpressionWithTypeArguments", "TypeReference"],
  TSInstantiationExpression: ["ExpressionWithTypeArguments"],
  TSCallSignatureDeclaration: ["CallSignature"],
  TSConstructSignatureDeclaration: ["ConstructSignature"],
  TSParameterProperty: ["Parameter"],
  TSExpressionWithTypeArguments: ["ExpressionWithTypeArguments"],
  TSAbstractMethodDefinition: ["MethodDeclaration"],
  TSAbstractPropertyDefinition: ["PropertyDeclaration"],
  JSXIdentifier: ["Identifier", "ThisKeyword"],
  JSXMemberExpression: ["PropertyAccessExpression"],
  JSXElement: ["JsxElement", "JsxSelfClosingElement"],
  JSXOpeningElement: ["JsxOpeningElement", "JsxSelfClosingElement"],
  JSXClosingElement: ["JsxClosingElement"],
  JSXFragment: ["JsxFragment"],
  JSXOpeningFragment: ["JsxOpeningFragment"],
  JSXClosingFragment: ["JsxClosingFragment"],
  JSXExpressionContainer: ["JsxExpression"],
  JSXText: ["JsxText"],
  JSXAttribute: ["JsxAttribute"],
  JSXSpreadAttribute: ["JsxSpreadAttribute"],
  JSXNamespacedName: ["JsxNamespacedName"],
};

export function nodeMaps(sourceCode, rawFile, adapter, sdk) {
  const { ts } = adapter;
  const byRange = new Map();
  const byKind = new Map();
  const visit = node => {
    let nodes = byKind.get(node.kind);
    if (nodes === undefined) {
      nodes = new Set();
      byKind.set(node.kind, nodes);
    }
    nodes.add(node);
    const starts = new Set([node.getStart()]);
    if (node.kind === sdk.ast.SyntaxKind.SourceFile) starts.add(0);
    for (const modifier of node.modifiers ?? []) {
      if (modifier.kind === sdk.ast.SyntaxKind.Decorator) continue;
      if (
        modifier.kind !== sdk.ast.SyntaxKind.ExportKeyword &&
        modifier.kind !== sdk.ast.SyntaxKind.DefaultKeyword
      )
        break;
      starts.add(ts.skipTrivia(rawFile.text, modifier.end));
    }
    for (const start of starts) {
      const key = `${start}:${node.end}`;
      const matches = byRange.get(key);
      if (matches === undefined) byRange.set(key, node);
      else if (Array.isArray(matches)) matches.push(node);
      else byRange.set(key, [matches, node]);
    }
    node.forEachChild(visit);
  };
  visit(rawFile);
  adapter.prepareFile(byKind);
  const forward = new IdentityMap();
  const reverse = new IdentityMap();
  let reverseIndexed = false;
  const get = (node, required = true) => {
    if (forward.has(node)) return forward.get(node);
    if (
      node.type === "AssignmentPattern" &&
      node.parent?.type === "TSParameterProperty"
    ) {
      const mapped = get(node.parent, required);
      if (mapped !== undefined) forward.set(node, mapped);
      return mapped;
    }
    if (node.type === "ChainExpression") {
      const mapped = get(node.expression, required);
      if (mapped !== undefined) forward.set(node, mapped);
      return mapped;
    }
    if (
      ["ExportNamedDeclaration", "ExportDefaultDeclaration"].includes(
        node.type,
      ) &&
      node.declaration != null
    ) {
      const mapped = get(node.declaration, required);
      if (mapped !== undefined) forward.set(node, mapped);
      return mapped;
    }
    if (
      node.type === "Identifier" &&
      node.parent?.type === "MethodDefinition" &&
      node.parent.kind === "constructor" &&
      node.parent.key === node
    ) {
      const mapped = get(node.parent, required);
      if (mapped !== undefined) forward.set(node, mapped);
      return mapped;
    }
    if (
      node.type === "Identifier" &&
      node.parent?.type === "MetaProperty" &&
      node.parent.meta === node
    ) {
      const mapped = get(node.parent, required)?.getFirstToken();
      if (mapped !== undefined) {
        forward.set(node, mapped);
        reverse.set(mapped, node);
      }
      return mapped;
    }
    if (
      node.type === "TSTypeAnnotation" ||
      node.type === "TSTypeParameterDeclaration"
    )
      return undefined;
    if (node.type === "TSTypeParameterInstantiation") {
      const mapped = get(node.parent, required);
      if (mapped !== undefined) forward.set(node, mapped);
      return mapped;
    }
    if (
      ["FunctionExpression", "TSEmptyBodyFunctionExpression"].includes(
        node.type,
      ) &&
      (["MethodDefinition", "TSAbstractMethodDefinition"].includes(
        node.parent?.type,
      ) ||
        node.parent?.method === true ||
        (node.parent?.type === "Property" &&
          ["get", "set"].includes(node.parent.kind)))
    ) {
      const mapped = get(node.parent, required);
      if (mapped !== undefined) forward.set(node, mapped);
      return mapped;
    }
    const names = nodeKinds[node.type] ?? [node.type.replace(/^TS/u, "")];
    let range = node.range;
    if (
      node.type === "Identifier" &&
      (node.typeAnnotation != null || node.optional)
    )
      range = sourceCode.getFirstToken(node).range;
    else if (
      (node.type === "ObjectPattern" || node.type === "ArrayPattern") &&
      node.typeAnnotation != null
    )
      range = [
        node.range[0],
        sourceCode.getTokenBefore(node.typeAnnotation).range[1],
      ];
    const candidates = byRange.get(`${range[0]}:${range[1]}`);
    const matchingKind = candidate =>
      names.some(name => sdk.ast.SyntaxKind[name] === candidate.kind);
    const matches = Array.isArray(candidates)
      ? candidates.filter(matchingKind)
      : candidates !== undefined && matchingKind(candidates)
        ? [candidates]
        : [];
    if (matches.length === 0 && !required) return undefined;
    if (matches.length !== 1)
      throw new Error(
        `Cannot map ${node.type} at ${node.range.join(":")} to one tsrs node (${matches.length} matches)`,
      );
    const mapped = adapter.wrap(matches[0]);
    forward.set(node, mapped);
    reverse.set(mapped, node);
    return mapped;
  };
  return {
    esTreeNodeToTSNodeMap: { get, has: node => get(node, false) !== undefined },
    tsNodeToESTreeNodeMap: {
      get(node) {
        if (!reverse.has(node) && !reverseIndexed) {
          const visitEstree = current => {
            get(current, false);
            for (const key of sourceCode.visitorKeys[current.type] ?? []) {
              const value = current[key];
              if (Array.isArray(value)) {
                for (const child of value)
                  if (child !== null) visitEstree(child);
              } else if (value !== null && value !== undefined)
                visitEstree(value);
            }
          };
          visitEstree(sourceCode.ast);
          reverseIndexed = true;
        }
        const result = reverse.get(node);
        if (result === undefined)
          throw new Error(
            `Cannot map tsrs node back to ESTree at ${node.pos}:${node.end}`,
          );
        return result;
      },
      has: node => reverse.has(node),
    },
  };
}

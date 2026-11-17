import { hostCommand } from "./host-command.mjs";
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export function createGraphQLHost(root) {
  const require = createRequire(join(root, "eslint.config.mjs"));
  const eslintRequire = createRequire(require.resolve("eslint"));
  const { SourceCode } = require("eslint");
  const { FileReport } = eslintRequire("./linter/file-report.js");
  const selectors = eslintRequire("./linter/esquery.js");
  const pluginPath = dirname(require.resolve("@graphql-eslint/eslint-plugin"));
  const graphqlRequire = createRequire(join(pluginPath, "index.js"));
  const gql = graphqlRequire("graphql");
  const { QueryDocumentKeys } = graphqlRequire("graphql/language/ast.js");
  const { convertToESTree, convertToken, extractComments } = require(
    join(pluginPath, "estree-converter/index.js"),
  );
  const { getSiblings } = require(join(pluginPath, "siblings.js"));
  const schemas = new Map();
  const siblings = new Map();
  const visitorKeys = Object.fromEntries(
    Object.entries(QueryDocumentKeys).map(([kind, keys]) => [
      kind,
      keys.map(key => (key === "type" ? "gqlType" : key)),
    ]),
  );
  visitorKeys.Program = ["body"];

  const pending = new Map();
  const parseMany = sources => {
    const parsed = hostCommand(
      "parse-graphql",
      JSON.stringify(sources.map(source => source.text)),
      256 * 1024 * 1024,
    );
    return JSON.parse(parsed).map((wire, sourceIndex) => {
      const { text, filePath } = sources[sourceIndex];
      const source = new gql.Source(text, filePath);
      const tokens = wire.tokens.map(
        token =>
          new gql.Token(
            token.kind,
            token.start,
            token.end,
            token.line,
            token.column,
            token.value ?? undefined,
          ),
      );
      for (const [index, token] of tokens.entries()) {
        token.prev = tokens[index - 1] ?? null;
        token.next = tokens[index + 1] ?? null;
      }
      const nodes = wire.nodes.map(node => ({
        kind: node.kind,
        loc: new gql.Location(
          tokens[node.startToken],
          tokens[node.endToken],
          source,
        ),
      }));
      for (const [index, wireNode] of wire.nodes.entries()) {
        const node = nodes[index];
        for (const key of QueryDocumentKeys[node.kind]) {
          const value = wireNode.fields[key];
          if (Array.isArray(value)) node[key] = value.map(id => nodes[id]);
          else if (value !== undefined) node[key] = nodes[value];
        }
        if (
          [
            "Name",
            "IntValue",
            "FloatValue",
            "EnumValue",
            "StringValue",
          ].includes(node.kind)
        )
          node.value = wireNode.text;
        if (node.kind === "BooleanValue") node.value = wireNode.text === "true";
        if (node.kind === "StringValue") node.block = wireNode.block;
        if (node.kind === "DirectiveDefinition")
          node.repeatable = wireNode.repeatable;
        if (wireNode.operation !== null) node.operation = wireNode.operation;
      }
      return { document: nodes[0], tokens };
    });
  };
  const parse = (text, filePath) => {
    const cached = pending.get(filePath);
    if (cached !== undefined) {
      pending.delete(filePath);
      return cached;
    }
    return parseMany([{ text, filePath }])[0];
  };
  const loadDocuments = (pointer, cwd) => {
    if (!pointer) return [];
    const patterns = typeof pointer === "string" ? [pointer] : pointer;
    if (
      !Array.isArray(patterns) ||
      patterns.some(value => typeof value !== "string")
    )
      throw new Error(
        "GraphQL schema and document pointers must be paths or SDL strings",
      );
    return patterns.flatMap(pattern => {
      const paths = globSync(pattern, { cwd });
      if (paths.length === 0) {
        if (/\s/u.test(pattern))
          return [
            { location: "inline.graphql", ...parse(pattern, "inline.graphql") },
          ];
        throw new Error(`GraphQL pointer did not match any files: ${pattern}`);
      }
      return paths.map(path => {
        const location = resolve(cwd, path);
        return { location, ...parse(readFileSync(location, "utf8"), location) };
      });
    });
  };
  const services = (options, filePath) => {
    const config = options.graphQLConfig ?? {};
    if (config.projects !== undefined)
      throw new Error(`GraphQL project selection is unsupported: ${filePath}`);
    const pointer = options.schemaSdl ?? config.schema;
    const schemaKey = JSON.stringify(pointer);
    if (!schemas.has(schemaKey)) {
      const documents = loadDocuments(pointer, root);
      const definitions = documents.flatMap(
        source => source.document.definitions,
      );
      schemas.set(
        schemaKey,
        definitions.length === 0
          ? null
          : gql.buildASTSchema(
              { kind: "Document", definitions },
              { assumeValidSDL: true },
            ),
      );
    }
    const documentKey = JSON.stringify(config.documents);
    if (!siblings.has(documentKey))
      siblings.set(
        documentKey,
        getSiblings(loadDocuments(config.documents, root)),
      );
    return {
      schema: schemas.get(schemaKey),
      siblingOperations: siblings.get(documentKey),
    };
  };

  const lint = ({ filePath, text, config, rules, quiet }) => {
    const parsed = parse(text, filePath);
    const parserServices = services(
      config.languageOptions.parserOptions ?? {},
      filePath,
    );
    const tree = convertToESTree(parsed.document, parserServices.schema);
    const ast = {
      type: "Program",
      sourceType: "script",
      body: [tree],
      range: tree.range,
      loc: tree.loc,
      comments: extractComments(parsed.document.loc),
      tokens: parsed.tokens
        .filter(token => !["<SOF>", "<EOF>", "Comment"].includes(token.kind))
        .map(token => convertToken(token, token.kind)),
    };
    const sourceCode = new SourceCode({
      text,
      ast,
      visitorKeys,
      parserServices,
    });
    const report = new FileReport({
      ruleMapper: id => rules.get(id),
      sourceCode,
      language: { lineStart: 1, columnStart: 0 },
    });
    const listeners = new Map();
    for (const [id, setting] of Object.entries(config.rules ?? {})) {
      if (setting[0] === 0 || (quiet && setting[0] === 1)) continue;
      const rule = rules.get(id);
      if (rule === undefined)
        throw new Error(`No implementation for GraphQL rule ${id}`);
      const context = {
        id,
        options: setting.slice(1),
        settings: config.settings ?? {},
        languageOptions: config.languageOptions,
        parserOptions: config.languageOptions.parserOptions ?? {},
        parserServices,
        sourceCode,
        filename: filePath,
        physicalFilename: filePath,
        cwd: root,
        getFilename: () => filePath,
        getPhysicalFilename: () => filePath,
        getSourceCode: () => sourceCode,
        getCwd: () => root,
        report: (...args) => report.addRuleMessage(id, setting[0], ...args),
      };
      for (const [selector, listener] of Object.entries(rule.create(context))) {
        const entry = listeners.get(selector) ?? {
          selector: selectors.parse(selector),
          callbacks: [],
        };
        entry.callbacks.push(listener);
        listeners.set(selector, entry);
      }
    }
    const ordered = [...listeners.values()].sort((a, b) =>
      a.selector.compare(b.selector),
    );
    const enter = ordered.filter(entry => !entry.selector.isExit);
    const exit = ordered.filter(entry => entry.selector.isExit);
    const ancestors = [];
    const dispatch = (node, entries) => {
      for (const { selector, callbacks } of entries) {
        if (
          selector.nodeTypes !== null &&
          !selector.nodeTypes.includes(node.type)
        )
          continue;
        if (
          selectors.matches(node, selector.root, ancestors, {
            visitorKeys,
            fallback: () => [],
          })
        )
          for (const callback of callbacks) callback(node);
      }
    };
    const visit = (node, parent) => {
      Object.defineProperty(node, "parent", { value: parent, writable: true });
      dispatch(node, enter);
      ancestors.unshift(node);
      for (const key of visitorKeys[node.type] ?? []) {
        const values = Array.isArray(node[key]) ? node[key] : [node[key]];
        for (const child of values) if (child != null) visit(child, node);
      }
      ancestors.shift();
      dispatch(node, exit);
    };
    visit(ast, null);
    return report.messages;
  };
  lint.prepare = sources => {
    const parsed = parseMany(sources);
    for (const [index, source] of sources.entries())
      pending.set(source.filePath, parsed[index]);
  };
  return lint;
}

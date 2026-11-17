# JavaScript rules

Any ESLint-compatible rule works — builtins, plugin rules, and your own.
Typed rules get `parserServices` compatible with `@typescript-eslint` (the
program, node maps, and a checker proxied to the pinned tsrs checker).

## A typed TypeScript rule

This rule asks the checker for the type of every call expression and reports
the ones that return a union:

<!-- example: examples/rules/typescript-js/index.mjs -->

```js title="index.mjs"
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

export default {
  rules: {
    "call-returns-union": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {
          CallExpression(node) {
            const type = checker.getTypeAtLocation(
              services.esTreeNodeToTSNodeMap.get(node),
            );
            if (type.flags & ts.TypeFlags.Union)
              context.report({ node, message: "Call returns a union type" });
          },
        };
      },
    },
  },
};
```

Use it like any plugin in `eslint.config.mjs`:

```js
import example from "./index.mjs";
import ts from "typescript-eslint";

export default [
  {
    files: ["**/*.ts"],
    plugins: { "@typescript-eslint": ts.plugin, example },
    languageOptions: {
      parser: ts.parser,
      parserOptions: { projectService: true },
    },
    rules: { "example/call-returns-union": "error" },
  },
];
```

## A GraphQL rule

`.graphql` files are parsed by Apollo's parser and linted through the
graphql-eslint-compatible AST, so custom rules use `OperationDefinition` and
friends as selectors. This one enforces that named operations end with their
operation kind:

<!-- example: examples/rules/graphql-js/index.mjs -->

```js title="index.mjs"
export default {
  rules: {
    "operation-name-suffix": {
      meta: { type: "suggestion", schema: [] },
      create(context) {
        return {
          OperationDefinition(node) {
            if (node.operation === undefined) return;
            const name = node.name?.value;
            if (name === undefined) return;
            const suffix =
              node.operation[0].toUpperCase() + node.operation.slice(1);
            if (!name.endsWith(suffix))
              context.report({
                node,
                message: `"${name}" should end with "${suffix}"`,
              });
          },
        };
      },
    },
  },
};
```

```js
import graphql from "@graphql-eslint/eslint-plugin";
import example from "./index.mjs";

export default [
  {
    files: ["**/*.graphql"],
    plugins: { "@graphql-eslint": graphql, example },
    languageOptions: {
      parser: graphql.parser,
      parserOptions: { schemaSdl: "type Query { greeting: String }" },
    },
    rules: { "example/operation-name-suffix": "error" },
  },
];
```

Schema-aware rules from `@graphql-eslint` (which read
`parserServices.schema`) work the same way.

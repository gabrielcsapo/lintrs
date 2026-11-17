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

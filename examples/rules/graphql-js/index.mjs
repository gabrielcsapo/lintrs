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

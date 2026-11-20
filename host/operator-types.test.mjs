import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture, oracle, run } from "./test-support/fixture.mjs";

test("operator types preserve their operands and generic uses", async t => {
  const f = fixture(t, {
    typed: true,
    rules: { "@typescript-eslint/no-unnecessary-type-parameters": "error" },
    source: `export function uppercase<T extends string>(value: T) {
  return value.toUpperCase() as Uppercase<T>;
}
export function nested<T extends string>(value: T) {
  return value as Capitalize<Lowercase<Uncapitalize<T>>>;
}
export function key<T extends object>(value: T) {
  return Object.keys(value)[0] as keyof T;
}
export function unused<T extends string>(value: T) {
  return value.length;
}
`,
    extraConfig: `{plugins: {probe: {rules: {operands: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {FunctionDeclaration(node) {
          const declaration = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(declaration));
          context.report({node: node.id, message: JSON.stringify({
            name: node.id.name,
            operand: type.type && checker.typeToString(type.type),
            hasOperand: 'type' in type,
            hasTarget: type.target !== undefined,
          })});
        }};
      }
    }}}}, rules: {'probe/operands': 'warn'}}`,
  });
  const expected = await oracle(f);
  assert.equal(
    expected.messages.filter(message => message.severity === 2).length,
    1,
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

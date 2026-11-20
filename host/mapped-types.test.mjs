import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture, oracle, run } from "./test-support/fixture.mjs";

test("mapped type responses preserve lazy generic constraints", async t => {
  const f = fixture(t, {
    typed: true,
    rules: { "@typescript-eslint/no-unnecessary-type-parameters": "error" },
    source: `interface Box<T> { value: T }
declare function makeEnum<T extends string>(values: readonly T[]): Box<{ [K in T]: number }>;
export const enumeration = <T extends string>(values: readonly T[]) => makeEnum(values);
export function enumFunction<T extends string>(values: readonly T[]) {
  return makeEnum(values);
}
export function unused<T extends string>(value: T) {
  return value.length;
}
`,
    extraConfig: `{plugins: {probe: {rules: {mapped: {
      meta: {schema: []},
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        return {'ArrowFunctionExpression, FunctionDeclaration'(node) {
          const declaration = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(declaration));
          const mapped = type.typeArguments?.[0];
          if (!mapped) return;
          const properties = mapped.getProperties();
          context.report({node, message: JSON.stringify({
            properties: properties.length,
            template: mapped.templateType?.flags,
            constraint: mapped.constraintType?.flags,
            parameter: mapped.typeParameter?.flags,
          })});
        }};
      }
    }}}}, rules: {'probe/mapped': 'warn'}}`,
  });
  const expected = await oracle(f);
  assert.equal(
    expected.messages.filter(message => message.severity === 2).length,
    1,
  );
  assert.equal(
    expected.messages.filter(message => message.severity === 1).length,
    2,
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

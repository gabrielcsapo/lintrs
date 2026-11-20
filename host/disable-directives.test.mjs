import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture, run, oracle } from "./test-support/fixture.mjs";

test("rule directive APIs ignore line block toggles and oxlint directives as ESLint does", async t => {
  const f = fixture(t, {
    rules: { "no-debugger": "off" },
    source: `// eslint-disable no-debugger -- ignored line toggle
// eslint-enable no-debugger
/* oxlint-disable no-debugger */
// oxlint-disable-next-line no-debugger
/* eslint-disable no-debugger -- block toggle */
/* eslint-enable no-debugger */
// eslint-disable-next-line no-debugger -- next statement
debugger;
debugger; // eslint-disable-line no-debugger -- current line
export {};
`,
    extraConfig: `{linterOptions: {reportUnusedDisableDirectives: 'off'}, plugins: {inspect: {rules: {directives: {meta: {schema: []}, create(context) {
      const first = context.sourceCode.getDisableDirectives();
      if (context.sourceCode.getDisableDirectives() !== first) throw new Error('Directive results must be cached');
      for (const directive of first.directives) context.report({loc: directive.node.loc, message: JSON.stringify({type: directive.type, value: directive.value, justification: directive.justification})});
      return {};
    }}}}}, rules: {'inspect/directives': 'error'}}`,
  });
  const expected = await oracle(f);
  assert.equal(expected.messages.length, 4);
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

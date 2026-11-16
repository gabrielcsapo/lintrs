import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture, run, oracle } from "./test-support/fixture.mjs";

test("Apollo runs unchanged GraphQL rules with schema services, fixes, and directives", async t => {
  const f = fixture(t, {
    graphql: true,
    rules: {
      "@graphql-eslint/naming-convention": [
        "error",
        { types: "PascalCase", FieldDefinition: "camelCase" },
      ],
      "@graphql-eslint/known-type-names": "error",
      "@graphql-eslint/no-deprecated": "warn",
      "@graphql-eslint/alphabetize": [
        "warn",
        { fields: ["ObjectTypeDefinition"] },
      ],
      "@graphql-eslint/require-description": [
        "warn",
        { types: true, FieldDefinition: true },
      ],
    },
    source: `# eslint-disable-next-line @graphql-eslint/naming-convention -- compatibility
type bad_name {
  zebra: Missing
  Bad_field: String
  apple: String
}
`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

test("Apollo preserves operations, fragment type information, and UTF-16 locations", async t => {
  const f = fixture(t, {
    graphql: true,
    rules: {
      "@graphql-eslint/known-argument-names": "error",
      "@graphql-eslint/fields-on-correct-type": "error",
      "@graphql-eslint/no-anonymous-operations": "error",
      "@graphql-eslint/scalar-leafs": "error",
    },
    source: `# emoji 😀\n{ greeting(unexpected: "😀") { missing } unknown }\n`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
});

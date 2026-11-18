# Testing rules

`NativeRuleTester` (from `@lintrs/cli/native`) runs `RuleTester`-style cases through
the real lintrs binary, in a temporary project with a tsconfig and an
`eslint.config.mjs` that imports your plugin. Use it with `node:test`:

```js
import { NativeRuleTester } from "@lintrs/cli/native";
import { test } from "node:test";

const tester = new NativeRuleTester({
  // module specifier of a file default-exporting the nativePlugin() result
  plugin: new URL("./index.mjs", import.meta.url).href,
});

test("value-is-string", () => {
  tester.run("demo/value-is-string", {
    valid: [{ code: "const value = 1;" }],
    invalid: [
      {
        code: 'const value = "s";',
        filename: "case.ts",
        errors: [
          {
            message: "identifier 'value' has type string",
            line: 1,
            column: 7,
            endLine: 1,
            endColumn: 12,
          },
        ],
      },
    ],
  });
});
```

| Option        | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `plugin`      | Required. Module exporting the plugin.                                      |
| `binary`      | lintrs binary. Default: under `target/lintrs-native`                        |
| `env`         | Extra environment for the run.                                              |
| `nodeModules` | `node_modules` directory symlinked into the temp project. Default: lintrs's |

Case fields: `code`, `filename`, `options`; invalid cases add
`errors: { message, line, column, endLine, endColumn }` and `output` (source
after fixes).

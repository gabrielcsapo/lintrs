import assert from "node:assert/strict";
import { test } from "node:test";

import { formatUnix } from "./results.mjs";

const message = (overrides = {}) => ({
  ruleId: "no-debugger",
  severity: 2,
  message: "Unexpected 'debugger' statement.",
  line: 3,
  column: 7,
  ...overrides,
});

test("unix format matches ESLint's unix formatter", () => {
  assert.equal(formatUnix([]), "\n");
  assert.equal(
    formatUnix([{ filePath: "a.ts", messages: [message()] }]),
    "a.ts:3:7: Unexpected 'debugger' statement. [Error/no-debugger]\n\n1 problem\n",
  );
  assert.equal(
    formatUnix([
      {
        filePath: "a.ts",
        messages: [
          message({ severity: 1, ruleId: null, line: 0, column: 0 }),
          message({ message: "Second", line: 5, column: 1 }),
        ],
      },
    ]),
    "a.ts:0:0: Unexpected 'debugger' statement. [Warning]\na.ts:5:1: Second [Error/no-debugger]\n\n2 problems\n",
  );
});

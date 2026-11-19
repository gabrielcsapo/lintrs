import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectConfig,
  projectForFile,
  projectName,
} from "./type-services/project.mjs";

test("provided programs select the first containing program and reject excluded files", () => {
  const first = {
    getSourceFile: file => (file === "/first.ts" ? {} : undefined),
  };
  const second = { getSourceFile: () => ({}) };
  assert.equal(
    projectForFile("/first.ts", { programs: [first, second] }, "/"),
    first,
  );
  assert.equal(
    projectForFile("/other.ts", { programs: [first, second] }, "/"),
    second,
  );
  assert.throws(
    () => projectForFile("/other.ts", { programs: [first] }, "/"),
    /outside the provided TypeScript programs/u,
  );
  assert.throws(
    () => projectForFile("/first.ts", { programs: [] }, "/"),
    /outside the provided TypeScript programs/u,
  );
});

test("provided programs preserve runtime compiler overrides, roots, and references without serializing config ASTs", () => {
  const configFile = {};
  configFile.parent = configFile;
  const program = {
    getCompilerOptions: () => ({
      configFile,
      configFilePath: "/tsconfig.json",
      strictNullChecks: false,
      paths: { "@lib/*": ["./lib/*"] },
    }),
    getRootFileNames: () => ["/first.ts", "/ambient.d.ts"],
    getProjectReferences: () => [{ path: "/lib", prepend: false }],
  };
  const result = projectConfig(program);
  assert.deepEqual(result, {
    fileNames: ["/first.ts", "/ambient.d.ts"],
    options: {
      configFilePath: "/tsconfig.json",
      strictNullChecks: false,
      paths: { "@lib/*": ["./lib/*"] },
    },
    projectReferences: [{ path: "/lib", prepend: false }],
  });
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(projectName(program), "/tsconfig.json");
});

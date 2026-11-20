import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectConfig,
  projectForFile,
  projectName,
} from "./type-services/project.mjs";

test("native project metadata selects ordered explicit roots even with discovery disabled", () => {
  const first = {
    fileNames: ["/first.ts"],
    options: { configFilePath: "/first.json" },
  };
  const second = {
    fileNames: ["/first.ts", "/other.ts"],
    options: { configFilePath: "/second.json" },
  };
  const options = {
    lintrsProjects: [first, second],
    projectService: false,
    project: false,
  };
  assert.equal(projectForFile("/first.ts", options, "/"), first);
  assert.equal(projectForFile("/other.ts", options, "/"), second);
  assert.throws(
    () => projectForFile("/outside.ts", options, "/"),
    /outside the provided native projects/u,
  );
  assert.throws(
    () => projectForFile("/first.ts", { lintrsProjects: [] }, "/"),
    /outside the provided native projects/u,
  );
});

test("native project metadata preserves options and references without config ASTs", () => {
  const configFile = {};
  configFile.parent = configFile;
  const project = {
    fileNames: ["/first.ts", "/ambient.d.ts"],
    options: {
      configFile,
      configFilePath: "/tsconfig.json",
      strictNullChecks: false,
    },
    projectReferences: [{ path: "/lib" }],
  };
  assert.deepEqual(projectConfig(project), {
    fileNames: project.fileNames,
    options: { configFilePath: "/tsconfig.json", strictNullChecks: false },
    projectReferences: project.projectReferences,
  });
  assert.equal(projectName(project), "/tsconfig.json");
  assert.doesNotThrow(() => JSON.stringify(projectConfig(project)));
});

test("equivalent metadata shares a project across flat-config clones while overrides stay distinct", () => {
  const project = {
    fileNames: ["/first.ts", "/second.ts"],
    options: { configFilePath: "/tsconfig.json", strictNullChecks: false },
  };
  const cache = new Map();
  const first = projectForFile(
    "/first.ts",
    { lintrsProjects: [project] },
    "/",
    cache,
  );
  const clone = structuredClone(project);
  assert.equal(
    projectForFile("/second.ts", { lintrsProjects: [clone] }, "/", cache),
    first,
  );
  clone.options.strictNullChecks = true;
  const changed = structuredClone(clone);
  assert.notEqual(
    projectForFile("/second.ts", { lintrsProjects: [changed] }, "/", cache),
    first,
  );
});

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

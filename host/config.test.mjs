import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { fixture } from "./test-support/fixture.mjs";
import { projectConfig, projectForFile } from "./type-services/project.mjs";

test("native metadata keeps stable project identities without changing roots, overrides or input configs", async t => {
  const f = fixture(t, { rules: {}, source: "export {};\n" });
  const other = join(f.dir, "other.ts");
  writeFileSync(
    f.config,
    `export const project = Object.freeze({fileNames: ${JSON.stringify([f.file, other])}, options: {configFilePath: ${JSON.stringify(join(f.dir, "tsconfig.json"))}, strictNullChecks: false}, projectReferences: [{path: '/dependency'}]});
const parserOptions = Object.freeze({lintrsProjects: Object.freeze([project]), project: false, projectService: false});
export default [Object.freeze({name: 'first', files: ['sample.ts'], languageOptions: {parserOptions}}), {name: 'other', files: ['other.ts'], languageOptions: {parserOptions}}, {name: 'override', files: ['other.ts'], languageOptions: {parserOptions: {lintrsProjects: [{...project, options: {...project.options, strictNullChecks: true}}]}}}];
`,
  );
  const original = await import(pathToFileURL(f.config).href);
  const { configs } = await loadConfig(f.config);
  const firstOptions = configs.getConfig(f.file).languageOptions.parserOptions;
  const otherOptions = configs.getConfig(other).languageOptions.parserOptions;
  const first = firstOptions.lintrsProjects[0];
  const shared = configs.find(entry => entry.name === "other").languageOptions
    .parserOptions.lintrsProjects[0];
  assert.equal(first, shared);
  assert.notEqual(first, original.project);
  assert.notEqual(Object.getPrototypeOf(first), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), original.project);
  assert.equal(
    original.default[0].languageOptions.parserOptions.lintrsProjects[0],
    original.project,
  );
  assert.equal(Object.getPrototypeOf(original.project), Object.prototype);
  assert.equal(projectForFile(f.file, firstOptions, f.dir), first);
  assert.equal(firstOptions.project, false);
  assert.equal(firstOptions.projectService, false);
  assert.equal(projectConfig(first).options.strictNullChecks, false);
  assert.equal(
    projectConfig(projectForFile(other, otherOptions, f.dir)).options
      .strictNullChecks,
    true,
  );
  assert.deepEqual(projectConfig(first).projectReferences, [
    { path: "/dependency" },
  ]);
});

test("configuration entries without native metadata retain their identity", async t => {
  const f = fixture(t, { rules: {}, source: "export {};\n" });
  writeFileSync(
    f.config,
    `export default [{name: 'plain', files: ['**/*.ts'], languageOptions: {parserOptions: {projectService: false}}}];\n`,
  );
  const original = await import(pathToFileURL(f.config).href);
  const loaded = await loadConfig(f.config);
  assert.equal(
    loaded.configs.find(entry => entry.name === "plain"),
    original.default[0],
  );
  assert.equal(
    loaded.configs.getConfig(f.file).languageOptions.parserOptions
      .lintrsProjects,
    undefined,
  );
});

import { existsSync, globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function projectForFile(file, options, root) {
  if (options.programs !== undefined)
    throw new Error(
      `Prebuilt JavaScript TypeScript programs are unsupported: ${file}`,
    );
  if (options.projectService || options.project === true) {
    let directory = dirname(file);
    for (;;) {
      const path = join(directory, "tsconfig.json");
      if (existsSync(path)) return path;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error(`No tsconfig.json found for ${file}`);
  }
  if (options.project) {
    const patterns = Array.isArray(options.project)
      ? options.project
      : [options.project];
    const projects = globSync(patterns, {
      cwd: options.tsconfigRootDir ?? root,
    });
    if (projects.length !== 1)
      throw new Error(
        `Expected one TypeScript project for ${file}, found ${projects.length}`,
      );
    return resolve(options.tsconfigRootDir ?? root, projects[0]);
  }
  return undefined;
}

import { existsSync, globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function projectForFile(file, options, root) {
  if (options.programs !== undefined) {
    for (const program of options.programs) {
      if (program.getSourceFile(file) !== undefined) return program;
    }
    throw new Error(
      `File is outside the provided TypeScript programs: ${file}`,
    );
  }
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

export function projectName(project) {
  return typeof project === "string"
    ? project
    : (project.getCompilerOptions().configFilePath ?? "<provided program>");
}

export function projectConfig(project, api) {
  if (typeof project !== "string") {
    const { configFile, ...options } = project.getCompilerOptions();
    return {
      fileNames: project.getRootFileNames(),
      options,
      projectReferences: project.getProjectReferences(),
    };
  }
  const config = api.readConfigFile(project);
  if (config.error !== undefined)
    throw new Error(`Cannot read ${project}: ${JSON.stringify(config.error)}`);
  const parsed = api.parseJsonConfigFileContent(config.config, {
    configFileName: project,
  });
  if (parsed.errors.length > 0)
    throw new Error(
      `Cannot parse ${project}: ${JSON.stringify(parsed.errors)}`,
    );
  return parsed;
}

import { existsSync, globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const metadataKeys = new WeakMap();

export function projectForFile(file, options, root, nativeProjects) {
  if (options.lintrsProjects !== undefined) {
    for (const project of options.lintrsProjects) {
      if (!project.fileNames.includes(file)) continue;
      if (nativeProjects === undefined) return project;
      if (!metadataKeys.has(project))
        metadataKeys.set(project, JSON.stringify(projectConfig(project)));
      const key = metadataKeys.get(project);
      if (!nativeProjects.has(key)) nativeProjects.set(key, project);
      return nativeProjects.get(key);
    }
    throw new Error(`File is outside the provided native projects: ${file}`);
  }
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
    : (("fileNames" in project ? project.options : project.getCompilerOptions())
        .configFilePath ?? "<provided program>");
}

export function projectConfig(project, api) {
  if (typeof project !== "string") {
    const metadata = "fileNames" in project;
    const { configFile, ...options } = metadata
      ? project.options
      : project.getCompilerOptions();
    return {
      fileNames: metadata ? project.fileNames : project.getRootFileNames(),
      options,
      projectReferences: metadata
        ? project.projectReferences
        : project.getProjectReferences(),
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

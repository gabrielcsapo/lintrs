import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint"));
const { FlatConfigArray } = eslintRequire("./config/flat-config-array.js");

export async function createDiscoveryFilter(configs, basePath) {
  const globals = configs.filter(
    config =>
      config.ignores !== undefined &&
      Object.keys(config).every(key =>
        ["name", "basePath", "ignores"].includes(key),
      ),
  );
  const patterns = new Map();
  const isStringPattern = pattern =>
    typeof pattern === "string" ||
    (Array.isArray(pattern) && pattern.every(part => typeof part === "string"));
  for (const config of configs) {
    if (
      config.files === undefined ||
      config.ignores !== undefined ||
      !config.files.every(isStringPattern)
    )
      continue;
    const entry = {
      files: config.files,
      ...(config.basePath === undefined ? {} : { basePath: config.basePath }),
    };
    patterns.set(JSON.stringify(entry), entry);
  }
  const membership = new FlatConfigArray([...globals, ...patterns.values()], {
    basePath,
  });
  await membership.normalize();
  const stats = {
    matched: 0,
    ignored: 0,
    fallback: 0,
    configEntries: membership.length,
  };
  return {
    stats,
    isDirectoryIgnored: directory => membership.isDirectoryIgnored(directory),
    isPathIgnored(file) {
      const status = membership.getConfigStatus(file);
      if (status === "matched") {
        // An unconditional files match proves membership without resolving rules.
        stats.matched++;
        return false;
      }
      if (status === "ignored" || status === "external") {
        stats.ignored++;
        return true;
      }
      stats.fallback++;
      return configs.getConfig(file) === undefined;
    },
  };
}

export function discoverFiles(workspace, filter) {
  const files = [];
  const walk = directory => {
    if (filter.isDirectoryIgnored(directory)) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") walk(file);
      } else if (
        /\.(?:ts|mts|tsx|graphql)$/u.test(entry.name) &&
        !filter.isPathIgnored(file)
      ) {
        files.push(file);
      }
    }
  };
  walk(workspace);
  return files;
}

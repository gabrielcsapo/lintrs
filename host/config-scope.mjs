import { resolve, sep } from "node:path";

// Reject impossible prefixes and simple glob segments. These are conservative
// checks: ESLint still performs actual matching, ignores, merging and validation.
export async function scopeConfig(loadedConfig, files) {
  if (sep !== "/") return loadedConfig;
  const paths = [...files].sort();
  const prefixes = new Map();
  const segments = paths.map(path => path.split("/"));
  const segmentResults = new Map();
  const possibleSegments = pattern => {
    if (/[{}[\](!+@|)]/u.test(pattern)) return true;
    if (segmentResults.has(pattern)) return segmentResults.get(pattern);
    const parts = pattern.split("/");
    if (parts.some(part => part === "." || part === "..")) return true;
    // Match code units like minimatch; a Unicode-mode '?' would reject astral filenames.
    const required = parts
      .filter(part => part !== "" && !/^\*+$/u.test(part))
      .map(
        part =>
          new RegExp(
            `^${part
              .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
              .replaceAll("\\*", ".*")
              .replaceAll("\\?", ".")}$`,
            "s",
          ),
      );
    const found = segments.some(path => {
      let index = 0;
      for (const segment of path) if (required[index]?.test(segment)) index++;
      return index === required.length;
    });
    segmentResults.set(pattern, found);
    return found;
  };
  const possible = (pattern, basePath) => {
    if (Array.isArray(pattern))
      return (
        pattern.some(part => typeof part !== "string") ||
        pattern.every(part => possible(part, basePath))
      );
    if (typeof pattern !== "string" || pattern.includes("\\")) return true;
    let prefix = "";
    for (const character of pattern) {
      if ("*?{[(!+@".includes(character)) break;
      prefix += character;
    }
    if (prefix.length === 0) return possibleSegments(pattern);
    const absolute = resolve(basePath, prefix);
    if (!prefixes.has(absolute)) {
      let lo = 0,
        hi = paths.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (paths[mid] < absolute) lo = mid + 1;
        else hi = mid;
      }
      prefixes.set(absolute, paths[lo]?.startsWith(absolute) ?? false);
    }
    return prefixes.get(absolute) && possibleSegments(pattern);
  };
  let changed = false;
  const entries = loadedConfig.configs.flatMap(config => {
    const basePath =
      config.basePath === undefined
        ? loadedConfig.root
        : resolve(loadedConfig.root, config.basePath);
    const patterns = config.files?.filter(pattern =>
      possible(pattern, basePath),
    );
    const ignores = config.ignores?.filter(pattern =>
      possible(pattern, basePath),
    );
    if (
      patterns?.length === config.files?.length &&
      ignores?.length === config.ignores?.length
    )
      return [config];
    changed = true;
    return patterns?.length === 0
      ? []
      : [
          {
            ...config,
            ...(patterns ? { files: patterns } : {}),
            ...(ignores ? { ignores } : {}),
          },
        ];
  });
  if (!changed) return loadedConfig;
  const configs = new loadedConfig.configs.constructor(entries, {
    basePath: loadedConfig.root,
    baseConfig: [],
  });
  await configs.normalize();
  return { ...loadedConfig, configs };
}

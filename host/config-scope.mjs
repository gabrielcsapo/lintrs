import { resolve, sep } from "node:path";

// Only reject literal prefixes that cannot contain any candidate file. ESLint
// still performs every actual glob match, ignore check, merge and validation.
export async function scopeConfig(loadedConfig, files) {
  if (sep !== "/") return loadedConfig;
  const paths = [...files].sort();
  const prefixes = new Map();
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
    if (prefix.length === 0) return true;
    const absolute = resolve(basePath, prefix);
    if (prefixes.has(absolute)) return prefixes.get(absolute);
    let lo = 0,
      hi = paths.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (paths[mid] < absolute) lo = mid + 1;
      else hi = mid;
    }
    const found = paths[lo]?.startsWith(absolute) ?? false;
    prefixes.set(absolute, found);
    return found;
  };
  let changed = false;
  const entries = loadedConfig.configs.flatMap(config => {
    if (config.files === undefined) return [config];
    const patterns = config.files.filter(pattern =>
      possible(
        pattern,
        config.basePath === undefined
          ? loadedConfig.root
          : resolve(loadedConfig.root, config.basePath),
      ),
    );
    if (patterns.length === config.files.length) return [config];
    changed = true;
    return patterns.length === 0 ? [] : [{ ...config, files: patterns }];
  });
  if (!changed) return loadedConfig;
  const configs = new loadedConfig.configs.constructor(entries, {
    basePath: loadedConfig.root,
    baseConfig: [],
  });
  await configs.normalize();
  return { ...loadedConfig, configs };
}

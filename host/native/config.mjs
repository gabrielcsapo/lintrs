import { createNativeLibraryResolver } from "./resolve.mjs";

export function createNativeRulePreparer(
  nativeRules,
  { quiet = false, resolveLibrary = createNativeLibraryResolver() } = {},
) {
  const configurations = new WeakMap();
  const libraries = new Map();
  const preparedOptions = new Map();
  return config => {
    if (configurations.has(config)) return configurations.get(config);
    const specs = [];
    const requiredLibraries = new Set();
    for (const [ruleId, setting] of Object.entries(config.rules ?? {})) {
      const rule = nativeRules.get(ruleId);
      if (rule === undefined) continue;
      const severity = setting[0] ?? 0;
      if (severity === 0 || (quiet && severity === 1)) continue;
      if (!libraries.has(rule.meta.lintrs))
        libraries.set(rule.meta.lintrs, resolveLibrary(rule.meta.lintrs));
      const library = libraries.get(rule.meta.lintrs);
      requiredLibraries.add(library);
      const options = setting.slice(1);
      const normalized = options.length === 1 ? options[0] : options;
      let prepared = normalized;
      if (rule.meta.lintrs.prepareOptions !== undefined) {
        let variants = preparedOptions.get(rule);
        if (variants === undefined) {
          variants = new Map();
          preparedOptions.set(rule, variants);
        }
        const key = JSON.stringify(normalized);
        if (!variants.has(key))
          variants.set(key, rule.meta.lintrs.prepareOptions(normalized));
        prepared = variants.get(key);
      }
      specs.push({
        name: rule.meta.lintrs.rule,
        library,
        id: ruleId,
        severity,
        options: prepared,
      });
    }
    const result = { specs, libraries: [...requiredLibraries] };
    configurations.set(config, result);
    return result;
  };
}

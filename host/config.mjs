import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Identity-based config hashes must not expand every project root into each
// import resolver cache key. Keep the metadata readable and JSON-serializable.
class NativeProject {
  constructor(project) {
    Object.assign(this, project);
  }
}

function compactProjects(config, projects) {
  if (Array.isArray(config))
    return config.map(entry => compactProjects(entry, projects));
  const options = config?.languageOptions?.parserOptions;
  if (!Array.isArray(options?.lintrsProjects)) return config;
  return {
    ...config,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...options,
        lintrsProjects: options.lintrsProjects.map(project => {
          if (!projects.has(project))
            projects.set(project, new NativeProject(project));
          return projects.get(project);
        }),
      },
    },
  };
}

export async function loadConfig(
  path,
  exportName = process.env.LINTRS_CONFIG_EXPORT ?? "default",
) {
  const entry = resolve(path);
  if (!/\.[cm]?js$/.test(entry)) {
    throw new Error(
      `The compatibility host requires a flat-config module: ${entry}`,
    );
  }
  const require = createRequire(entry);
  const eslintRequire = createRequire(require.resolve("eslint"));
  const { FlatConfigArray } = eslintRequire("./config/flat-config-array.js");
  const { builtinRules } = require("eslint/use-at-your-own-risk");
  const imported = (await import(pathToFileURL(entry).href))[exportName];
  if (imported === undefined)
    throw new Error(`Configuration ${entry} has no export ${exportName}`);
  const configs = new FlatConfigArray(
    compactProjects(
      typeof imported === "function" ? await imported() : imported,
      new WeakMap(),
    ),
    { basePath: dirname(entry) },
  );
  await configs.normalize();
  const plugins = new Map();
  const ruleIds = new Set();
  for (const config of configs) {
    for (const [name, plugin] of Object.entries(config.plugins ?? {})) {
      if (name === "@") continue;
      if (plugins.has(name) && plugins.get(name) !== plugin) {
        throw new Error(
          `Multiple implementations of plugin ${name} require separate host registrations`,
        );
      }
      plugins.set(name, plugin);
    }
    for (const [id, setting] of Object.entries(config.rules ?? {})) {
      const level = Array.isArray(setting) ? setting[0] : setting;
      if (level !== 0 && level !== "off") ruleIds.add(id);
    }
  }
  const rules = new Map();
  const knownRules = new Set(builtinRules.keys());
  for (const [namespace, plugin] of plugins) {
    for (const name of Object.keys(plugin.rules ?? {}))
      knownRules.add(`${namespace}/${name}`);
  }
  for (const id of [...ruleIds].sort()) {
    const slash = id.lastIndexOf("/");
    const rule =
      slash === -1
        ? builtinRules.get(id)
        : plugins.get(id.slice(0, slash))?.rules?.[id.slice(slash + 1)];
    if (rule === undefined)
      throw new Error(`Rule ${id} has no registered implementation`);
    if (typeof rule.create !== "function") {
      throw new Error(
        `Rule ${id} does not implement the ESLint create(context) API`,
      );
    }
    rules.set(id, rule);
  }
  return { configs, rules, knownRules: [...knownRules], root: dirname(entry) };
}

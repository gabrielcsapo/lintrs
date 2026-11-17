import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { resolveNativeLibrary } from "./native/resolve.mjs";
import { createGraphQLHost } from "./graphql.mjs";
import { inlineConfigs } from "./inline-config.mjs";
import { profiler } from "./profile.mjs";
import { createTypeServices } from "./type-services.mjs";

const require = createRequire(import.meta.url);
const registrations = new Map();
const ruleIdentities = new WeakMap();
let nextRuleIdentity = 0;
let activeRules;

export class HostWorkerRecycleRequired extends Error {}

function registrationFor(rules) {
  return JSON.stringify(
    [...rules].map(([id, rule]) => {
      if (!ruleIdentities.has(rule))
        ruleIdentities.set(rule, nextRuleIdentity++);
      return [id, ruleIdentities.get(rule)];
    }),
  );
}

function dispatcherFor(name, meta) {
  return {
    meta,
    create(context) {
      const implementation = activeRules?.[name];
      if (implementation === undefined)
        throw new Error(`No active rule for ${name}`);
      return implementation.create(context);
    },
  };
}

function mergeFixes(fixes, text) {
  if (fixes === null || fixes === undefined || fixes.length === 0)
    return undefined;
  const sorted = [...fixes].sort((a, b) => a.start - b.start || a.end - b.end);
  const start = sorted[0].start;
  let end = start;
  let replacement = "";
  for (const fix of sorted) {
    if (fix.start < end) throw new Error("Rule returned overlapping fixes");
    replacement += text.slice(end, fix.start) + fix.text;
    end = fix.end;
  }
  return { range: [start, end], text: replacement };
}

function collectSuggestionData(descriptor, data) {
  if (descriptor.suggest === undefined || descriptor.suggest === null)
    return descriptor;
  return {
    ...descriptor,
    suggest: descriptor.suggest.map(suggestion => {
      if (typeof suggestion.fix !== "function") return suggestion;
      return {
        ...suggestion,
        fix(fixer) {
          const value = suggestion.fix.call(suggestion, fixer);
          if (!value) return value;
          if (Symbol.iterator in value) {
            const fixes = [...value];
            if (fixes.some(Boolean)) data.push(suggestion.data);
            return fixes;
          }
          data.push(suggestion.data);
          return value;
        },
      };
    }),
  };
}

function positions(text) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)) {
    starts.push(match.index + match[0].length);
  }
  return offset => {
    let lo = 0;
    let hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

function deprecatedRules(config, rules) {
  return Object.entries(config.rules ?? {}).flatMap(([ruleId, setting]) => {
    const meta = rules.get(ruleId)?.meta;
    if (setting[0] === 0 || !meta?.deprecated) return [];
    if (typeof meta.deprecated !== "object")
      return [{ ruleId, replacedBy: meta.replacedBy ?? [] }];
    return [
      {
        ruleId,
        replacedBy: (meta.deprecated.replacedBy ?? []).map(replacement => {
          const plugin = replacement.plugin?.name;
          const prefix =
            plugin === undefined
              ? ""
              : `${plugin.replace(/(^|\/)eslint-plugin-?/u, "$1")}/`;
          return `${prefix}${replacement.rule?.name ?? ""}`;
        }),
        info: meta.deprecated,
      },
    ];
  });
}

function normalizeVisitorFields(sourceCode) {
  const visit = node => {
    if (node.type === "TSEnumDeclaration" && node.members === undefined)
      Object.defineProperty(node, "members", { value: node.body.members });
    for (const key of sourceCode.visitorKeys[node.type] ?? []) {
      const child = node[key];
      // Oxlint's code-path traverser requires absent children to be null.
      if (child === undefined)
        Object.defineProperty(node, key, { value: null });
      else if (Array.isArray(child)) {
        for (const item of child) if (item != null) visit(item);
      } else if (child !== null) visit(child);
    }
  };
  visit(sourceCode.ast);
}

export function selectFiles(paths, configs) {
  const files = new Set();
  const visit = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error(`Symlink discovery is not implemented: ${path}`);
    if (stat.isDirectory()) {
      if (configs.isDirectoryIgnored(path)) return;
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (
      /\.(?:[cm]?[jt]sx?|graphql)$/u.test(path) &&
      configs.getConfig(path) !== undefined
    ) {
      files.add(path);
    }
  };
  for (const path of paths) visit(resolve(path));
  if (files.size === 0) throw new Error("No configured files selected");
  return [...files].sort();
}

export async function runHost({ configPath, paths, quiet = false, services }) {
  const version = require("oxlint/package.json").version;
  if (version !== "1.83.0") {
    throw new Error(
      `The compatibility adapter supports Oxlint 1.83.0; found ${version}`,
    );
  }
  const profile = profiler();
  const {
    configs: baseConfigs,
    rules,
    knownRules,
    root,
  } = await loadConfig(configPath);
  let configs = baseConfigs;
  const files = selectFiles(paths, configs);
  const overrides = inlineConfigs(files, configs, rules);
  if (overrides.size > 0)
    configs = {
      getConfig: file => overrides.get(file) ?? baseConfigs.getConfig(file),
    };
  const skippedRulesFor = config =>
    quiet
      ? Object.entries(config.rules ?? {})
          .filter(([, setting]) => setting[0] === 1)
          .map(([id]) => id)
      : [];
  const scriptFiles = files.filter(file => !file.endsWith(".graphql"));
  const graphqlFiles = files.filter(file => file.endsWith(".graphql"));
  const registrationId = registrationFor(rules);
  const directory = mkdtempSync(join(tmpdir(), "lintrs-host-"));
  const configFile = join(directory, "oxlint.json");
  const output = [];
  const failures = [];
  let current;
  const ruleNames = new Map();
  const registeredIds = new Map();
  const wrappedRules = {};
  const nativeRules = new Map();
  const nativeLibraries = new Map();
  for (const [index, [id, rule]] of [...rules].entries()) {
    if (rule.meta?.lintrs?.native === true) {
      nativeRules.set(id, rule);
      continue;
    }
    const name = `r${index}`;
    ruleNames.set(name, id);
    wrappedRules[name] = {
      meta: rule.meta,
      create(context) {
        const setting = current.config.rules?.[id];
        const severity = setting?.[0] ?? 0;
        if (severity === 0 || (quiet && severity === 1)) return {};
        if (!current.normalized) {
          normalizeVisitorFields(context.sourceCode);
          current.normalized = true;
        }
        const sourceCode = (current.sourceCode ??=
          services === undefined
            ? context.sourceCode
            : Object.create(context.sourceCode, {
                parserServices: {
                  value: (current.services ??= profile
                    ? profile.phase("Type services setup", () =>
                        services(
                          current.filePath,
                          context.sourceCode,
                          current.config,
                        ),
                      )
                    : services(
                        current.filePath,
                        context.sourceCode,
                        current.config,
                      )),
                },
              }));
        const adapted = Object.create(context, {
          id: { value: id },
          options: { value: setting.slice(1) },
          settings: { value: current.config.settings ?? {} },
          languageOptions: { value: current.config.languageOptions },
          parserOptions: {
            value: current.config.languageOptions.parserOptions ?? {},
          },
          sourceCode: { value: sourceCode },
          getSourceCode: { value: () => sourceCode },
          cwd: { value: root },
          getCwd: { value: () => root },
          report: {
            value: (descriptor, ...args) => {
              const suggestionData = [];
              context.report(
                collectSuggestionData(descriptor, suggestionData),
                ...args,
              );
              current.reports.push({
                id,
                severity,
                nodeType: descriptor.node?.type ?? descriptor.type ?? null,
                suggestionData,
              });
            },
          },
        });
        // Listeners run inside the access-plan scope (adaptive facts) and/or
        // a profiler rule frame (TIMING); without either, they run as is.
        const withRule = services?.withRule;
        const within =
          profile === undefined
            ? withRule === undefined
              ? undefined
              : fn => withRule(id, fn)
            : withRule === undefined
              ? fn => profile.rule(id, fn)
              : fn => profile.rule(id, () => withRule(id, fn));
        if (within === undefined) return rule.create(adapted);
        const listeners = within(() => rule.create(adapted));
        return Object.fromEntries(
          Object.entries(listeners).map(([selector, listener]) => [
            selector,
            function (...args) {
              return within(() => listener.apply(this, args));
            },
          ]),
        );
      },
    };
  }
  const pluginName =
    registrations.get(registrationId)?.name ??
    `lintrs_rules_${registrations.size}`;
  writeFileSync(
    configFile,
    JSON.stringify({
      plugins: [],
      categories: { correctness: "off" },
      jsPlugins: [{ name: pluginName, specifier: import.meta.filename }],
      rules: Object.fromEntries(
        [...ruleNames.keys()].map(name => [`${pluginName}/${name}`, "error"]),
      ),
    }),
  );
  const nativeSpecsFor = config => {
    const specs = [];
    const libraries = new Set();
    for (const [ruleId, setting] of Object.entries(config.rules ?? {})) {
      const rule = nativeRules.get(ruleId);
      if (rule === undefined) continue;
      const severity = setting[0] ?? 0;
      if (severity === 0 || (quiet && severity === 1)) continue;
      if (!nativeLibraries.has(rule.meta.lintrs))
        nativeLibraries.set(
          rule.meta.lintrs,
          resolveNativeLibrary(rule.meta.lintrs),
        );
      libraries.add(nativeLibraries.get(rule.meta.lintrs));
      specs.push({
        name: rule.meta.lintrs.rule,
        id: ruleId,
        severity,
        options: setting.slice(1),
      });
    }
    return { specs, libraries: [...libraries] };
  };
  const nativeMessagesFor = (filePath, config, position, jsSkipped) => {
    const { specs, libraries } = nativeSpecsFor(config);
    if (specs.length === 0) return [];
    if (services?.runNative === undefined)
      throw new Error(
        `Native rules are enabled for ${filePath} but no type-service ` +
          "session can run them (the in-process binding is required)",
      );
    const runNative = () =>
      services.runNative(filePath, {
        libraries,
        rules: specs.map(({ name, id, options }) => ({
          name,
          id,
          options: options.length === 1 ? options[0] : options,
        })),
        jsSkipped,
      });
    const diagnostics = profile
      ? profile.phase("Native rules (Rust)", runNative)
      : runNative();
    return (diagnostics ?? []).map(diagnostic => {
      const spec = specs.find(item => item.id === diagnostic.ruleId);
      const start = position(diagnostic.pos);
      const end = position(diagnostic.end);
      return {
        ruleId: diagnostic.ruleId,
        severity: spec?.severity ?? 2,
        message: diagnostic.message,
        line: start.line,
        column: start.column,
        nodeType: null,
        ...(diagnostic.end === diagnostic.pos
          ? {}
          : { endLine: end.line, endColumn: end.column }),
        ...(diagnostic.fix === undefined || diagnostic.fix === null
          ? {}
          : {
              fix: {
                range: [diagnostic.fix.pos, diagnostic.fix.end],
                text: diagnostic.fix.text,
              },
            }),
        ...((diagnostic.suggestions ?? []).length === 0
          ? {}
          : {
              suggestions: diagnostic.suggestions.map(suggestion => ({
                desc: suggestion.desc,
                fix: {
                  range: [suggestion.fix.pos, suggestion.fix.end],
                  text: suggestion.fix.text,
                },
              })),
            }),
      };
    });
  };
  const hasEnabledJsRules = config =>
    Object.entries(config.rules ?? {}).some(([ruleId, setting]) => {
      if (nativeRules.has(ruleId)) return false;
      const severity = setting[0] ?? 0;
      return severity > 0 && (!quiet || severity === 2);
    });
  // Files whose enabled rules are all native skip the oxlint runtime
  // entirely; they are linted through the native session after it.
  const jsFiles = scriptFiles.filter(file =>
    hasEnabledJsRules(configs.getConfig(file)),
  );
  const nativeOnlyFiles = scriptFiles.filter(
    file => !hasEnabledJsRules(configs.getConfig(file)),
  );
  // Resolve every native rule library now, building local crates, before
  // oxlint allocates its raw-transfer buffers: a build forks cargo, which
  // Linux refuses (ENOMEM) once the host holds those buffers. Resolution is
  // cached, so the per-file lookups during linting reuse these results.
  if (nativeRules.size > 0)
    for (const file of scriptFiles) nativeSpecsFor(configs.getConfig(file));

  if (
    jsFiles.length > 0 &&
    registrations.size > 0 &&
    !registrations.has(registrationId)
  )
    throw new HostWorkerRecycleRequired(
      "A different rule registry requires a fresh worker",
    );
  services ??= await createTypeServices({ configs, files: scriptFiles, root });
  const oxlintRoot = dirname(require.resolve("oxlint/package.json"));
  const bindings = await import(
    pathToFileURL(join(oxlintRoot, "dist/bindings.js")).href
  );
  const host = await import(
    pathToFileURL(join(oxlintRoot, "dist/lint.js")).href
  );
  const workspaces = await import(
    pathToFileURL(join(oxlintRoot, "dist/workspace.js")).href
  );
  const loadPlugin = async (_url, _name, _alias, workspace) => {
    try {
      let registered = registrations.get(registrationId);
      if (registered === undefined) {
        const dispatchers = Object.fromEntries(
          Object.entries(wrappedRules).map(([name, rule]) => [
            name,
            dispatcherFor(name, rule.meta),
          ]),
        );
        registered = host.o(
          { rules: dispatchers },
          pluginName,
          true,
          workspace,
        );
        registrations.set(registrationId, registered);
      }
      for (const [index, name] of registered.ruleNames.entries())
        registeredIds.set(registered.offset + index, ruleNames.get(name));
      return JSON.stringify({ Success: registered });
    } catch (error) {
      failures.push(error);
      return JSON.stringify({ Failure: String(error) });
    }
  };
  const lintFile = (
    filePath,
    bufferId,
    buffer,
    ids,
    options,
    settings,
    globals,
    workspace,
  ) => {
    if (failures.length > 0)
      return JSON.stringify({ Failure: "Compatibility host already failed" });
    const config = configs.getConfig(filePath);
    if (config === undefined) return null;
    if (config.processor !== undefined) {
      const message = `Processors are not implemented by the compatibility host: ${filePath}`;
      failures.push(new Error(message));
      return JSON.stringify({ Failure: message });
    }
    current = { config, filePath, reports: [] };
    const order = new Map(
      Object.keys(config.rules ?? {}).map((id, index) => [id, index]),
    );
    const ordered = [...ids]
      .map((id, index) => ({
        id,
        options: options[index],
        original: registeredIds.get(id),
      }))
      .filter(rule => {
        const severity = config.rules?.[rule.original]?.[0] ?? 0;
        return severity > 0 && (!quiet || severity === 2);
      })
      .sort((a, b) => order.get(a.original) - order.get(b.original));
    const result = host.n(
      filePath,
      bufferId,
      buffer,
      ordered.map(rule => rule.id),
      ordered.map(rule => rule.options),
      JSON.stringify(config.settings ?? {}),
      JSON.stringify(config.languageOptions.globals ?? {}),
      workspace,
    );
    if (result !== null) {
      const response = JSON.parse(result);
      if (response.Failure !== undefined)
        failures.push(new Error(`${filePath}: ${response.Failure}`));
      else {
        const diagnostics = response.Success;
        if (diagnostics.length !== current.reports.length) {
          throw new Error(`Diagnostic count mismatch for ${filePath}`);
        }
        current.diagnostics = diagnostics;
      }
    }
    const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    const position = positions(text);
    const nativeMessages = nativeMessagesFor(filePath, config, position, false);
    const messages = (current.diagnostics ?? []).map((diagnostic, index) => {
      const report = current.reports[index];
      const start = position(diagnostic.start);
      const end = position(diagnostic.end);
      const fix = mergeFixes(diagnostic.fixes, text);
      const suggestions = (diagnostic.suggestions ?? []).map(
        (suggestion, index) => ({
          ...(suggestion.messageId === null
            ? {}
            : { messageId: suggestion.messageId }),
          desc: suggestion.message,
          ...(report.suggestionData[index] === undefined
            ? {}
            : { data: report.suggestionData[index] }),
          fix: mergeFixes(suggestion.fixes, text),
        }),
      );
      return {
        ruleId: report.id,
        severity: report.severity,
        message: diagnostic.message,
        line: start.line,
        column: start.column,
        nodeType: report.nodeType,
        ...(diagnostic.messageId === null
          ? {}
          : { messageId: diagnostic.messageId }),
        ...(diagnostic.end === diagnostic.start
          ? {}
          : { endLine: end.line, endColumn: end.column }),
        ...(fix === undefined ? {} : { fix }),
        suggestions,
      };
    });
    messages.push(...nativeMessages);
    messages.sort((a, b) => a.line - b.line || a.column - b.column);
    output.push({
      filePath,
      text,
      messages,
      usedDeprecatedRules: deprecatedRules(config, rules),
      noInlineConfig: config.linterOptions?.noInlineConfig === true,
      reportUnusedDisableDirectives:
        config.linterOptions?.reportUnusedDisableDirectives ?? 1,
      reportUnusedInlineConfigs:
        config.linterOptions?.reportUnusedInlineConfigs ?? 0,
      skippedRules: skippedRulesFor(config),
    });
    services?.finish?.(filePath);
    current = undefined;
    return result !== null && JSON.parse(result).Failure !== undefined
      ? result
      : null;
  };
  const parserThreads = process.env.LINTRS_OXLINT_THREADS;
  if (
    parserThreads !== undefined &&
    (!Number.isSafeInteger(Number(parserThreads)) || Number(parserThreads) < 1)
  )
    throw new Error("LINTRS_OXLINT_THREADS must be a positive integer");
  const args = [
    ...(parserThreads === undefined ? [] : ["--threads", parserThreads]),
    "-c",
    configFile,
    "--silent",
    // stdout carries lintrs' results, so oxlint must print nothing. --silent
    // only drops diagnostics: oxlint's default and GitHub formats still print
    // "Found … / Finished in …", and it picks its format from the
    // environment (agent, GITHUB_ACTIONS, else default). The unix format
    // prints neither a summary nor, with --silent, a problem count.
    "--format",
    "unix",
    "--disable-nested-config",
    "--no-ignore",
    ...jsFiles,
  ];
  let success;
  if (activeRules !== undefined)
    throw new Error("Concurrent host runs require separate workers");
  activeRules = wrappedRules;
  try {
    success =
      jsFiles.length === 0 ||
      (await bindings.r(
        args,
        loadPlugin,
        options => {
          host.u(options);
          return null;
        },
        lintFile,
        async workspace => workspaces.createWorkspace(workspace),
        workspace => workspaces.destroyWorkspace(workspace),
        () => undefined,
      ));
  } finally {
    activeRules = undefined;
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Compatibility host failed", {
      cause: failures[0],
    });
  for (const filePath of nativeOnlyFiles) {
    const config = configs.getConfig(filePath);
    const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    const messages = nativeMessagesFor(filePath, config, positions(text), true);
    messages.sort((a, b) => a.line - b.line || a.column - b.column);
    output.push({
      filePath,
      text,
      messages,
      usedDeprecatedRules: deprecatedRules(config, rules),
      noInlineConfig: config.linterOptions?.noInlineConfig === true,
      reportUnusedDisableDirectives:
        config.linterOptions?.reportUnusedDisableDirectives ?? 1,
      reportUnusedInlineConfigs:
        config.linterOptions?.reportUnusedInlineConfigs ?? 0,
      skippedRules: skippedRulesFor(config),
    });
    services?.finish?.(filePath);
  }
  services?.close?.();
  if (graphqlFiles.length > 0) {
    const lintGraphQL = createGraphQLHost(root);
    for (let start = 0; start < graphqlFiles.length; start += 32) {
      const batch = graphqlFiles.slice(start, start + 32).map(filePath => ({
        filePath,
        text: readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""),
      }));
      lintGraphQL.prepare(batch);
      for (const { filePath, text } of batch) {
        const config = configs.getConfig(filePath);
        if (config.processor !== undefined)
          throw new Error(`GraphQL processors are unsupported: ${filePath}`);
        output.push({
          filePath,
          text,
          messages: lintGraphQL({ filePath, text, config, rules, quiet }),
          usedDeprecatedRules: deprecatedRules(config, rules),
          noInlineConfig: config.linterOptions?.noInlineConfig === true,
          reportUnusedDisableDirectives:
            config.linterOptions?.reportUnusedDisableDirectives ?? 1,
          reportUnusedInlineConfigs:
            config.linterOptions?.reportUnusedInlineConfigs ?? 0,
          skippedRules: skippedRulesFor(config),
        });
      }
    }
  }
  if (!success)
    throw new Error(
      "The Rust parser or host rejected an input; the lint run is incomplete",
    );
  if (output.length !== files.length)
    throw new Error(
      `Incomplete host run: ${output.length} of ${files.length} files`,
    );
  if (output.length === 0)
    throw new Error("The compatibility host did not lint any configured files");
  return {
    files: output.sort((a, b) => {
      if (a.filePath < b.filePath) return -1;
      if (a.filePath > b.filePath) return 1;
      return 0;
    }),
    knownRules,
    engine: "oxlint-js-compat",
    oxlintVersion: version,
    root,
    artifacts: directory,
  };
}

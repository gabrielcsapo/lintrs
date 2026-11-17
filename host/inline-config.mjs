import { hostCommand } from "./host-command.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint"));
const { ConfigCommentParser } = eslintRequire("@eslint/plugin-kit");
const { Config } = eslintRequire("./config/config.js");

export function inlineConfigs(files, configs, rules) {
  const sources = files.flatMap(filePath => {
    if (configs.getConfig(filePath).linterOptions?.noInlineConfig) return [];
    const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    return /(?:\/\*|#)\s*eslint\s/u.test(text) ? [{ filePath, text }] : [];
  });
  const overrides = new Map();
  if (sources.length === 0) return overrides;
  const comments = JSON.parse(
    hostCommand("host-comments", JSON.stringify(sources), 64 * 1024 * 1024),
  );
  const parser = new ConfigCommentParser();
  const levels = { off: 0, warn: 1, error: 2 };
  for (const [index, source] of sources.entries()) {
    const base = configs.getConfig(source.filePath);
    const merged = { ...base.rules };
    for (const comment of comments[index]) {
      if (comment.type !== "Block") continue;
      const directive = parser.parseDirective(comment.value);
      if (directive?.label !== "eslint") continue;
      const parsed = parser.parseJSONLikeConfig(directive.value);
      if (!parsed.ok)
        throw new Error(`${source.filePath}: ${parsed.error.message}`);
      for (const [id, value] of Object.entries(parsed.config)) {
        const rule = base.getRuleDefinition(id);
        if (rule === undefined)
          throw new Error(`Inline configuration refers to unknown rule ${id}`);
        rules.set(id, rule);
        const setting = Array.isArray(value) ? [...value] : [value];
        setting[0] =
          typeof setting[0] === "number" ? setting[0] : levels[setting[0]];
        if (setting.length === 1)
          setting.push(...(base.rules[id]?.slice(1) ?? []));
        merged[id] = setting;
      }
    }
    const normalized = new Config({ ...base, language: "@/js", rules: merged });
    overrides.set(source.filePath, normalized);
  }
  return overrides;
}

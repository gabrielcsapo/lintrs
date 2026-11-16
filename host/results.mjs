import { spawnSync } from "node:child_process";

export function formatUnix(results) {
  let total = 0;
  const lines = [];
  for (const result of results) {
    for (const message of result.messages) {
      total++;
      const severity = message.severity === 2 ? "Error" : "Warning";
      const rule =
        message.ruleId === null || message.ruleId === undefined
          ? ""
          : `/${message.ruleId}`;
      lines.push(
        `${result.filePath}:${message.line || 0}:${message.column || 0}: ${message.message} [${severity}${rule}]`,
      );
    }
  }
  let output = lines.join("\n");
  if (total > 0) output += `\n\n${total} problem${total === 1 ? "" : "s"}`;
  return `${output}\n`;
}

export function finalizeHost(output) {
  if (process.env.RLINT_BINARY === undefined)
    throw new Error("The Rust host binary is missing");
  const finalized = spawnSync(process.env.RLINT_BINARY, ["--finalize-host"], {
    input: JSON.stringify(output),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (finalized.error !== undefined) throw finalized.error;
  if (finalized.status !== 0) throw new Error(finalized.stderr.trim());
  return JSON.parse(finalized.stdout);
}

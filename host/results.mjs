import { hostCommand } from "./host-command.mjs";

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
  return JSON.parse(
    hostCommand("finalize-host", JSON.stringify(output), 256 * 1024 * 1024),
  );
}

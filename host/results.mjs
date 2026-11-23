import { nativeFixText } from "./native/fix-text.mjs";
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
  const encoded = JSON.stringify(output, (key, value) => {
    if (
      key !== "fix" ||
      typeof value?.text !== "string" ||
      value.text.isWellFormed()
    )
      return value;
    return {
      ...value,
      text: "",
      textUtf16: Array.from({ length: value.text.length }, (_, index) =>
        value.text.charCodeAt(index),
      ),
    };
  });
  return JSON.parse(
    hostCommand("finalize-host", encoded, 256 * 1024 * 1024),
    (key, value) => {
      if (key !== "fix" || value?.textUtf16 === undefined) return value;
      const { text: placeholder, textUtf16, ...rest } = value;
      if (placeholder !== "")
        throw new TypeError("Invalid UTF-16 fix placeholder");
      return { ...rest, text: nativeFixText({ textUtf16 }) };
    },
  );
}

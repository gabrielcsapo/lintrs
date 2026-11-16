import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export function translateFlags(source, target, label, omitted = []) {
  const bits = new Map(omitted.map(name => [source[name], 0]));
  const cache = new Map();
  for (const [name, value] of Object.entries(source)) {
    if (
      typeof value === "number" &&
      value !== 0 &&
      (value & (value - 1)) === 0 &&
      typeof target[name] === "number" &&
      !bits.has(value)
    )
      bits.set(value, target[name]);
  }
  return value => {
    if (cache.has(value)) return cache.get(value);
    let remaining = value;
    let translated = 0;
    for (const [input, output] of bits) {
      if ((remaining & input) !== 0) {
        remaining &= ~input;
        translated |= output;
      }
    }
    if (remaining !== 0)
      throw new Error(`Unsupported tsrs ${label} bits: ${remaining}`);
    cache.set(value, translated);
    return translated;
  };
}

export function createFlags(sdk) {
  const flags = {
    type: translateFlags(sdk.api.TypeFlags, ts.TypeFlags, "TypeFlags"),
    // These tsrs checker caches have no TypeScript 6 flag equivalents.
    object: translateFlags(sdk.api.ObjectFlags, ts.ObjectFlags, "ObjectFlags", [
      "MembersResolved",
      "IsUniformEnumComputed",
      "IsUniformEnum",
    ]),
    symbol: translateFlags(sdk.api.SymbolFlags, ts.SymbolFlags, "SymbolFlags", [
      "ConstEnumOnlyModule",
    ]),
    node: translateFlags(sdk.ast.NodeFlags, ts.NodeFlags, "NodeFlags", [
      "HasJSDoc",
      "PossiblyContainsDeprecatedTag",
    ]),
  };
  const kinds = new Map();
  for (const [name, value] of Object.entries(sdk.ast.SyntaxKind)) {
    if (
      typeof value === "number" &&
      typeof ts.SyntaxKind[name] === "number" &&
      !/^(?:First|Last)|Count$/u.test(name)
    )
      kinds.set(value, ts.SyntaxKind[name]);
  }
  kinds.set(sdk.ast.SyntaxKind.EndOfFile, ts.SyntaxKind.EndOfFileToken);
  const intrinsicTypeNodes = new Set(
    [
      "StringKeyword",
      "NumberKeyword",
      "BooleanKeyword",
      "BigIntKeyword",
      "SymbolKeyword",
      "UndefinedKeyword",
      "AnyKeyword",
      "UnknownKeyword",
      "NeverKeyword",
      "VoidKeyword",
    ].map(kind => ts.SyntaxKind[kind]),
  );
  return { flags, kinds, intrinsicTypeNodes };
}

export function nativeFixText(fix) {
  if (fix.textUtf16 === undefined) {
    if (typeof fix.text !== "string")
      throw new Error("Native fix text must be a string");
    return fix.text;
  }
  if (
    fix.text !== undefined ||
    !Array.isArray(fix.textUtf16) ||
    fix.textUtf16.some(
      unit => !Number.isInteger(unit) || unit < 0 || unit > 65535,
    )
  )
    throw new Error(
      "Native UTF-16 fix text must contain unsigned 16-bit code units",
    );
  let result = "";
  for (let index = 0; index < fix.textUtf16.length; index += 16384)
    result += String.fromCharCode(...fix.textUtf16.slice(index, index + 16384));
  return result;
}

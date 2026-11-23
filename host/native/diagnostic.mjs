export function nativeDiagnosticLocation(diagnostic, position) {
  if (diagnostic.loc !== undefined) {
    const { start, end } = diagnostic.loc;
    return {
      line: start.line,
      column: start.column + 1,
      ...(end === undefined
        ? {}
        : { endLine: end.line, endColumn: end.column + 1 }),
    };
  }
  const start = position(diagnostic.pos);
  const end = position(diagnostic.end);
  return {
    line: start.line,
    column: start.column,
    ...(diagnostic.end === diagnostic.pos
      ? {}
      : { endLine: end.line, endColumn: end.column }),
  };
}

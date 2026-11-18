// Temporary directories for tests, removed when the test process exits.
// Some are handed to spawned lintrs runs or shared across a file's tests, so
// they outlive any one test; node:test runs each file in its own process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created = [];
process.on("exit", () => {
  for (const directory of created)
    rmSync(directory, { recursive: true, force: true });
});

export function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

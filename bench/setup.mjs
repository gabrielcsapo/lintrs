// Prepares bench/.work: a pinned date-fns checkout with the benchmark configs and rules.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const work = join(import.meta.dirname, ".work");
const target = join(work, "date-fns");
const commit = "313b902b9a72c64501074db9bc2b9897d2db5140"; // date-fns v4.1.0

mkdirSync(work, { recursive: true });
if (!existsSync(target)) {
  execFileSync(
    "git",
    [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      "v4.1.0",
      "https://github.com/date-fns/date-fns.git",
      target,
    ],
    { stdio: "inherit" },
  );
}
const head = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== commit)
  throw new Error(`${target} is at ${head}, expected ${commit}`);
if (!existsSync(join(work, "node_modules")))
  symlinkSync(join(repo, "node_modules"), join(work, "node_modules"), "dir");
for (const file of readdirSync(join(import.meta.dirname, "fixtures")))
  cpSync(join(import.meta.dirname, "fixtures", file), join(target, file));
const rules = join(target, ".lintrs-bench/rules");
cpSync(join(import.meta.dirname, "rules"), rules, { recursive: true });
const plugin = join(rules, "native.mjs");
writeFileSync(
  plugin,
  readFileSync(plugin, "utf8").replace(
    "__LINTRS_NATIVE__",
    pathToFileURL(join(repo, "host/native/index.mjs")).href,
  ),
);
process.stdout.write(`bench target ready: ${target}\n`);

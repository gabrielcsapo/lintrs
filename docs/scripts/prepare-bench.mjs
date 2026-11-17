// Copies docs/bench/results.json into public/ so the Benchmarks page can
// fetch it at <base>bench/results.json. Absent input is not an error — the
// page renders "Benchmarks coming soon".
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const source = join(import.meta.dirname, "../bench/results.json");
const target = join(import.meta.dirname, "../docs/public/bench/results.json");
if (existsSync(source)) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`bench: copied ${source} -> docs/public/bench/results.json`);
}

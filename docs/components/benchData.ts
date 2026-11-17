export interface Distribution {
  median: number;
  min: number;
  max: number;
  samples: number[];
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  messages: number;
  wallMs: Distribution;
  peakRssMB: Distribution;
}

export interface Parity {
  onlyBaseline: number;
  onlyThis: number;
  messageTextDifferences: number;
}

export interface Suite {
  id: string;
  title: string;
  description: string;
  config: string;
  baseline: string;
  files: number;
  scenarios: Scenario[];
  parity: Record<string, Parity>;
}

export interface BenchmarkResults {
  generatedAt: string;
  machine: { cpu: string; cores: number; memoryGB: number; os: string };
  versions: Record<string, string>;
  target: { repo: string; ref: string; commit: string };
  method: {
    runs: number;
    warmups: number;
    interleaved: boolean;
    timer: string;
    cache: string;
  };
  suites: Suite[];
}

// docs/bench/results.json is bundled at build time so the numbers are in the
// prerendered HTML. The context is empty when the file is absent; callers then
// fall back to fetching the copy in public/ (see scripts/prepare-bench.mjs) or
// render nothing.
function load(): BenchmarkResults | null {
  try {
    const context = (
      import.meta as unknown as {
        webpackContext: (
          directory: string,
          options: { recursive: boolean; regExp: RegExp },
        ) => { keys(): string[]; (key: string): unknown };
      }
    ).webpackContext("../bench", {
      recursive: false,
      regExp: /^\.\/results\.json$/,
    });
    const key = context.keys()[0];
    return key === undefined ? null : (context(key) as BenchmarkResults);
  } catch {
    return null;
  }
}

export const bundledResults = load();

export function baselineOf(suite: Suite) {
  return suite.scenarios.find(scenario => scenario.id === suite.baseline);
}

/** The scenario with the lowest median wall time, other than the baseline. */
export function fastestOf(suite: Suite) {
  return suite.scenarios
    .filter(scenario => scenario.id !== suite.baseline)
    .sort((a, b) => a.wallMs.median - b.wallMs.median)[0];
}

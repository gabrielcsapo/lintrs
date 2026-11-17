import "@fontsource-variable/nunito";
import { useState } from "react";
import { Layout as BaseLayout } from "@rspress/core/theme-original";
import { Link } from "@rspress/core/theme-original";
import {
  baselineOf,
  bundledResults,
  type Scenario,
  type Suite,
} from "../components/benchData";

const command = "npx lintrs --config eslint.config.mjs src";

// Illustrative output in lintrs's default `unix` format (ESLint's unix
// formatter). The last line comes from the Rust rule in the guide.
const diagnostics = [
  {
    location: "/app/src/fetch.ts:14:3",
    message: 'Unexpected `await` of a non-Promise (non-"Thenable") value.',
    rule: "@typescript-eslint/await-thenable",
  },
  {
    location: "/app/src/parse.ts:8:10",
    message:
      "This assertion is unnecessary since it does not change the type of the expression.",
    rule: "@typescript-eslint/no-unnecessary-type-assertion",
  },
  {
    location: "/app/src/date.ts:31:17",
    message: "Call returns a union type",
    rule: "example/call-returns-union",
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="lintrs-terminal__copy"
      aria-label={copied ? "Copied" : "Copy command"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      )}
    </button>
  );
}

function Terminal() {
  return (
    <div className="lintrs-terminal-wrap">
      <figure className="lintrs-terminal">
        <figcaption className="lintrs-terminal__bar">
          <span className="lintrs-terminal__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="lintrs-terminal__title">~/app</span>
          <CopyButton text={command} />
        </figcaption>
        <pre className="lintrs-terminal__body">
          <code>
            <span className="lintrs-terminal__line">
              <span className="lintrs-terminal__prompt" aria-hidden="true">
                ${" "}
              </span>
              {command}
            </span>
            {diagnostics.map(diagnostic => (
              <span className="lintrs-terminal__diag" key={diagnostic.location}>
                <span className="lintrs-terminal__loc">
                  {diagnostic.location}:
                </span>{" "}
                {diagnostic.message}{" "}
                <span className="lintrs-terminal__rule">
                  [Error/{diagnostic.rule}]
                </span>
              </span>
            ))}
            <span className="lintrs-terminal__summary">
              {diagnostics.length} problems
            </span>
          </code>
        </pre>
      </figure>
    </div>
  );
}

function find(suiteId: string, scenarioId: string) {
  const suite = bundledResults?.suites.find(entry => entry.id === suiteId);
  const scenario = suite?.scenarios.find(entry => entry.id === scenarioId);
  const baseline = suite && baselineOf(suite);
  return suite && scenario && baseline
    ? ([suite, scenario, baseline] as [Suite, Scenario, Scenario])
    : undefined;
}

function speedup(scenario: Scenario, baseline: Scenario) {
  return baseline.wallMs.median / scenario.wallMs.median;
}

function Stats() {
  const rust = find("custom-typed-rule", "lintrs-rust");
  const js = find("custom-typed-rule", "lintrs-js");
  const stock = find("typescript-eslint", "lintrs");
  if (!rust || !js || !stock) return null;

  const [stockSuite, stockScenario, stockBaseline] = stock;
  const memory =
    (1 - stockScenario.peakRssMB.median / stockBaseline.peakRssMB.median) * 100;
  const parity = stockSuite.parity[stockScenario.id];
  const identical =
    parity &&
    parity.onlyBaseline === 0 &&
    parity.onlyThis === 0 &&
    parity.messageTextDifferences === 0;
  const stockSpeed = speedup(stockScenario, stockBaseline);

  return (
    <section className="lintrs-stats" aria-labelledby="lintrs-stats-title">
      <div className="lintrs-stats__header">
        <h2 id="lintrs-stats-title">Measured, not promised</h2>
        <p>
          {stockSuite.files.toLocaleString("en-US")} files of date-fns, median
          of {bundledResults?.method.runs} runs against ESLint.
        </p>
      </div>
      <dl className="lintrs-stats__grid">
        <div className="lintrs-stats__item">
          <dt>Custom typed rule, written in Rust</dt>
          <dd>{speedup(rust[1], rust[2]).toFixed(2)}× faster</dd>
        </div>
        <div className="lintrs-stats__item">
          <dt>The same rule in JS, unchanged</dt>
          <dd>{speedup(js[1], js[2]).toFixed(2)}× faster</dd>
        </div>
        <div className="lintrs-stats__item">
          <dt>
            Peak memory, recommendedTypeChecked
            {identical && ", identical diagnostics"}
          </dt>
          <dd>−{memory.toFixed(0)}%</dd>
        </div>
      </dl>
      <p className="lintrs-stats__note">
        {stockSpeed < 1
          ? `Stock typed rules currently run ${(1 / stockSpeed).toFixed(2)}× slower than ESLint. `
          : ""}
        <Link href="/benchmarks">See every number and the methodology →</Link>
      </p>
    </section>
  );
}

const Layout = () => (
  <BaseLayout afterHero={<Terminal />} afterFeatures={<Stats />} />
);

export * from "@rspress/core/theme-original";
export { Layout };

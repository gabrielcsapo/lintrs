import { useEffect, useState } from "react";
import { withBase } from "@rspress/core/runtime";
import {
  baselineOf,
  bundledResults,
  type BenchmarkResults,
  type Parity,
  type Scenario,
  type Suite,
} from "./benchData";
import { useCrawl, Worm } from "./Worm";

type Metric = "wallMs" | "peakRssMB";
type Tone = "better" | "worse" | "neutral";

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function megabytes(mb: number) {
  return `${mb.toFixed(0)} MB`;
}

function relativeTime(scenario: Scenario, baseline: Scenario): [string, Tone] {
  if (scenario.id === baseline.id) return ["baseline", "neutral"];
  const ratio = baseline.wallMs.median / scenario.wallMs.median;
  return ratio >= 1
    ? [`${ratio.toFixed(2)}× faster`, "better"]
    : [`${(1 / ratio).toFixed(2)}× slower`, "worse"];
}

function relativeMemory(
  scenario: Scenario,
  baseline: Scenario,
): [string, Tone] {
  if (scenario.id === baseline.id) return ["baseline", "neutral"];
  const change =
    (scenario.peakRssMB.median / baseline.peakRssMB.median - 1) * 100;
  return [
    `${change > 0 ? "+" : "−"}${Math.abs(change).toFixed(0)}%`,
    change > 0 ? "worse" : "better",
  ];
}

function parityLine(parity: Parity) {
  const parts = [];
  if (parity.onlyBaseline === 0 && parity.onlyThis === 0)
    // Same diagnostics at the same places; "identical" only if the text
    // matches too.
    parts.push(
      parity.messageTextDifferences === 0
        ? "identical diagnostics"
        : "same diagnostics",
    );
  else {
    if (parity.onlyBaseline > 0)
      parts.push(`${parity.onlyBaseline} only in the baseline`);
    if (parity.onlyThis > 0)
      parts.push(`${parity.onlyThis} only in this scenario`);
  }
  if (parity.messageTextDifferences > 0)
    parts.push(
      `${parity.messageTextDifferences} message text difference${
        parity.messageTextDifferences === 1 ? "" : "s"
      }`,
    );
  return parts.join("; ");
}

function isIdentical(parity: Parity) {
  return (
    parity.onlyBaseline === 0 &&
    parity.onlyThis === 0 &&
    parity.messageTextDifferences === 0
  );
}

function Chart({
  suite,
  baseline,
  metric,
}: {
  suite: Suite;
  baseline: Scenario | undefined;
  metric: Metric;
}) {
  const format = metric === "wallMs" ? seconds : megabytes;
  const relative = metric === "wallMs" ? relativeTime : relativeMemory;
  const scale = Math.max(
    ...suite.scenarios.map(scenario => scenario[metric].max),
    Number.EPSILON,
  );
  const percent = (value: number) => `${(value / scale) * 100}%`;
  // The best (lowest) result among the non-baseline scenarios gets the
  // mascot's motion lines, but only when it actually beats the baseline.
  const best = Math.min(
    ...suite.scenarios
      .filter(scenario => scenario.id !== suite.baseline)
      .map(scenario => scenario[metric].median),
  );
  const [ref, crawl] = useCrawl<HTMLUListElement>();
  return (
    <ul
      ref={ref}
      className={`lintrs-bench-chart lintrs-bench-chart--${crawl} rp-not-doc`}
    >
      {suite.scenarios.map((scenario, index) => {
        const value = scenario[metric];
        const isBaseline = scenario.id === suite.baseline;
        // Too short to fit a head without crowding the body: plain bar.
        const isWorm = !isBaseline && value.median / scale >= 0.12;
        const [comparison, tone] = baseline
          ? relative(scenario, baseline)
          : [undefined, "neutral"];
        return (
          <li
            className={`lintrs-bench-row${
              isBaseline ? " lintrs-bench-row--baseline" : ""
            }`}
            key={scenario.id}
          >
            <span className="lintrs-bench-name" title={scenario.description}>
              {scenario.name}
            </span>
            <span
              className="lintrs-bench-track"
              role="img"
              aria-label={`${scenario.name}: median ${format(
                value.median,
              )}, range ${format(value.min)} to ${format(value.max)}`}
            >
              {isWorm ? (
                <Worm
                  width={percent(value.median)}
                  index={index}
                  excited={
                    value.median === best &&
                    (baseline === undefined ||
                      value.median < baseline[metric].median)
                  }
                />
              ) : (
                <span
                  className="lintrs-bench-bar"
                  style={{ width: percent(value.median) }}
                />
              )}
              <span
                className="lintrs-bench-range"
                style={{
                  left: percent(value.min),
                  width: `max(2px, ${percent(value.max - value.min)})`,
                }}
              />
            </span>
            <span className="lintrs-bench-value">
              <strong>{format(value.median)}</strong>
              {comparison && (
                <small className={`lintrs-bench-delta--${tone}`}>
                  {comparison}
                </small>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SuiteSection({ suite }: { suite: Suite }) {
  const baseline = baselineOf(suite);
  const compared =
    baseline === undefined
      ? []
      : suite.scenarios.filter(
          scenario => scenario.id !== baseline.id && suite.parity[scenario.id],
        );
  return (
    <section className="lintrs-bench-suite">
      <h3>{suite.title}</h3>
      <p>{suite.description}</p>
      <ul className="lintrs-bench-meta rp-not-doc">
        <li>{suite.files.toLocaleString("en-US")} files</li>
        <li>
          <code>{suite.config}</code>
        </li>
        {baseline && <li>baseline: {baseline.name}</li>}
      </ul>
      <div className="lintrs-bench-card">
        <p className="lintrs-bench-metric">
          Wall time
          <span>
            median; the line underneath marks min–max; shorter is better
          </span>
        </p>
        <Chart suite={suite} baseline={baseline} metric="wallMs" />
        <p className="lintrs-bench-metric">
          Peak memory
          <span>median RSS; shorter is better</span>
        </p>
        <Chart suite={suite} baseline={baseline} metric="peakRssMB" />
        {baseline !== undefined && compared.length > 0 && (
          <ul className="lintrs-bench-parity rp-not-doc">
            {compared.map(scenario => {
              const parity = suite.parity[scenario.id];
              return (
                <li key={scenario.id}>
                  <span
                    className={`lintrs-bench-parity-dot${
                      isIdentical(parity)
                        ? " lintrs-bench-parity-dot--same"
                        : ""
                    }`}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>{scenario.name}</strong> vs {baseline.name}:{" "}
                    {parityLine(parity)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <details className="lintrs-bench-raw">
        <summary>All numbers</summary>
        <div className="lintrs-bench-table-wrap">
          <table className="lintrs-bench-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Description</th>
                <th>Wall median</th>
                <th>Wall min–max</th>
                <th>Peak RSS median</th>
                <th>Messages</th>
              </tr>
            </thead>
            <tbody>
              {suite.scenarios.map(scenario => (
                <tr key={scenario.id}>
                  <td>{scenario.name}</td>
                  <td>{scenario.description ?? ""}</td>
                  <td>{seconds(scenario.wallMs.median)}</td>
                  <td>
                    {seconds(scenario.wallMs.min)} –{" "}
                    {seconds(scenario.wallMs.max)}
                  </td>
                  <td>{megabytes(scenario.peakRssMB.median)}</td>
                  <td>{scenario.messages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function useResults() {
  const [data, setData] = useState<BenchmarkResults | null>(bundledResults);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (bundledResults !== null) return;
    fetch(withBase("/bench/results.json"))
      .then(response => (response.ok ? response.json() : null))
      .then(json => {
        if (json === null) setMissing(true);
        else setData(json as BenchmarkResults);
      })
      .catch(() => setMissing(true));
  }, []);

  return missing ? null : data;
}

export function Benchmarks() {
  const data = useResults();
  if (data === null)
    return (
      <div className="lintrs-bench-coming-soon">
        <strong>Benchmarks coming soon.</strong>
        <p>No results have been published yet.</p>
      </div>
    );
  return (
    <>
      {data.suites.map(suite => (
        <SuiteSection suite={suite} key={suite.id} />
      ))}
    </>
  );
}

export function BenchmarkMethodology() {
  const data = useResults();
  if (data === null) return null;
  const generated = new Date(data.generatedAt);
  return (
    <>
      <dl className="lintrs-bench-method">
        <dt>Machine</dt>
        <dd>
          {data.machine.cpu}, {data.machine.cores} cores,{" "}
          {data.machine.memoryGB} GB, {data.machine.os}
        </dd>
        <dt>Target</dt>
        <dd>
          <a href={data.target.repo}>
            {data.target.repo.replace(/^https:\/\/github\.com\//, "")}
          </a>{" "}
          {data.target.ref} (<code>{data.target.commit.slice(0, 12)}</code>)
        </dd>
        <dt>Runs</dt>
        <dd>
          {data.method.runs} timed
          {data.method.warmups > 0 &&
            ` after ${data.method.warmups} warmup${
              data.method.warmups === 1 ? "" : "s"
            }`}
          {data.method.interleaved && ", interleaved between tools"}
        </dd>
        <dt>Timer</dt>
        <dd>{data.method.timer}</dd>
        <dt>Cache</dt>
        <dd>{data.method.cache}</dd>
        <dt>Versions</dt>
        <dd>
          {Object.entries(data.versions)
            .map(([tool, version]) => `${tool} ${version}`)
            .join(" · ")}
        </dd>
        <dt>Generated</dt>
        <dd>
          <time dateTime={data.generatedAt}>
            {Number.isNaN(generated.getTime())
              ? data.generatedAt
              : generated.toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  timeZone: "UTC",
                })}
          </time>
        </dd>
      </dl>
      <p>
        Reproduce with the benchmark harness in <code>bench/</code>:{" "}
        <code>npm run bench</code>.
      </p>
    </>
  );
}

export default Benchmarks;

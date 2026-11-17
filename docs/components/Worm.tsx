import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * A benchmark bar drawn as the lintrs mascot. The whole worm (tail to the tip
 * of the head) spans `width`, so its length encodes the value exactly like a
 * plain bar would. The head is an end cap inside that length, never extra.
 */
export function Worm({
  width,
  index,
  excited,
}: {
  /** CSS length for the worm, e.g. "42%". */
  width: string;
  /** Row position; staggers the crawl-in and the blinks. */
  index: number;
  /** Adds the logo's little motion lines (used for the best result). */
  excited?: boolean;
}) {
  return (
    <span
      className="lintrs-worm"
      style={{ width, "--i": index } as CSSProperties}
      aria-hidden="true"
    >
      <span className="lintrs-worm__body" />
      <svg className="lintrs-worm__head" viewBox="0 0 40 28">
        {excited && (
          <g className="lintrs-worm__lines">
            <path d="M23 3.2 24.4 0.6" />
            <path d="M28.6 3 31.2 0.9" />
            <path d="M33 5.3 36 4.3" />
          </g>
        )}
        <path
          className="lintrs-worm__skin"
          d="M4 18.5C4 11 11.5 6 21.5 6 31.5 6 40 9.6 40 15.5 40 22.5 31 27 19.5 27 10 27 4 24.2 4 18.5Z"
        />
        <g className="lintrs-worm__eyes">
          <ellipse
            className="lintrs-worm__sclera"
            cx="22"
            cy="15"
            rx="4.6"
            ry="5"
          />
          <ellipse
            className="lintrs-worm__sclera"
            cx="31"
            cy="14"
            rx="4.2"
            ry="4.6"
          />
          <circle className="lintrs-worm__pupil" cx="23.6" cy="15.6" r="2.6" />
          <circle className="lintrs-worm__pupil" cx="32.4" cy="14.6" r="2.4" />
        </g>
      </svg>
    </span>
  );
}

/**
 * Lets the worms in a chart crawl out once, the first time the chart scrolls
 * into view. Without JS, or with reduced motion, they simply render at full
 * length.
 */
export function useCrawl<T extends Element>() {
  const ref = useRef<T>(null);
  const [state, setState] = useState<"idle" | "waiting" | "crawling">("idle");

  useEffect(() => {
    const element = ref.current;
    if (
      element === null ||
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    setState("waiting");
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer.disconnect();
          // Let the collapsed state paint before transitioning out of it.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setState("crawling")),
          );
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, state] as const;
}

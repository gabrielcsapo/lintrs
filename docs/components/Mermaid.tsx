import { useEffect, useId, useState } from "react";

/**
 * Renders a ```mermaid block (see scripts/remark-mermaid.mjs).
 *
 * The diagram source is server-rendered as a code block, so the page has
 * content without JS and doesn't jump while mermaid loads. Mermaid itself is
 * imported on demand, only on pages that have a diagram. Colours come from
 * CSS (styles/index.css, "Mermaid diagrams"), so the light/dark switch needs
 * no re-render.
 */
export default function Mermaid({ code }: { code: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          // Mermaid 12 defaults to the "neo" look (double outlines, glows);
          // the sticker styling in CSS replaces it.
          look: "classic",
          layout: "dagre",
          themeVariables: { edgeLabelBackground: "transparent" },
          fontFamily: '"Nunito Variable", ui-rounded, sans-serif',
          flowchart: { curve: "basis", padding: 14, nodeSpacing: 36 },
        });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) setSvg(svg);
      })
      .catch(error => {
        // Leave the source visible; it is still readable.
        console.error("mermaid:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  return (
    <figure className="lintrs-mermaid rp-not-doc">
      {svg === null ? (
        <pre className="lintrs-mermaid__source">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="lintrs-mermaid__diagram"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </figure>
  );
}

// Turns ```mermaid code blocks into <Mermaid code="..." /> elements, rendered
// by the global component in components/Mermaid.tsx.
interface Node {
  type: string;
  lang?: string | null;
  value?: string;
  children?: Node[];
  [key: string]: unknown;
}

export default function remarkMermaid() {
  const walk = (node: Node) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.map(child => {
      if (child.type === "code" && child.lang === "mermaid")
        return {
          type: "mdxJsxFlowElement",
          name: "Mermaid",
          attributes: [
            { type: "mdxJsxAttribute", name: "code", value: child.value ?? "" },
          ],
          children: [],
        };
      walk(child);
      return child;
    });
  };
  return (tree: Node) => walk(tree);
}

import { join } from "node:path";
import { defineConfig } from "@rspress/core";
import remarkMermaid from "./scripts/remark-mermaid";

const siteUrl = "https://gabrielcsapo.github.io/lintrs/";
const title = "lintrs — keep your ESLint config, run it on Rust";
const description =
  "lintrs runs the rules in your existing eslint.config.mjs, typed typescript-eslint rules included, with oxc parsing and a native TypeScript 7 checker. Write your own type-aware lint rules in Rust.";

// One sidebar for every documentation page. URLs keep their original
// /guide/, /reference/ and top-level paths so existing links still work.
const documentation = [
  {
    text: "Getting started",
    items: [
      { text: "Introduction", link: "/guide/introduction" },
      { text: "Install and run", link: "/guide/getting-started" },
      { text: "Configuration", link: "/guide/configuration" },
    ],
  },
  {
    text: "Rules",
    items: [
      { text: "Overview", link: "/guide/rules" },
      { text: "JavaScript rules", link: "/guide/js-rules" },
      { text: "Rust rules", link: "/guide/rust-rules" },
      { text: "Packaging Rust rules", link: "/guide/packaging" },
      { text: "Testing rules", link: "/guide/testing-rules" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "CLI", link: "/reference/cli" },
      { text: "Environment variables", link: "/reference/env" },
      { text: "Native rules API", link: "/reference/native-api" },
    ],
  },
  {
    text: "Under the hood",
    items: [
      { text: "How it works", link: "/guide/architecture" },
      { text: "Benchmarks", link: "/benchmarks" },
      { text: "Profiling rules", link: "/guide/profiling" },
      { text: "Limitations", link: "/guide/limitations" },
      { text: "FAQ", link: "/guide/faq" },
    ],
  },
  {
    text: "Project",
    items: [{ text: "Contributing", link: "/contributing" }],
  },
];

export default defineConfig({
  root: "docs",
  base: "/lintrs/",
  lang: "en",
  title: "lintrs",
  description,
  icon: "/favicon.png",
  logo: "/logo.png",
  logoText: "lintrs",
  siteOrigin: "https://gabrielcsapo.github.io",
  head: [
    ["meta", { name: "theme-color", content: "#f4632e" }],
    ["link", { rel: "apple-touch-icon", href: "/lintrs/apple-touch-icon.png" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "lintrs" }],
    ["meta", { property: "og:url", content: siteUrl }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { property: "og:image", content: `${siteUrl}og.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    [
      "meta",
      {
        property: "og:image:alt",
        content: "lintrs: Keep your ESLint config. Run it on Rust.",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: title }],
    ["meta", { name: "twitter:description", content: description }],
    ["meta", { name: "twitter:image", content: `${siteUrl}og.png` }],
  ],
  globalStyles: join(import.meta.dirname, "styles/index.css"),
  markdown: {
    // ```mermaid blocks render as diagrams; see components/Mermaid.tsx.
    remarkPlugins: [remarkMermaid],
    globalComponents: [join(import.meta.dirname, "components/Mermaid.tsx")],
  },
  themeConfig: {
    nav: [
      {
        text: "Documentation",
        link: "/guide/introduction",
        activeMatch: "^/(guide|reference|benchmarks|contributing)",
      },
    ],
    sidebar: Object.fromEntries(
      ["/guide/", "/reference/", "/benchmarks", "/contributing"].map(prefix => [
        prefix,
        documentation,
      ]),
    ),
    editLink: {
      docRepoBaseUrl:
        "https://github.com/gabrielcsapo/lintrs/tree/main/docs/docs",
    },
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/gabrielcsapo/lintrs",
      },
    ],
    search: true,
    footer: {
      message:
        "Released under the MIT license. Experimental: ESLint parity is incomplete.",
    },
  },
});

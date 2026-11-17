---
pageType: home
title: lintrs

hero:
  badge:
    text: Experimental
    link: /guide/limitations
  name: lintrs
  text: Your ESLint config, on Rust.
  image:
    src: /mascot.webp
    alt: The lintrs mascot, an orange blob with a lavender tail
  tagline: >-
    Run your rules, typed rules included, on a native TypeScript checker.
    Write new ones in JS or Rust.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /guide/introduction

features:
  - title: Your config, as-is
    details: Point lintrs at the eslint.config.mjs you already have.
    link: /guide/configuration
  - title: Typed rules, native checker
    details: Typed typescript-eslint rules run against a native TypeScript 7 checker.
    link: /guide/rules
  - title: Rules in JS or Rust
    details: Same config either way. Rust rules run beside the checker.
    link: /guide/rules
  - title: ESLint output
    details: eslint-disable, ESLint's JSON and unix formats, the same exit codes.
    link: /reference/cli
---

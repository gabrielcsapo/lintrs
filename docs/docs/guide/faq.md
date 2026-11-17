# FAQ

## Do I need Rust to use lintrs?

No. A lint run needs Node ≥ 24. Cargo, `rustc` and the SDK tarball are needed
only to [build rule crates from source](./packaging#local-packages).

## Does it work with typescript-eslint?

Yes, with gaps. See [Limitations](./limitations).

## Why are typed rules slower than in ESLint?

Each type answer crosses from the Rust checker to JavaScript and is turned
into the objects typescript-eslint rules expect; under ESLint, TypeScript is
already in the same process. Untyped work and the checker itself are faster.
See [Typed JavaScript rules are slower than ESLint](./limitations#typed-javascript-rules-are-slower-than-eslint).

## How does it differ from oxlint's JS plugins?

See [Compared with](./introduction#compared-with).

## Are `oxlint-disable` comments honored?

No. Only `eslint-disable*` and `eslint-enable`, as in ESLint.

## Can I mix JS and Rust rules?

Yes. They share one config, program, checker and report pipeline. Files whose
enabled rules are all native skip the JS rule runtime.

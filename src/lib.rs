//! Rust parsing and type services for an ESLint-compatible JavaScript rule host.

pub mod diagnostic;
pub mod directives;
pub mod host;
#[cfg(feature = "in-process-node")]
pub mod in_process;
mod jsonc;
pub mod native;
/// tsrs types re-exported so rule libraries name them through `lintrs::ts`.
pub use native::ts;
pub mod languages;
pub mod output;
mod text;
pub mod type_api;

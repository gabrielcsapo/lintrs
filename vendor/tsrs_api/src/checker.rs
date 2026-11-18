// Modified by lintrs: see vendor/tsrs_api/README.md.
// Node API checker lane (mfs-cx/node-api-checker): port of the checker / symbol / type / signature
// request handlers of the pinned tsgo API (microsoft/TypeScript b85298b6, tsc/internal/api/session.go +
// proto.go). See checker/README.md for the contract, id ownership and the per-method coverage inventory.
//
// Core hook (docs/NODE_API.md, "checker hook"): `handle(session, method, params)` and
// `CheckerSnapshotState`. Internally the handlers run against the `CheckerHost` trait so they only
// borrow snapshots, node handles, source-file descriptors and the AST encoder for one request;
// `SessionHost` adapts core's `Session` to it.

mod dispatch;
mod handlers_ls;
mod handlers_symbols;
mod handlers_types;
pub mod host;
mod json;
mod lease;
mod params;
pub mod registry;
mod setup;
mod symbol_index;

#[cfg(test)] // the method inventory that tests.rs checks against core's dispatch
pub mod coverage_table;
#[cfg(test)]
pub mod coverage_types;

use std::sync::Arc;

use tsrs_ast::{Node, SourceFile};
use tsrs_compiler::Program;
use tsrs_core::context::Context;
use tsrs_core::json::Value;
use tsrs_core::P;
use tsrs_project::Snapshot;

pub use host::{CachedFileScope, CheckerError, CheckerErrorKind, CheckerHost, CheckerResponse, CheckerResult, SnapshotScope};
pub use registry::CheckerRegistry;

use crate::handler::{ApiError, ApiResult, ErrorKind, Response};
use crate::session::{json_response, Session};
use crate::wire::Obj;

/// Per-snapshot checker registries (Go `snapshotData.symbolRegistry` + `projectRegistries`). Core
/// creates it with `Default` when a snapshot is registered and drops it with the snapshot; dropping
/// releases every registered pointer.
#[derive(Default)]
pub struct CheckerSnapshotState {
    pub(crate) registry: Arc<CheckerRegistry>,
}

impl Drop for CheckerSnapshotState {
    fn drop(&mut self) {
        self.registry.release();
    }
}

/// Core entry point. `None` only for methods this lane does not recognize.
pub(crate) fn handle(session: &Session, method: &str, params: &Value) -> Option<ApiResult<Response>> {
    let host = SessionHost { session };
    let result = dispatch::handle(&host, method, params)?;
    Some(result.map_err(to_api_error).and_then(|response| match response {
        CheckerResponse::Json(value) => json_response(&value),
        CheckerResponse::EncodedNode(bytes) => {
            if session.binary_responses() {
                Ok(Response::Binary(bytes))
            } else {
                json_response(&Obj::new().set("data", Value::String(base64_encode(&bytes))).build())
            }
        }
    }))
}

fn to_api_error(e: CheckerError) -> ApiError {
    match e.kind {
        CheckerErrorKind::InvalidRequest => ApiError::invalid_request(e.message),
        CheckerErrorKind::Client => ApiError::client(e.message),
        CheckerErrorKind::Unsupported => ApiError { kind: ErrorKind::Unsupported, message: e.message },
        CheckerErrorKind::Internal => ApiError::internal(e.message),
    }
}

fn from_api_error(e: ApiError) -> CheckerError {
    match e.kind {
        ErrorKind::InvalidRequest => CheckerError::invalid(e.message),
        ErrorKind::ClientError => CheckerError::client(e.message),
        ErrorKind::Unsupported => CheckerError::unsupported(e.message),
        ErrorKind::Internal => CheckerError { kind: CheckerErrorKind::Internal, message: e.message },
    }
}

/// Adapts core's `Session` to `CheckerHost`.
struct SessionHost<'a> {
    session: &'a Session,
}

impl CheckerHost for SessionHost<'_> {
    fn context(&self) -> Context {
        Context::background()
    }

    fn snapshot(&self, handle: u64) -> CheckerResult<SnapshotScope> {
        let sd = self.session.snapshot_data(handle).map_err(from_api_error)?;
        let snapshot = Arc::clone(&sd.snapshot);
        let registry = Arc::clone(&sd.checker_state.registry);
        // The scope pins `SnapshotData` (and with it the project snapshot) until the request ends.
        Ok(SnapshotScope { handle, snapshot, registry, release: Some(Box::new(move || drop(sd))) })
    }

    fn acquire_cached_source_file(&self, descriptor: &Value) -> CheckerResult<CachedFileScope> {
        let lease = self.session.acquire_cached_source_file(descriptor).map_err(from_api_error)?;
        Ok(CachedFileScope { file: lease.source_file(), release: Some(Box::new(move || lease.release())) })
    }

    fn source_file_descriptor(&self, file: P<SourceFile>) -> CheckerResult<Value> {
        Ok(crate::sourcefiles::source_file_descriptor(file))
    }

    fn source_file_node_id(&self, file: P<SourceFile>) -> CheckerResult<u64> {
        Ok(crate::sourcefiles::source_file_node_id(file))
    }

    fn node_handle(&self, node: P<Node>) -> CheckerResult<String> {
        self.session.node_handle_from(node).map_err(from_api_error)
    }

    fn resolve_node_handle(&self, program: &'static Program, handle: &str) -> CheckerResult<P<Node>> {
        self.session.resolve_node_handle(program, handle).map_err(from_api_error)
    }

    fn encode_node(&self, node: P<Node>) -> CheckerResult<Vec<u8>> {
        self.session.encode_node(node).map_err(from_api_error)
    }

    fn clone_snapshot_with_auto_imports(&self, base: &Snapshot, file_name: &str) -> CheckerResult<Arc<Snapshot>> {
        let file_name = tsrs_core::tspath::get_normalized_absolute_path(file_name, self.session.current_directory());
        let uri = tsrs_ls::lsconv::file_name_to_document_uri(&file_name);
        Ok(self.session.snapshot_host.clone_snapshot_with_auto_imports(&self.context(), base, &uri, None))
    }
}

/// Standard base64 with padding (Go `base64.StdEncoding`).
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod lease_tests;
#[cfg(test)]
mod lifetime_tests;

pub(crate) fn lintrs_typed_methods() -> Vec<&'static str> {
    dispatch::CHECKER_METHODS
        .iter()
        .copied()
        .filter(|method| {
            !matches!(
                *method,
                "typeToTypeNode" | "signatureToSignatureDeclaration"
            )
        })
        .chain([
            "lintrsIsTypeAssignableToMany",
            "lintrsGetContextualTypes",
            "lintrsGetSymbolFacts",
            "lintrsGetAliasedSymbolFacts",
            "lintrsRunNativeRules",
        ])
        .collect()
}

pub(crate) fn lintrs_handle_value(
    session: &Session,
    method: &str,
    params: &Value,
) -> ApiResult<Value> {
    if method == "lintrsRunNativeRules" {
        let Value::Object(fields) = params else {
            return Err(ApiError::invalid_request(
                "Native rules params must be an object",
            ));
        };
        if fields.keys().any(|key| {
            !matches!(key.as_str(), "snapshot" | "project" | "file" | "libraries" | "rules")
        }) {
            return Err(ApiError::invalid_request("Unknown native rules field"));
        }
        let host = SessionHost { session };
        let params = params::Params::new(params, method).map_err(to_api_error)?;
        return lintrs_run_native_rules(&host, &params).map_err(to_api_error);
    }
    if matches!(method, "lintrsGetSymbolFacts" | "lintrsGetAliasedSymbolFacts") {
        let Value::Object(fields) = params else {
            return Err(ApiError::invalid_request(
                "Symbol fact params must be an object",
            ));
        };
        let locations = method == "lintrsGetSymbolFacts";
        if fields.keys().any(|key| {
            !matches!(key.as_str(), "snapshot" | "project" | "includeDeclarations")
                && !(locations && matches!(key.as_str(), "locations" | "resolveAliases"))
                && !(!locations && key == "symbol")
        }) {
            return Err(ApiError::invalid_request("Unknown symbol fact field"));
        }
        if locations && !matches!(fields.get("locations"), Some(Value::Array(_))) {
            return Err(ApiError::invalid_request(
                "Symbol fact locations must be an array",
            ));
        }
        let host = SessionHost { session };
        let params = params::Params::new(params, method).map_err(to_api_error)?;
        return if locations {
            handlers_symbols::lintrs_get_symbol_facts(&host, &params)
        } else {
            handlers_symbols::lintrs_get_aliased_symbol_facts(&host, &params)
        }
        .map_err(to_api_error);
    }
    if method == "lintrsGetContextualTypes" {
        let Value::Object(fields) = params else {
            return Err(ApiError::invalid_request(
                "Contextual type batch params must be an object",
            ));
        };
        if fields
            .keys()
            .any(|key| !matches!(key.as_str(), "snapshot" | "project" | "locations"))
        {
            return Err(ApiError::invalid_request(
                "Unknown contextual type batch field",
            ));
        }
        if !matches!(fields.get("locations"), Some(Value::Array(_))) {
            return Err(ApiError::invalid_request(
                "Contextual type locations must be an array",
            ));
        }
        let host = SessionHost { session };
        let params = params::Params::new(params, method).map_err(to_api_error)?;
        return handlers_types::lintrs_get_contextual_types(&host, &params).map_err(to_api_error);
    }
    if matches!(method, "typeToTypeNode" | "signatureToSignatureDeclaration")
        || (method != "lintrsIsTypeAssignableToMany" && !dispatch::is_checker_method(method))
    {
        return Err(ApiError::unsupported(method));
    }
    let method = if method == "lintrsIsTypeAssignableToMany" {
        let Value::Object(fields) = params else {
            return Err(ApiError::invalid_request(
                "Assignability params must be an object",
            ));
        };
        if fields
            .keys()
            .any(|key| !matches!(key.as_str(), "snapshot" | "project" | "source" | "targets"))
        {
            return Err(ApiError::invalid_request(
                "Unknown assignability batch field",
            ));
        }
        "lintrsIsTypeAssignableToManyNative"
    } else {
        method
    };
    let host = SessionHost { session };
    match dispatch::handle(&host, method, params)
        .ok_or_else(|| ApiError::unsupported(method))?
        .map_err(to_api_error)?
    {
        CheckerResponse::Json(value) => Ok(value),
        CheckerResponse::EncodedNode(_) => Err(ApiError::unsupported(method)),
    }
}

pub(crate) fn lintrs_node_facts(
    session: &Session,
    snapshot: u64,
    project: &str,
    file_path: &str,
    indices: &[u32],
    mask: u32,
) -> ApiResult<Value> {
    lintrs_node_facts_core(session, snapshot, project, file_path, indices, mask, None)
}

pub(crate) fn lintrs_node_facts_planned(
    session: &Session,
    snapshot: u64,
    project: &str,
    file_path: &str,
    indices: &[u32],
    mask: u32,
    symbol_fields: &[String],
) -> ApiResult<Value> {
    if symbol_fields.len() > 4
        || symbol_fields.iter().enumerate().any(|(index, field)| {
            !matches!(
                field.as_str(),
                "name" | "declarations" | "valueDeclaration" | "checkFlags"
            ) || symbol_fields[..index].contains(field)
        })
    {
        return Err(ApiError::invalid_request(
            "nodeFactsPlanned requires at most four unique safe symbol fields",
        ));
    }
    lintrs_node_facts_core(
        session,
        snapshot,
        project,
        file_path,
        indices,
        mask,
        Some(symbol_fields),
    )
}

fn lintrs_node_facts_core(
    session: &Session,
    snapshot: u64,
    project: &str,
    file_path: &str,
    indices: &[u32],
    mask: u32,
    symbol_fields: Option<&[String]>,
) -> ApiResult<Value> {
    if indices.len() > 256 || mask == 0 || mask & !7 != 0 {
        return Err(ApiError::invalid_request(
            "nodeFacts allows at most 256 indices and masks 1 through 7",
        ));
    }
    let host = SessionHost { session };
    let mut setup = setup::Setup::new(&host, snapshot, project).map_err(to_api_error)?;
    let file = setup
        .program
        .get_source_file(file_path)
        .ok_or_else(|| ApiError::client(format!("source file not found: {file_path}")))?;
    let table = session.node_index_table(file);
    let nodes = indices
        .iter()
        .map(|index| {
            tsrs_api_codec::resolve_node_index(&table, *index)
                .ok_or_else(|| ApiError::client(format!("invalid node index {index}")))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let mut out = crate::wire::Obj::new();
    if mask & 1 != 0 {
        let mut values = Vec::with_capacity(nodes.len());
        for node in &nodes {
            let ty = setup.c().get_type_at_location(*node);
            values.push(setup.lintrs_type_handle(ty).map_err(to_api_error)?);
        }
        out = out.set("types", Value::Array(values));
    }
    if mask & 2 != 0 {
        let mut values = Vec::with_capacity(nodes.len());
        for node in &nodes {
            let symbol = setup.c().get_symbol_at_location_exported(*node);
            let Some(symbol) = symbol else {
                values.push(Value::Null);
                continue;
            };
            let mut handle = setup.lintrs_symbol_handle(symbol).map_err(to_api_error)?;
            if let Some(fields) = symbol_fields {
                let mut properties = crate::wire::Obj::new();
                for field in fields {
                    if let Some(value) = setup
                        .lintrs_symbol_property(symbol, field)
                        .map_err(to_api_error)?
                    {
                        properties = properties.set(field, value);
                    }
                }
                let Value::Object(header) = &mut handle else {
                    return Err(ApiError::internal("invalid native symbol header"));
                };
                header.insert("properties".to_owned(), properties.build());
            }
            values.push(handle);
        }
        out = out.set("symbols", Value::Array(values));
    }
    if mask & 4 != 0 {
        let mut values = Vec::with_capacity(nodes.len());
        for node in &nodes {
            let ty = setup
                .c()
                .get_contextual_type_exported(*node, tsrs_checker::ContextFlags::None);
            values.push(
                ty.map_or(Ok(Value::Null), |ty| setup.lintrs_type_handle(ty))
                    .map_err(to_api_error)?,
            );
        }
        out = out.set("contextualTypes", Value::Array(values));
    }
    Ok(out.build())
}

pub(crate) fn lintrs_object_property(
    session: &Session,
    snapshot: u64,
    project: &str,
    kind: &str,
    handle: &Value,
    property: &str,
) -> ApiResult<Option<Value>> {
    let host = SessionHost { session };
    let mut setup = setup::Setup::new(&host, snapshot, project).map_err(to_api_error)?;
    let mut fields = tsrs_core::collections::OrderedMap::default();
    match kind {
        "type" => {
            fields.insert("id".to_owned(), handle.clone());
            let value = Value::Object(fields);
            let params = params::Params::new(&value, "objectProperty").map_err(to_api_error)?;
            let ty = setup
                .resolve_type(params.u32("id").map_err(to_api_error)?)
                .map_err(to_api_error)?;
            setup
                .lintrs_type_property(ty, property)
                .map_err(to_api_error)
        }
        "symbol" => {
            fields.insert("symbol".to_owned(), handle.clone());
            let value = Value::Object(fields);
            let params = params::Params::new(&value, "objectProperty").map_err(to_api_error)?;
            let symbol = setup
                .resolve_symbol(&params.symbol_ref("symbol").map_err(to_api_error)?)
                .map_err(to_api_error)?;
            setup
                .lintrs_symbol_property(symbol, property)
                .map_err(to_api_error)
        }
        _ => Err(ApiError::invalid_request("Unknown native object kind")),
    }
}

pub(crate) fn lintrs_run_native_rules(
    host: &dyn CheckerHost,
    p: &params::Params,
) -> CheckerResult<Value> {
    use crate::native_rules::{
        LintrsNativeCall, LintrsNativeRuleSpec, native_rules_runner,
    };
    let libraries: Vec<String> = p
        .string_array("libraries")?
        .iter()
        .map(|library| (*library).to_string())
        .collect();
    let specs = match p.raw("rules") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Object(fields) => {
                    let Some(Value::String(name)) = fields.get("name") else {
                        return Err(CheckerError::invalid("rule name must be a string"));
                    };
                    let Some(Value::String(id)) = fields.get("id") else {
                        return Err(CheckerError::invalid("rule id must be a string"));
                    };
                    Ok(LintrsNativeRuleSpec {
                        name: name.clone(),
                        id: id.clone(),
                        options: fields.get("options").cloned().unwrap_or(Value::Null),
                    })
                }
                _ => Err(CheckerError::invalid("rule spec must be an object")),
            })
            .collect::<CheckerResult<Vec<_>>>()?,
        _ => return Err(CheckerError::invalid("rules must be an array")),
    };
    let mut s = setup::Setup::new(host, p.u64("snapshot")?, p.project()?)?;
    // files_by_path keys are the program's canonical (possibly case-folded)
    // paths, so go through the program's own to_path normalization.
    let source_file = s
        .program
        .get_source_file_by_path(&s.program.to_path(p.string("file")?))
        .ok_or_else(|| {
            CheckerError::client("the file is not included in a TypeScript project")
        })?;
    let runner = native_rules_runner()
        .ok_or_else(|| CheckerError::client("the native rules runner is not registered"))?;
    let program = s.program;
    let mut call = LintrsNativeCall {
        checker: s.c(),
        program,
        source_file,
    };
    // SAFETY: the runner is the one lintrs registers (lintrs::native::run). It
    // is unsafe because it calls into native rule libraries, which lintrs only
    // loads after checking their ABI fingerprint against this process. `call`
    // borrows the checker `s` holds exclusively for the whole call.
    let diagnostics = unsafe { runner(&mut call, &specs, &libraries) }
        .map_err(|error| CheckerError::client(format!("native rules: {error}")))?;
    Ok(Value::Array(
        diagnostics
            .into_iter()
            .map(|diagnostic| {
                let mut o = json::Obj::new();
                o.str_nonempty("ruleId", &diagnostic.rule_id);
                o.str_nonempty("message", &diagnostic.message);
                o.num("pos", diagnostic.pos as f64);
                o.num("end", diagnostic.end as f64);
                if let Some(fix) = diagnostic.fix {
                    let mut f = json::Obj::new();
                    f.num("pos", fix.pos as f64);
                    f.num("end", fix.end as f64);
                    f.str_nonempty("text", &fix.text);
                    o.set("fix", f.build());
                }
                if !diagnostic.suggestions.is_empty() {
                    o.set(
                        "suggestions",
                        Value::Array(
                            diagnostic
                                .suggestions
                                .into_iter()
                                .map(|suggestion| {
                                    let mut o = json::Obj::new();
                                    o.str_nonempty("desc", &suggestion.desc);
                                    let mut f = json::Obj::new();
                                    f.num("pos", suggestion.fix.pos as f64);
                                    f.num("end", suggestion.fix.end as f64);
                                    f.str_nonempty("text", &suggestion.fix.text);
                                    o.set("fix", f.build());
                                    o.build()
                                })
                                .collect(),
                        ),
                    );
                }
                o.build()
            })
            .collect(),
    ))
}

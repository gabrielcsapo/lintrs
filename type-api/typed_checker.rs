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

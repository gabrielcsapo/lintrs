#[derive(Default)]
struct LintrsDeclarationHeaders {
    headers: Vec<Value>,
    seen: rustc_hash::FxHashSet<String>,
    position_maps: rustc_hash::FxHashMap<usize, std::sync::Arc<tsrs_api_codec::PositionMap>>,
}

impl LintrsDeclarationHeaders {
    fn append(&mut self, setup: &Setup<'_>, symbol: P<Symbol>) -> CheckerResult<()> {
        for node in symbol
            .declarations()
            .iter()
            .copied()
            .chain(symbol.value_declaration())
        {
            let id = setup.sd.host.node_handle(node)?;
            if !self.seen.insert(id.clone()) {
                continue;
            }
            let file = tsrs_ast::get_source_file_of_node(node)
                .ok_or_else(|| CheckerError::client("declaration has no source file"))?;
            let positions = match self.position_maps.entry(file.as_node().addr()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                    setup
                        .sd
                        .scope
                        .registry
                        .compact_declaration_positions(file)?,
                ),
            };
            let mut header = super::json::Obj::new();
            header.set("id", Value::String(id));
            header.num("kind", node.kind() as u32 as f64);
            header.num(
                "pos",
                positions.utf8_to_utf16(node.pos() as i64) as u32 as f64,
            );
            header.num(
                "end",
                positions.utf8_to_utf16(node.end() as i64) as u32 as f64,
            );
            header.num("flags", node.flags().bits() as f64);
            if matches!(
                node.kind(),
                tsrs_ast::Kind::Identifier | tsrs_ast::Kind::StringLiteral
            ) {
                header.set("text", Value::String(node.text().to_owned()));
            }
            self.headers.push(header.build());
        }
        Ok(())
    }
}

pub(crate) fn lintrs_get_symbol_facts(host: &dyn CheckerHost, p: &Params) -> CheckerResult<Value> {
    let locations = p.string_array("locations")?;
    if locations.len() > 256 {
        return Err(CheckerError::invalid(
            "Symbol fact batches allow at most 256 locations",
        ));
    }
    let resolve_aliases = p.bool("resolveAliases")?;
    let include_declarations =
        p.raw("includeDeclarations").is_none() || p.bool("includeDeclarations")?;
    let mut s = setup(host, p)?;
    let nodes = locations
        .into_iter()
        .map(|location| s.resolve_node(location))
        .collect::<CheckerResult<Vec<_>>>()?;
    let mut declarations = LintrsDeclarationHeaders::default();
    let mut results = Vec::with_capacity(nodes.len());
    for node in nodes {
        let mut result = super::json::Obj::new();
        let symbol = s.c().get_symbol_at_location_exported(node);
        result.set("symbol", s.opt_symbol_response(symbol)?);
        if let Some(symbol) = symbol {
            if include_declarations {
                declarations.append(&s, symbol)?;
            }
            if resolve_aliases && symbol.flags().intersects(SymbolFlags::Alias) {
                let alias = s.c().get_aliased_symbol(symbol);
                result.set("alias", s.symbol_response(alias)?);
                if include_declarations {
                    declarations.append(&s, alias)?;
                }
            }
        }
        results.push(result.build());
    }
    Ok(crate::wire::Obj::new()
        .set("results", Value::Array(results))
        .set("declarations", Value::Array(declarations.headers))
        .build())
}

pub(crate) fn lintrs_get_aliased_symbol_facts(
    host: &dyn CheckerHost,
    p: &Params,
) -> CheckerResult<Value> {
    let include_declarations =
        p.raw("includeDeclarations").is_none() || p.bool("includeDeclarations")?;
    let mut s = setup(host, p)?;
    let symbol = s.resolve_symbol(&p.symbol_ref("symbol")?)?;
    let alias = s.c().get_aliased_symbol(symbol);
    let response = s.symbol_response(alias)?;
    let mut declarations = LintrsDeclarationHeaders::default();
    if include_declarations {
        declarations.append(&s, alias)?;
    }
    Ok(crate::wire::Obj::new()
        .set("symbol", response)
        .set("declarations", Value::Array(declarations.headers))
        .build())
}

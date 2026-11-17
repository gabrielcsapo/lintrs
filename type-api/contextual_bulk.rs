pub(crate) fn lintrs_get_contextual_types(
    host: &dyn CheckerHost,
    p: &Params,
) -> CheckerResult<Value> {
    let locations = p.string_array("locations")?;
    if locations.len() > 256 {
        return Err(CheckerError::invalid(
            "Contextual type batches allow at most 256 locations",
        ));
    }
    let mut s = setup(host, p)?;
    let nodes = locations
        .into_iter()
        .map(|location| s.resolve_node(location))
        .collect::<CheckerResult<Vec<_>>>()?;
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        let ty = s.c().get_contextual_type_exported(node, ContextFlags::None);
        out.push(s.opt_type_response(ty)?);
    }
    Ok(Value::Array(out))
}

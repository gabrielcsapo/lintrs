pub(crate) fn rlint_is_type_assignable_to_many(
    host: &dyn CheckerHost,
    p: &Params,
) -> CheckerResult<Value> {
    let targets = p.u32_array("targets")?;
    if targets.len() > 64 {
        return Err(CheckerError::invalid(
            "Assignability batches allow at most 64 targets",
        ));
    }
    let mut s = setup(host, p)?;
    let source = s.resolve_type(p.u32("source")?)?;
    let targets = targets
        .into_iter()
        .map(|target| s.resolve_type(target))
        .collect::<CheckerResult<Vec<_>>>()?;
    Ok(Value::Array(
        targets
            .into_iter()
            .map(|target| Value::Bool(s.c().is_type_assignable_to_exported(source, target)))
            .collect(),
    ))
}

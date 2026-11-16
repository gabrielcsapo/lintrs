/// Full index using the same visitor and ownership checks as the original single-ID search.
pub(crate) fn build_source_file_symbol_index(file: P<SourceFile>) -> FxHashMap<u64, P<Symbol>> {
    let mut search = Search {
        file,
        id: 0,
        seen: FxHashSet::default(),
        found: None,
        collected: Some(FxHashMap::default()),
    };
    search.visit(file.as_node());
    if let Some(globals) = file.global_exports() {
        for symbol in globals.values() {
            search.add(Some(symbol));
        }
    }
    for module in file.pattern_ambient_modules() {
        search.add(Some(module.symbol));
    }
    search.collected.unwrap_or_default()
}

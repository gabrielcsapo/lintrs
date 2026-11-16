impl CheckerRegistry {
    pub(crate) fn cached_file_symbol(
        &self,
        file: P<tsrs_ast::SourceFile>,
        id: u64,
    ) -> CheckerResult<Option<P<Symbol>>> {
        let mut state = self.lock();
        Self::check_live(&state)?;
        if !file.is_bound() {
            // An unbound file may acquire binder symbols later. Do not retain an incomplete index.
            drop(state);
            return Ok(super::symbol_index::source_file_symbol(file, id));
        }
        let index = state
            .file_symbols
            .entry(file.as_node().addr())
            .or_insert_with(|| super::symbol_index::build_source_file_symbol_index(file));
        Ok(index.get(&id).copied())
    }

    #[cfg(test)]
    pub(crate) fn file_symbol_cache_count(&self) -> usize {
        self.lock().file_symbols.len()
    }
}

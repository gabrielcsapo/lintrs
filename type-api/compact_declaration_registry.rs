impl CheckerRegistry {
    pub(crate) fn compact_declaration_positions(
        &self,
        file: P<tsrs_ast::SourceFile>,
    ) -> CheckerResult<std::sync::Arc<tsrs_api_codec::PositionMap>> {
        let mut state = self.lock();
        Self::check_live(&state)?;
        let id = tsrs_ast::get_node_id(file.as_node()).0;
        let positions = state
            .compact_declaration_positions
            .entry(id)
            .or_insert_with(|| {
                std::sync::Arc::new(tsrs_api_codec::PositionMap::compute(file.text()))
            });
        Ok(std::sync::Arc::clone(positions))
    }
}

impl Session {
    pub fn lintrs_typed_methods(&self) -> Vec<&'static str> {
        crate::checker::lintrs_typed_methods()
    }

    pub fn lintrs_typed_query(&self, method: &str, params: &Value) -> ApiResult<Value> {
        if *self.closed.lock().unwrap() {
            return Err(ApiError::client("session is closed"));
        }
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::checker::lintrs_handle_value(self, method, params)
        })) {
            Ok(result) => result,
            Err(_) => Err(ApiError::internal("panic in typed checker query")),
        }
    }

    pub fn lintrs_node_facts(
        &self,
        snapshot: u64,
        project: &str,
        file: &str,
        indices: &[u32],
        mask: u32,
    ) -> ApiResult<Value> {
        if *self.closed.lock().unwrap() {
            return Err(ApiError::client("session is closed"));
        }
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::checker::lintrs_node_facts(self, snapshot, project, file, indices, mask)
        })) {
            Ok(result) => result,
            Err(_) => Err(ApiError::internal("panic in native node facts")),
        }
    }

    pub fn lintrs_node_facts_planned(
        &self,
        snapshot: u64,
        project: &str,
        file: &str,
        indices: &[u32],
        mask: u32,
        symbol_fields: &[String],
    ) -> ApiResult<Value> {
        if *self.closed.lock().unwrap() {
            return Err(ApiError::client("session is closed"));
        }
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::checker::lintrs_node_facts_planned(
                self,
                snapshot,
                project,
                file,
                indices,
                mask,
                symbol_fields,
            )
        })) {
            Ok(result) => result,
            Err(_) => Err(ApiError::internal("panic in planned native node facts")),
        }
    }

    pub fn lintrs_object_property(
        &self,
        snapshot: u64,
        project: &str,
        kind: &str,
        handle: &Value,
        property: &str,
    ) -> ApiResult<Option<Value>> {
        if *self.closed.lock().unwrap() {
            return Err(ApiError::client("session is closed"));
        }
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::checker::lintrs_object_property(self, snapshot, project, kind, handle, property)
        })) {
            Ok(result) => result,
            Err(_) => Err(ApiError::internal("panic in native object property")),
        }
    }
}

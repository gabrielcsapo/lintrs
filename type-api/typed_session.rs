impl Session {
    pub fn rlint_typed_methods(&self) -> Vec<&'static str> {
        crate::checker::rlint_typed_methods()
    }

    pub fn rlint_typed_query(&self, method: &str, params: &Value) -> ApiResult<Value> {
        if *self.closed.lock().unwrap() {
            return Err(ApiError::client("session is closed"));
        }
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::checker::rlint_handle_value(self, method, params)
        })) {
            Ok(result) => result,
            Err(_) => Err(ApiError::internal("panic in typed checker query")),
        }
    }

    pub fn rlint_node_facts(
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
            crate::checker::rlint_node_facts(self, snapshot, project, file, indices, mask)
        })) {
            Ok(result) => result,
            Err(_) => Err(ApiError::internal("panic in native node facts")),
        }
    }

    pub fn rlint_node_facts_planned(
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
            crate::checker::rlint_node_facts_planned(
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

    pub fn rlint_object_property(
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
            crate::checker::rlint_object_property(self, snapshot, project, kind, handle, property)
        })) {
            Ok(result) => result,
            Err(_) => Err(ApiError::internal("panic in native object property")),
        }
    }
}

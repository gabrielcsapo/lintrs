impl CheckerRegistry {
    pub(crate) fn acquire_checker_gate(
        &self,
        program: &'static tsrs_compiler::Program,
    ) -> CheckerResult<super::lease::ApiCheckerLease> {
        let pin = {
            let mut state = self.lock();
            Self::check_live(&state)?;
            std::sync::Arc::clone(
                state
                    .checker_gates
                    .entry(std::ptr::from_ref(program) as usize)
                    .or_insert_with(|| std::sync::Arc::new(super::lease::pin(program))),
            )
        };
        pin.acquire()
    }
}

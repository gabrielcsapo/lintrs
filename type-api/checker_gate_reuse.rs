fn forget_if_unused(key: usize, gate: Arc<Gate>) {
    let mut gates = lock_gates();
    if Arc::strong_count(&gate) == 2
        && !gate
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .held
    {
        if let Some(map) = gates.as_mut() {
            map.remove(&key);
        }
    }
    // Serialize the decrement too: concurrent final owners must not both observe another owner
    // about to disappear and leave the map as the only remaining reference.
    drop(gate);
}

impl Drop for ApiCheckerLease {
    fn drop(&mut self) {
        let Some(gate) = self.gate.take() else { return };
        {
            let mut state = gate.state.lock().unwrap_or_else(|error| error.into_inner());
            state.held = false;
            state.holder = None;
        }
        gate.released.notify_all();
        if let Some(pin) = self.pin.take() {
            // Keep the pin alive until this lease's gate reference is gone. Its final drop performs
            // global cleanup; a live snapshot pin makes that unnecessary on ordinary requests.
            drop(gate);
            drop(pin);
        } else {
            forget_if_unused(self.key, gate);
        }
    }
}

pub(crate) struct ApiCheckerGatePin {
    key: usize,
    gate: Option<Arc<Gate>>,
}

impl ApiCheckerGatePin {
    pub(crate) fn acquire(self: Arc<Self>) -> CheckerResult<ApiCheckerLease> {
        let gate = self
            .gate
            .as_ref()
            .ok_or_else(|| CheckerError::client("checker gate pin has been released"))?;
        let mut lease = acquire_gate(self.key, Arc::clone(gate))?;
        lease.pin = Some(self);
        Ok(lease)
    }
}

impl Drop for ApiCheckerGatePin {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.take() {
            forget_if_unused(self.key, gate);
        }
    }
}

pub(crate) fn pin(program: &'static Program) -> ApiCheckerGatePin {
    let key = std::ptr::from_ref::<Program>(program) as usize;
    let gate = Arc::clone(
        lock_gates()
            .get_or_insert_with(FxHashMap::default)
            .entry(key)
            .or_default(),
    );
    ApiCheckerGatePin {
        key,
        gate: Some(gate),
    }
}

pub(crate) fn reuse_enabled() -> bool {
    static ENABLED: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
        std::env::var_os("RLINT_REUSE_CHECKER_GATE").is_some_and(|value| value == "1")
    });
    *ENABLED
}

#[cfg(test)]
pub(crate) fn is_tracked(program: &'static Program) -> bool {
    lock_gates()
        .as_ref()
        .is_some_and(|map| map.contains_key(&(std::ptr::from_ref::<Program>(program) as usize)))
}

#[cfg(test)]
pub(crate) fn gate_address(lease: &ApiCheckerLease) -> usize {
    Arc::as_ptr(lease.gate.as_ref().unwrap()) as usize
}

// Modified by lintrs: see vendor/tsrs_api/README.md.
// Re-entrancy guard for the program's persistent API checker (Go `CheckerLifetimeAPI`).
//
// The API checker is a single exclusive slot per program (`checkerPool.persistentSem`). Pinned Go blocks
// on it unconditionally; if a request holding it is waiting for a client callback (sync MessagePack: on
// the same thread; async: another request) and the client issues a nested request that needs the same
// checker, nothing can make progress. Before taking the slot, the checker lane takes this per-program
// gate instead, using the transport's holder-aware per-acquisition contention state
// (`tsrs_api_transport::{Holder, ContentionWait}`, see the transport's INTEGRATION.md):
// - the acquiring request records `Holder::current()` with the gate and clears it on release;
// - an uncontended acquisition proceeds immediately;
// - a contended acquisition uses one `ContentionWait` for its whole wait, updated whenever the holder
//   changes, and waits like Go while the holder makes progress; it fails with the transport's bounded
//   re-entrancy error only when `may_deadlock()` says the holder is possibly stuck on the client
//   (immediately on sync connections, after the connection's grace period on async ones, measured for
//   this acquisition only).
// Outside a transport request (tests, in-process callers) it is a plain blocking lock.
//
// The gate map is keyed by the program's address. Entries are only created and used while the
// requesting snapshot keeps that program alive, and an entry is removed as soon as no lease or waiter
// or snapshot pin refers to it. Snapshot registries release pins before releasing their programs.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rustc_hash::FxHashMap;
use tsrs_api_transport::{ContentionWait, Holder};
use tsrs_compiler::Program;

use super::host::{CheckerError, CheckerErrorKind, CheckerResult};

#[derive(Default)]
struct GateState {
    held: bool,
    /// The request holding the gate (None when held outside a transport request).
    holder: Option<Holder>,
}

#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    released: Condvar,
}

static GATES: Mutex<Option<FxHashMap<usize, Arc<Gate>>>> = Mutex::new(None);

fn lock_gates() -> std::sync::MutexGuard<'static, Option<FxHashMap<usize, Arc<Gate>>>> {
    GATES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Exclusive right to acquire the program's API checker; released on drop.
pub(crate) struct ApiCheckerLease {
    key: usize,
    gate: Option<Arc<Gate>>,
    pin: Option<Arc<ApiCheckerGatePin>>,
}

const RESOURCE: &str = "the program's API checker";

pub(crate) fn acquire(program: &'static Program) -> CheckerResult<ApiCheckerLease> {
    let key = std::ptr::from_ref::<Program>(program) as usize;
    let gate = Arc::clone(lock_gates().get_or_insert_with(FxHashMap::default).entry(key).or_default());
    acquire_gate(key, gate)
}

fn acquire_gate(key: usize, gate: Arc<Gate>) -> CheckerResult<ApiCheckerLease> {
    let result = (|| {
        let mut st = gate.state.lock().unwrap_or_else(|e| e.into_inner());
        // One contention state per acquisition (created on first contention, dropped when this
        // acquisition ends, which also clears this request's wait-for edge).
        let mut wait: Option<ContentionWait> = None;
        loop {
            if !st.held {
                st.held = true;
                st.holder = Holder::current();
                return Ok(());
            }
            let Some(cx) = tsrs_api_transport::current_request() else {
                st = gate.released.wait(st).unwrap_or_else(|e| e.into_inner());
                continue;
            };
            let w = wait.get_or_insert_with(|| ContentionWait::new(st.holder.as_ref()));
            w.set_holder(st.holder.as_ref());
            if w.may_deadlock() {
                return Err(CheckerError { kind: CheckerErrorKind::Internal, message: tsrs_api_transport::reentrancy::reentrancy_error(RESOURCE).message });
            }
            if cx.cancel.is_cancelled() {
                return Err(CheckerError { kind: CheckerErrorKind::Internal, message: "ipc: connection closed".to_string() });
            }
            // Re-check shortly: the holder may start or stop waiting on the client while we wait.
            st = gate.released.wait_timeout(st, Duration::from_millis(2)).unwrap_or_else(|e| e.into_inner()).0;
        }
    })();
    match result {
        Ok(()) => Ok(ApiCheckerLease { key, gate: Some(gate), pin: None }),
        Err(e) => {
            forget_if_unused(key, gate);
            Err(e)
        }
    }
}

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
        std::env::var_os("LINTRS_REUSE_CHECKER_GATE").is_some_and(|value| value == "1")
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

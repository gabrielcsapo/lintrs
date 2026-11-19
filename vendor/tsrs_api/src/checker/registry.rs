// Modified by lintrs: see vendor/tsrs_api/README.md.
// Port of the registries in Go `snapshotData` / `projectRegistryData` (tsc/internal/api/session.go).
//
// Symbol ids come from `tsrs_ast::get_symbol_id` (a process-wide counter, like Go `ast.GetSymbolId`), so
// snapshot-owned symbols are registered snapshot-wide. Type and signature ids are per-checker sequential
// ids, so they are registered per project, and additionally pinned to the id of the API checker that
// produced them: if the project's persistent API checker is replaced (e.g. after cancellation), every
// handle produced by the old checker becomes a stale-handle client error instead of silently resolving
// against a different checker.
//
// Raw pointers in here are only valid while the owning snapshot is retained. `release()` runs when the
// snapshot's `SnapshotData` is dropped (`CheckerSnapshotState::drop`, right after `SnapshotData::drop` derefs the
// project snapshot); no request can reach the registry by then, and after release every lookup fails.

use std::sync::Mutex;

use rustc_hash::FxHashMap;
use tsrs_ast::Symbol;
use tsrs_checker::{Signature, Type};
use tsrs_core::P;

use super::host::{CheckerError, CheckerResult};

#[derive(Default)]
struct ProjectRegistry {
    checker_id: u32,
    types: FxHashMap<u32, P<Type>>,
    signatures: FxHashMap<u64, P<Signature>>,
    native_rules: std::sync::Arc<crate::native_rules::NativeRuleState>,
}

#[derive(Default)]
struct RegistryState {
    released: bool,
    symbols: FxHashMap<u64, P<Symbol>>,
    file_symbols: FxHashMap<usize, FxHashMap<u64, P<Symbol>>>,
    compact_declaration_positions: FxHashMap<u64, std::sync::Arc<tsrs_api_codec::PositionMap>>,
    checker_gates: FxHashMap<usize, std::sync::Arc<super::lease::ApiCheckerGatePin>>,
    // Go `symbolCanonicalProjects`: first writer wins.
    symbol_projects: FxHashMap<u64, String>,
    projects: FxHashMap<String, ProjectRegistry>,
    // Snapshots derived during a request (auto-import preparation) whose symbols were handed out;
    // dereferenced on release so those pointers stay valid exactly as long as the registry.
    retained: Vec<std::sync::Arc<tsrs_project::Snapshot>>,
}

#[derive(Default)]
pub struct CheckerRegistry {
    state: Mutex<RegistryState>,
}

impl CheckerRegistry {
    #[cfg(test)]
    pub fn new() -> CheckerRegistry {
        CheckerRegistry::default()
    }

    /// Drops every registered pointer. Runs when the snapshot's `SnapshotData` is dropped.
    pub fn release(&self) {
        let mut st = self.lock();
        st.released = true;
        st.symbols = FxHashMap::default();
        st.file_symbols = FxHashMap::default();
        st.compact_declaration_positions = FxHashMap::default();
        st.symbol_projects = FxHashMap::default();
        st.projects = FxHashMap::default();
        let checker_gates = std::mem::take(&mut st.checker_gates);
        let retained = std::mem::take(&mut st.retained);
        drop(st);
        drop(checker_gates);
        for snapshot in retained {
            snapshot.deref();
        }
    }

    /// Takes over one reference of `snapshot` until `release` (see `retained`).
    pub fn retain_snapshot(&self, snapshot: std::sync::Arc<tsrs_project::Snapshot>) -> CheckerResult<()> {
        let mut st = self.lock();
        if st.released {
            drop(st);
            snapshot.deref();
            return Err(CheckerError::client("snapshot has been released"));
        }
        st.retained.push(snapshot);
        Ok(())
    }

    #[cfg(test)]
    pub fn is_released(&self) -> bool {
        self.lock().released
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        // A panic while holding this short-lived lock cannot leave the maps half-updated in a way that
        // matters (every operation is a single insert/lookup), so recover from poisoning.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn check_live(st: &RegistryState) -> CheckerResult<()> {
        if st.released {
            return Err(CheckerError::client("snapshot has been released"));
        }
        Ok(())
    }

    /// Go `registerSymbol`. Returns the symbol id and its canonical project.
    pub fn register_symbol(&self, symbol: P<Symbol>, canonical_project: &str) -> CheckerResult<(u64, String)> {
        assert!(!canonical_project.is_empty(), "registerSymbol requires a non-empty canonical project");
        let id = tsrs_ast::get_symbol_id(symbol).0;
        let mut st = self.lock();
        Self::check_live(&st)?;
        match st.symbols.get(&id) {
            Some(existing) => assert!(*existing == symbol, "duplicate symbol"),
            None => {
                st.symbols.insert(id, symbol);
            }
        }
        let project = st.symbol_projects.entry(id).or_insert_with(|| canonical_project.to_string()).clone();
        Ok((id, project))
    }

    /// Go `resolveSymbolHandle`.
    pub fn resolve_symbol(&self, id: u64) -> CheckerResult<P<Symbol>> {
        if id == 0 {
            return Err(CheckerError::client("empty symbol handle"));
        }
        let st = self.lock();
        Self::check_live(&st)?;
        st.symbols.get(&id).copied().ok_or_else(|| CheckerError::client(format!("symbol handle {id} not found in snapshot registry")))
    }

    fn project_for_checker<'a>(st: &'a mut RegistryState, project: &str, checker_id: u32) -> &'a mut ProjectRegistry {
        let reg = st.projects.entry(project.to_string()).or_default();
        if reg.checker_id != checker_id {
            // The project's API checker changed: handles from the previous checker are stale.
            *reg = ProjectRegistry { checker_id, ..Default::default() };
        }
        reg
    }

    pub fn native_rule_state(&self, project: &str, checker_id: u32) -> CheckerResult<std::sync::Arc<crate::native_rules::NativeRuleState>> {
        let mut st = self.lock();
        Self::check_live(&st)?;
        Ok(std::sync::Arc::clone(&Self::project_for_checker(&mut st, project, checker_id).native_rules))
    }

    /// Go `registerType`. `checker_id` is the id of the API checker that produced `t`.
    pub fn register_type(&self, project: &str, checker_id: u32, t: P<Type>) -> CheckerResult<u32> {
        assert!(!project.is_empty(), "registerType: empty project ID");
        let id = t.id().0;
        let mut st = self.lock();
        Self::check_live(&st)?;
        let reg = Self::project_for_checker(&mut st, project, checker_id);
        match reg.types.get(&id) {
            Some(existing) => assert!(*existing == t, "duplicate type"),
            None => {
                reg.types.insert(id, t);
            }
        }
        Ok(id)
    }

    /// Go `resolveTypeHandle`. With `checker_id = Some(id)` the handle must come from that checker.
    pub fn resolve_type(&self, project: &str, id: u32, checker_id: Option<u32>) -> CheckerResult<P<Type>> {
        if id == 0 {
            return Err(CheckerError::client("empty type handle"));
        }
        if project.is_empty() {
            return Err(CheckerError::client(format!("empty project ID for type handle {id}")));
        }
        let st = self.lock();
        Self::check_live(&st)?;
        let Some(reg) = st.projects.get(project) else {
            return Err(CheckerError::client(format!("type handle {id} not found (no registry for project {project})")));
        };
        if checker_id.is_some_and(|c| c != reg.checker_id) {
            return Err(CheckerError::client(format!("type handle {id} is stale (the project's API checker was replaced)")));
        }
        reg.types.get(&id).copied().ok_or_else(|| CheckerError::client(format!("type handle {id} not found in project registry")))
    }

    /// Go `registerSignature`.
    pub fn register_signature(&self, project: &str, checker_id: u32, sig: P<Signature>) -> CheckerResult<u64> {
        assert!(!project.is_empty(), "registerSignature: empty project ID");
        let id = sig.id().0 as u64;
        let mut st = self.lock();
        Self::check_live(&st)?;
        let reg = Self::project_for_checker(&mut st, project, checker_id);
        match reg.signatures.get(&id) {
            Some(existing) => assert!(*existing == sig, "duplicate signature"),
            None => {
                reg.signatures.insert(id, sig);
            }
        }
        Ok(id)
    }

    /// Go `resolveSignatureHandle`.
    pub fn resolve_signature(&self, project: &str, id: u64, checker_id: Option<u32>) -> CheckerResult<P<Signature>> {
        if id == 0 {
            return Err(CheckerError::client("empty signature handle"));
        }
        if project.is_empty() {
            return Err(CheckerError::client(format!("empty project ID for signature handle {id}")));
        }
        let st = self.lock();
        Self::check_live(&st)?;
        let Some(reg) = st.projects.get(project) else {
            return Err(CheckerError::client(format!("signature handle {id} not found (no registry for project {project})")));
        };
        if checker_id.is_some_and(|c| c != reg.checker_id) {
            return Err(CheckerError::client(format!("signature handle {id} is stale (the project's API checker was replaced)")));
        }
        reg.signatures.get(&id).copied().ok_or_else(|| CheckerError::client(format!("signature handle {id} not found in project registry")))
    }

    /// Checker that produced the project's registered types/signatures (0 if none yet).
    pub fn project_checker_id(&self, project: &str) -> u32 {
        self.lock().projects.get(project).map_or(0, |r| r.checker_id)
    }
}

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

#[cfg(test)]
mod lintrs_native_cache_tests {
    use super::CheckerRegistry;
    use std::sync::Arc;

    #[test]
    fn lintrs_native_cache_reuses_only_the_same_snapshot_project_and_checker() {
        let first = CheckerRegistry::new();
        let state = first.native_rule_state("project", 1).unwrap();
        *state.cache::<usize>("rule/options").lock().unwrap() = 7;
        let same = first.native_rule_state("project", 1).unwrap();
        assert!(Arc::ptr_eq(&state, &same));
        assert_eq!(*same.cache::<usize>("rule/options").lock().unwrap(), 7);
        assert_eq!(*same.cache::<usize>("other-rule/options").lock().unwrap(), 0);
        assert!(same.cache::<String>("rule/options").lock().unwrap().is_empty());

        for isolated in [
            first.native_rule_state("other-project", 1).unwrap(),
            CheckerRegistry::new().native_rule_state("project", 1).unwrap(),
            first.native_rule_state("project", 2).unwrap(),
        ] {
            assert_eq!(*isolated.cache::<usize>("rule/options").lock().unwrap(), 0);
        }
    }

    #[test]
    fn lintrs_native_cache_is_dropped_on_snapshot_release() {
        let registry = CheckerRegistry::new();
        let state = registry.native_rule_state("project", 1).unwrap();
        let weak = Arc::downgrade(&state);
        drop(state);
        registry.release();
        assert!(weak.upgrade().is_none());
        assert!(registry.native_rule_state("project", 1).is_err());
    }
}

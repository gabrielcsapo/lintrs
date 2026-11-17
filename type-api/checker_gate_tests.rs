#[test]
fn lintrs_gate_cache_shares_identity_and_releases_after_the_last_snapshot_and_lease() {
    let s = session_with(&[], &["/p/tsconfig.json"]);
    let sd = s.session.snapshot_data(s.snapshot as u64).unwrap();
    let program = sd
        .get_program(&tsrs_project::ID(s.project.clone()))
        .unwrap();
    let first = super::registry::CheckerRegistry::new();
    let second = super::registry::CheckerRegistry::new();
    let initial = first.acquire_checker_gate(program).unwrap();
    let address = lease::gate_address(&initial);
    drop(initial);
    assert!(lease::is_tracked(program));
    for _ in 0..10 {
        let next = first.acquire_checker_gate(program).unwrap();
        assert_eq!(lease::gate_address(&next), address);
    }
    let shared = second.acquire_checker_gate(program).unwrap();
    assert_eq!(lease::gate_address(&shared), address);
    drop(shared);
    first.release();
    assert!(first.acquire_checker_gate(program).is_err());
    assert!(lease::is_tracked(program));
    let last = second.acquire_checker_gate(program).unwrap();
    second.release();
    assert!(second.acquire_checker_gate(program).is_err());
    assert!(lease::is_tracked(program));
    drop(last);
    assert!(!lease::is_tracked(program));
}

#[test]
fn lintrs_cached_and_uncached_gate_acquisitions_contend_on_the_same_gate() {
    bounded("cached gate contention", Duration::from_secs(10), || {
        let s = session_with(&[], &["/p/tsconfig.json"]);
        let sd = s.session.snapshot_data(s.snapshot as u64).unwrap();
        let program = sd
            .get_program(&tsrs_project::ID(s.project.clone()))
            .unwrap();
        let registry = super::registry::CheckerRegistry::new();
        let holder = registry.acquire_checker_gate(program).unwrap();
        let address = lease::gate_address(&holder);
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            started_tx.send(()).unwrap();
            let waiter = lease::acquire(program).unwrap();
            acquired_tx.send(lease::gate_address(&waiter)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            acquired_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        drop(holder);
        assert_eq!(
            acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            address
        );
        waiter.join().unwrap();
        registry.release();
        assert!(!lease::is_tracked(program));
    });
}

#[test]
fn lintrs_concurrent_final_gate_pins_leave_no_global_entry() {
    let s = session_with(&[], &["/p/tsconfig.json"]);
    let sd = s.session.snapshot_data(s.snapshot as u64).unwrap();
    let program = sd
        .get_program(&tsrs_project::ID(s.project.clone()))
        .unwrap();
    for _ in 0..64 {
        let first = lease::pin(program);
        let second = lease::pin(program);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        thread::scope(|scope| {
            let other = Arc::clone(&barrier);
            scope.spawn(move || {
                other.wait();
                drop(first);
            });
            scope.spawn(move || {
                barrier.wait();
                drop(second);
            });
        });
        assert!(!lease::is_tracked(program));
    }
}

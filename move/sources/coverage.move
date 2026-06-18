/// Sequence-gap detection heartbeat (spec §4.1, §10.1).
///
/// `CoverageHeartbeat` is **shared**: an off-chain watcher posts observation
/// txs against it. When the observed sequence runs ahead of what's expected, it
/// emits `CoverageGapDetected` for alerting.
module compliance_vault::coverage;

use sui::clock::Clock;
use compliance_vault::namespace::{Self, AgentNamespace, AdminCap};
use compliance_vault::errors;
use compliance_vault::events;

const VERSION: u16 = 1;

public struct CoverageHeartbeat has key {
    id: UID,
    version: u16,
    namespace_id: ID,
    seq_observed: u64,
    expected_next: u64,
    last_heartbeat_ms: u64,
}

/// Create a heartbeat for a namespace (admin-gated).
public fun create_heartbeat(
    ns: &AgentNamespace,
    cap: &AdminCap,
    ctx: &mut TxContext,
) {
    namespace::assert_admin(ns, cap); // C3
    let hb = CoverageHeartbeat {
        id: object::new(ctx),
        version: VERSION,
        namespace_id: namespace::id(ns),
        seq_observed: 0,
        expected_next: namespace::seq_next(ns),
        last_heartbeat_ms: 0,
    };
    transfer::share_object(hb);
}

/// Record an observed sequence. Permissionless: any watcher may post. The
/// on-chain truth (`expected_next`) and timestamp are read here, NOT taken from
/// the caller — so a poster can no longer lie about how far anchoring has
/// progressed or backdate the heartbeat. Emits a gap event when the watcher's
/// off-chain `seq_observed` runs ahead of what's been anchored on-chain.
///
/// RESIDUAL RISK (advisory layer): `seq_observed` is an irreducibly off-chain
/// claim, so a poster can still spam false-positive gap alerts. Downstream
/// consumers must treat CoverageGapDetected as advisory and cross-check
/// `expected_next` (now chain-derived) against the namespace. Posting auth /
/// gas payer deferred (spec §16.7, [A:4]).
public fun record_observation(
    hb: &mut CoverageHeartbeat,
    ns: &AgentNamespace,
    seq_observed: u64,
    clock: &Clock,
) {
    assert!(hb.namespace_id == namespace::id(ns), errors::unauthorized());
    let expected_next = namespace::seq_next(ns);
    hb.seq_observed = seq_observed;
    hb.expected_next = expected_next;
    hb.last_heartbeat_ms = clock.timestamp_ms();
    if (seq_observed > expected_next) {
        events::emit_coverage_gap_detected(hb.namespace_id, expected_next, seq_observed);
    };
}

// ---- read accessors ----
public fun seq_observed(hb: &CoverageHeartbeat): u64 { hb.seq_observed }
public fun expected_next(hb: &CoverageHeartbeat): u64 { hb.expected_next }

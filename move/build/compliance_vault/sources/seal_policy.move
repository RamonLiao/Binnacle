/// Seal access-control gate (spec §5.4, C4) — [A:1] CLOSED via sui-seal.
///
/// This is the Seal `seal_approve*` convention, NOT a bool getter:
///   - function name MUST start with `seal_approve`;
///   - first param MUST be `id: vector<u8>` (the IBE identity);
///   - **abort = deny, return = release share**.
/// The key server dry-runs this in an `onlyTransactionKind` PTB and injects the
/// auditor's session-key address as sender, so `ctx.sender()` is the auditor.
module compliance_vault::seal_policy;

use std::string::String;
use sui::clock::Clock;
use compliance_vault::engagement::{Self, EngagementObject};
use compliance_vault::errors;

/// Seal calls this to decide whether to release a key share. Identity binding:
/// `id` MUST equal the namespace_id bytes the SDK encrypted under.
entry fun seal_approve(
    id: vector<u8>,
    eng: &EngagementObject,
    requested_event_type: String,
    requested_ts_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    // IBE identity binding: each namespace is its own key domain.
    let ns_id = engagement::namespace_id(eng);
    assert!(id == object::id_to_bytes(&ns_id), errors::scope_mismatch());

    assert!(!engagement::is_revoked(eng), errors::engagement_revoked());
    assert!(clock.timestamp_ms() <= engagement::expires_at_ms(eng), errors::engagement_expired());

    // B3 — field-based auth: sender is the auditor's session-key address.
    assert!(ctx.sender() == engagement::auditor_addr(eng), errors::scope_mismatch());

    // Time scope.
    assert!(
        requested_ts_ms >= engagement::scope_start_ms(eng)
            && requested_ts_ms <= engagement::scope_end_ms(eng),
        errors::scope_mismatch(),
    );

    // Event-type scope: empty filter = all types allowed.
    let filter = engagement::event_type_filter(eng);
    assert!(
        vector::is_empty(filter) || vector::contains(filter, &requested_event_type),
        errors::scope_mismatch(),
    );
}

/// Test-only bridge so external test modules can exercise the private
/// `seal_approve` (Seal calls it via dry-run in production, not from Move).
#[test_only]
public fun seal_approve_for_test(
    id: vector<u8>,
    eng: &EngagementObject,
    requested_event_type: String,
    requested_ts_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    seal_approve(id, eng, requested_event_type, requested_ts_ms, clock, ctx);
}

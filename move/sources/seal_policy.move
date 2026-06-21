/// Seal access-control gate (spec §5.4, C4) — [A:1] CLOSED via sui-seal.
///
/// This is the Seal `seal_approve*` convention, NOT a bool getter:
///   - function name MUST start with `seal_approve`;
///   - first param MUST be `id: vector<u8>` (the IBE identity);
///   - **abort = deny, return = release share**.
/// The key server dry-runs this in an `onlyTransactionKind` PTB and injects the
/// auditor's session-key address as sender, so `ctx.sender()` is the auditor.
module compliance_vault::seal_policy;

use std::hash;
use std::bcs;
use std::string::String;
use sui::clock::Clock;
use compliance_vault::engagement::{Self, EngagementObject};
use compliance_vault::errors;

/// Domain separator for the scope-bucket IBE identity.
/// MUST stay byte-for-byte in sync with sdk/src/seal/bucket.ts (conformance test).
const SEAL_BUCKET_DOMAIN: vector<u8> = b"compliance_vault::seal_bucket::v1";
/// Milliseconds per day (used to derive epoch_day from ts_ms).
const MS_PER_DAY: u64 = 86_400_000;

/// Per-(namespace, epoch_day, event_type) IBE bucket. Domain-separated, every
/// variable-length field length-prefixed (LE u64) so the encoding is injective.
/// Encoding: sha256( bcs(len(TAG)) || TAG || id_to_bytes(ns) || bcs(epoch_day) || bcs(len(type)) || type_utf8 )
fun bucket_id(ns_id: sui::object::ID, ts_ms: u64, event_type: String): vector<u8> {
    let epoch_day = ts_ms / MS_PER_DAY;
    let tag = SEAL_BUCKET_DOMAIN;
    let type_bytes = *event_type.as_bytes();
    let mut buf = vector[];
    vector::append(&mut buf, bcs::to_bytes(&(vector::length(&tag) as u64)));
    vector::append(&mut buf, tag);
    vector::append(&mut buf, sui::object::id_to_bytes(&ns_id));
    vector::append(&mut buf, bcs::to_bytes(&epoch_day));
    vector::append(&mut buf, bcs::to_bytes(&(vector::length(&type_bytes) as u64)));
    vector::append(&mut buf, type_bytes);
    hash::sha2_256(buf)
}

/// Seal calls this to decide whether to release a key share. Identity binding:
/// `id` MUST equal the scope-bucket for (namespace, epoch_day, event_type).
entry fun seal_approve(
    id: vector<u8>,
    eng: &EngagementObject,
    requested_event_type: String,
    requested_ts_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    let ns_id = engagement::namespace_id(eng);
    // (1) id MUST equal the recomputed scope bucket for (ts, type).
    assert!(id == bucket_id(ns_id, requested_ts_ms, requested_event_type), errors::scope_mismatch());

    assert!(!engagement::is_revoked(eng), errors::engagement_revoked());
    assert!(clock.timestamp_ms() <= engagement::expires_at_ms(eng), errors::engagement_expired());

    // B3 — field-based auth: sender is the auditor's session-key address.
    assert!(ctx.sender() == engagement::auditor_addr(eng), errors::scope_mismatch());

    // Time scope — DAY-COVERAGE gate (Stage C residual: day-grain edge-leak fix).
    // The IBE bucket is day-grained, so releasing a share for `requested_ts_ms`
    // hands the auditor the key for the WHOLE epoch_day. A naive per-request
    // `requested_ts in [scope_start, scope_end]` check would let a sub-day grant
    // unlock the entire day's bucket (~288 5-min batches). Require instead that
    // the FULL epoch_day containing requested_ts is inside the grant, so the
    // released key's breadth never exceeds the granted scope. This subsumes the
    // old per-request window check (day_start <= requested_ts <= day_end always).
    //
    // FUTURE UPGRADE PATH (deferred, documented): (1) hour-grain bucket via
    // SEAL_BUCKET_DOMAIN ::v2 (MS_PER_HOUR) shrinks the unit from day to hour —
    // requires re-encrypt, not retrofittable; (2) also enforce day-alignment of
    // scope_start/scope_end at engagement::mint_engagement so a non-aligned grant
    // is rejected at mint, not only at the gate. Both intentionally NOT done here.
    let day_start = (requested_ts_ms / MS_PER_DAY) * MS_PER_DAY;
    let day_end = day_start + MS_PER_DAY - 1;
    assert!(
        engagement::scope_start_ms(eng) <= day_start
            && day_end <= engagement::scope_end_ms(eng),
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

/// Test-only bridge exposing bucket_id for golden-vector tests and test setup.
#[test_only]
public fun bucket_id_for_test(ns_id: sui::object::ID, ts_ms: u64, event_type: String): vector<u8> {
    bucket_id(ns_id, ts_ms, event_type)
}

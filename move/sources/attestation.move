/// Signed auditor report anchor (spec §4.1, §5.4).
///
/// `AuditorAttestation` is **frozen** (E1): an immutable, publicly verifiable
/// record that an auditor filed a signed report citing specific batches.
module compliance_vault::attestation;

use sui::clock::Clock;
use compliance_vault::engagement::{Self, EngagementObject};
use compliance_vault::errors;
use compliance_vault::events;

const VERSION: u16 = 1;

public struct AuditorAttestation has key {
    id: UID,
    version: u16,
    engagement_id: ID,
    report_blob_id: vector<u8>,
    report_hash: vector<u8>,
    cited_batch_ids: vector<ID>,
    signed_at_ms: u64,
}

/// File a signed report. Only the engagement's auditor may file, and only while
/// the engagement is live (not revoked / not expired).
public fun file_attestation(
    eng: &EngagementObject,
    report_blob_id: vector<u8>,
    report_hash: vector<u8>,
    cited_batch_ids: vector<ID>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == engagement::auditor_addr(eng), errors::scope_mismatch());
    assert!(!engagement::is_revoked(eng), errors::engagement_revoked());
    assert!(clock.timestamp_ms() <= engagement::expires_at_ms(eng), errors::engagement_expired());

    let att = AuditorAttestation {
        id: object::new(ctx),
        version: VERSION,
        engagement_id: object::id(eng),
        report_blob_id,
        report_hash,
        cited_batch_ids,
        signed_at_ms: clock.timestamp_ms(),
    };
    events::emit_attestation_filed(object::id(eng), object::id(&att), report_hash);
    transfer::freeze_object(att);
}

// ---- read accessors ----
public fun engagement_id(a: &AuditorAttestation): ID { a.engagement_id }
public fun report_hash(a: &AuditorAttestation): vector<u8> { a.report_hash }
public fun cited_batch_ids(a: &AuditorAttestation): &vector<ID> { &a.cited_batch_ids }

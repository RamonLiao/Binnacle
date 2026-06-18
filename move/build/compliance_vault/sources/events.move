/// Event definitions and emission helpers for off-chain indexers (spec §7).
///
/// Events are emitted via `public(package)` helpers so the owning modules
/// (namespace, receipt, engagement, attestation, coverage) keep their state
/// private while still driving the indexer / MemWal pipeline.
module compliance_vault::events;

use std::string::String;
use sui::event;

/// Emitted once per namespace creation.
public struct NamespaceCreated has copy, drop {
    namespace_id: ID,
    owner: address,
    agent_id: String,
}

/// Emitted on every `anchor_batch`. Carries the full blob_id list off-chain
/// (E2) — the on-chain receipt only stores its 32B digest.
public struct BatchAnchored has copy, drop {
    namespace_id: ID,
    batch_id: ID,
    run_id: vector<u8>,
    seq_start: u64,
    seq_end: u64,
    merkle_root: vector<u8>,
    blob_ids: vector<vector<u8>>,
    batch_hash: vector<u8>,
}

/// Emitted when an auditor engagement is minted.
public struct EngagementMinted has copy, drop {
    namespace_id: ID,
    engagement_id: ID,
    auditor_addr: address,
    expires_at_ms: u64,
    minted_at_ms: u64,
}

/// Emitted when an engagement is revoked.
public struct EngagementRevoked has copy, drop {
    namespace_id: ID,
    engagement_id: ID,
}

/// Emitted when an auditor files a signed report attestation.
public struct AttestationFiled has copy, drop {
    engagement_id: ID,
    attestation_id: ID,
    report_hash: vector<u8>,
}

/// Emitted by an off-chain watcher tx when a sequence gap is observed.
public struct CoverageGapDetected has copy, drop {
    namespace_id: ID,
    expected: u64,
    observed: u64,
}

public(package) fun emit_namespace_created(
    namespace_id: ID,
    owner: address,
    agent_id: String,
) {
    event::emit(NamespaceCreated { namespace_id, owner, agent_id });
}

public(package) fun emit_batch_anchored(
    namespace_id: ID,
    batch_id: ID,
    run_id: vector<u8>,
    seq_start: u64,
    seq_end: u64,
    merkle_root: vector<u8>,
    blob_ids: vector<vector<u8>>,
    batch_hash: vector<u8>,
) {
    event::emit(BatchAnchored {
        namespace_id,
        batch_id,
        run_id,
        seq_start,
        seq_end,
        merkle_root,
        blob_ids,
        batch_hash,
    });
}

public(package) fun emit_engagement_minted(
    namespace_id: ID,
    engagement_id: ID,
    auditor_addr: address,
    expires_at_ms: u64,
    minted_at_ms: u64,
) {
    event::emit(EngagementMinted {
        namespace_id,
        engagement_id,
        auditor_addr,
        expires_at_ms,
        minted_at_ms,
    });
}

public(package) fun emit_engagement_revoked(namespace_id: ID, engagement_id: ID) {
    event::emit(EngagementRevoked { namespace_id, engagement_id });
}

public(package) fun emit_attestation_filed(
    engagement_id: ID,
    attestation_id: ID,
    report_hash: vector<u8>,
) {
    event::emit(AttestationFiled { engagement_id, attestation_id, report_hash });
}

public(package) fun emit_coverage_gap_detected(namespace_id: ID, expected: u64, observed: u64) {
    event::emit(CoverageGapDetected { namespace_id, expected, observed });
}

/// Auditor engagement — time/scope-bounded decryption grant (spec §4.1, §5.4).
///
/// `EngagementObject` is **shared** (B3): the admin must revoke it (`&mut`) and
/// the Seal key server must read it (`&`); the auditor is neither sole owner nor
/// only reader. Auth is by `auditor_addr` field compare, not object ownership.
module compliance_vault::engagement;

use std::string::String;
use sui::clock::Clock;
use compliance_vault::namespace::{Self, AgentNamespace, AdminCap};
use compliance_vault::errors;
use compliance_vault::events;

const VERSION: u16 = 1;

public struct EngagementObject has key {
    id: UID,
    version: u16,
    namespace_id: ID,
    auditor_addr: address,
    auditor_pubkey: vector<u8>,
    scope_start_ms: u64,
    scope_end_ms: u64,
    event_type_filter: vector<String>,
    expires_at_ms: u64,
    revoked: bool,
}

/// Mint a scoped engagement. Shares it internally (B2/B3).
public fun mint_engagement(
    ns: &AgentNamespace,
    cap: &AdminCap,
    auditor_addr: address,
    auditor_pubkey: vector<u8>,
    scope_start_ms: u64,
    scope_end_ms: u64,
    event_type_filter: vector<String>,
    expires_at_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    namespace::assert_admin(ns, cap); // C3
    let eng = EngagementObject {
        id: object::new(ctx),
        version: VERSION,
        namespace_id: namespace::id(ns),
        auditor_addr,
        auditor_pubkey,
        scope_start_ms,
        scope_end_ms,
        event_type_filter,
        expires_at_ms,
        revoked: false,
    };
    let eid = object::id(&eng);
    events::emit_engagement_minted(
        namespace::id(ns),
        eid,
        auditor_addr,
        expires_at_ms,
        clock.timestamp_ms(),
    );
    transfer::share_object(eng);
}

/// Revoke an engagement (admin-only, C3).
public fun revoke_engagement(eng: &mut EngagementObject, cap: &AdminCap) {
    assert!(namespace::admin_namespace_id(cap) == eng.namespace_id, errors::unauthorized());
    eng.revoked = true;
    events::emit_engagement_revoked(eng.namespace_id, object::id(eng));
}

// ---- read accessors (consumed by seal_policy / attestation) ----
public fun namespace_id(eng: &EngagementObject): ID { eng.namespace_id }
public fun auditor_addr(eng: &EngagementObject): address { eng.auditor_addr }
public fun auditor_pubkey(eng: &EngagementObject): vector<u8> { eng.auditor_pubkey }
public fun scope_start_ms(eng: &EngagementObject): u64 { eng.scope_start_ms }
public fun scope_end_ms(eng: &EngagementObject): u64 { eng.scope_end_ms }
public fun expires_at_ms(eng: &EngagementObject): u64 { eng.expires_at_ms }
public fun is_revoked(eng: &EngagementObject): bool { eng.revoked }
public fun event_type_filter(eng: &EngagementObject): &vector<String> { &eng.event_type_filter }

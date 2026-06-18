/// Per-agent tamper-evident namespace + capabilities (spec §4.1, §5.1).
///
/// `AgentNamespace` is **shared** (B1): the WriterCap holder (agent runtime) and
/// the AdminCap holder (compliance officer) are different addresses, and both
/// must pass it as `&mut`, so it cannot be owned. Auth is by capability +
/// `namespace_id` binding (C3), never by address.
module compliance_vault::namespace;

use std::string::String;
use compliance_vault::policy::{Self, PolicyObject};
use compliance_vault::errors;
use compliance_vault::events;

const VERSION: u16 = 1;

/// Shared, mutable, tamper-evident sequence head for one agent.
public struct AgentNamespace has key {
    id: UID,
    version: u16,
    owner: address,
    agent_id: String,
    policy: PolicyObject,
    seq_next: u64,
    batch_index: u64,
    last_batch_hash: vector<u8>,
    last_anchor_epoch: u64,
    sealed: bool,
}

/// Admin authority: mint engagements, rotate policy, seal namespace.
public struct AdminCap has key, store {
    id: UID,
    namespace_id: ID,
}

/// Narrowest write authority: `anchor_batch` only (C1).
public struct WriterCap has key, store {
    id: UID,
    namespace_id: ID,
}

/// Create a namespace. Shares it internally (B2) and returns the two caps for
/// the PTB to route to the chosen admin / writer addresses.
public fun create_namespace(
    agent_id: String,
    policy: PolicyObject,
    ctx: &mut TxContext,
): (AdminCap, WriterCap) {
    let ns = AgentNamespace {
        id: object::new(ctx),
        version: VERSION,
        owner: ctx.sender(),
        agent_id,
        policy,
        seq_next: 0,
        batch_index: 0,
        last_batch_hash: vector[],
        last_anchor_epoch: 0,
        sealed: false,
    };
    let ns_id = object::id(&ns);
    events::emit_namespace_created(ns_id, ns.owner, ns.agent_id);
    transfer::share_object(ns);

    let admin = AdminCap { id: object::new(ctx), namespace_id: ns_id };
    let writer = WriterCap { id: object::new(ctx), namespace_id: ns_id };
    (admin, writer)
}

/// Freeze the policy and lock the namespace against further policy edits.
public fun seal_namespace(ns: &mut AgentNamespace, cap: &AdminCap) {
    assert!(cap.namespace_id == object::id(ns), errors::unauthorized());
    ns.sealed = true;
    policy::set_immutable(&mut ns.policy);
}

/// Replace the policy (admin-only, only while not sealed/immutable).
public fun update_policy(
    ns: &mut AgentNamespace,
    cap: &AdminCap,
    new_policy: PolicyObject,
) {
    assert!(cap.namespace_id == object::id(ns), errors::unauthorized());
    assert!(!ns.sealed, errors::namespace_sealed());
    assert!(!policy::is_immutable(&ns.policy), errors::policy_immutable());
    ns.policy = new_policy;
}

// ---- Package API (consumed by receipt / engagement / coverage) ----

/// Abort unless `cap` binds to this namespace (C1/C3).
public(package) fun assert_writer(ns: &AgentNamespace, cap: &WriterCap) {
    assert!(cap.namespace_id == object::id(ns), errors::unauthorized_writer());
}

/// Abort unless `cap` binds to this namespace (C3).
public(package) fun assert_admin(ns: &AgentNamespace, cap: &AdminCap) {
    assert!(cap.namespace_id == object::id(ns), errors::unauthorized());
}

public(package) fun admin_namespace_id(cap: &AdminCap): ID { cap.namespace_id }
public(package) fun writer_namespace_id(cap: &WriterCap): ID { cap.namespace_id }

public fun id(ns: &AgentNamespace): ID { object::id(ns) }
public fun seq_next(ns: &AgentNamespace): u64 { ns.seq_next }
public fun batch_index(ns: &AgentNamespace): u64 { ns.batch_index }
public fun last_batch_hash(ns: &AgentNamespace): vector<u8> { ns.last_batch_hash }
public fun is_sealed(ns: &AgentNamespace): bool { ns.sealed }
public fun policy(ns: &AgentNamespace): &PolicyObject { &ns.policy }

/// Advance the chain head after a successful anchor (C2). Package-internal so
/// only `receipt::anchor_batch` can move the sequence.
public(package) fun advance_after_anchor(
    ns: &mut AgentNamespace,
    new_seq_next: u64,
    new_batch_hash: vector<u8>,
    epoch: u64,
) {
    ns.seq_next = new_seq_next;
    ns.batch_index = ns.batch_index + 1;
    ns.last_batch_hash = new_batch_hash;
    ns.last_anchor_epoch = epoch;
}

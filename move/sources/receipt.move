/// Batch anchoring + Merkle inclusion verification (spec §4.1, §5.2, §5.3).
///
/// `BatchReceipt` is **frozen** (E1): created once, never mutated, publicly
/// readable for verification. `key`-only (no `store`) so it cannot be wrapped
/// after freezing.
module compliance_vault::receipt;

use std::bcs;
use std::hash;
use sui::clock::Clock;
use compliance_vault::namespace::{Self, AgentNamespace, WriterCap};
use compliance_vault::errors;
use compliance_vault::events;

const VERSION: u16 = 1;

/// On-chain hard cap on events per batch — DoS / overflow guard only. The SDK's
/// 256-event flush trigger [A:4] is independent and stays well under this.
const BATCH_MAX_EVENTS: u64 = 4096;

const MAX_U64: u64 = 18446744073709551615;

/// Merkle domain-separation tags (RFC 6962 style). Leaves and internal nodes are
/// hashed under distinct prefixes so an internal node can never be presented as a
/// leaf (second-preimage), and the leaf binds `seq` so a proof attests position.
/// The off-chain SDK prover MUST build the tree with these exact prefixes.
const LEAF_PREFIX: u8 = 0x00;
const NODE_PREFIX: u8 = 0x01;

/// Immutable anchor for one batch of agent events.
public struct BatchReceipt has key {
    id: UID,
    version: u16,
    namespace_id: ID,
    run_id: vector<u8>,
    batch_index: u64,
    seq_start: u64,
    seq_end: u64,
    merkle_root: vector<u8>,
    blob_ids_digest: vector<u8>,
    parent_batch_hash: vector<u8>,
    batch_hash: vector<u8>,
    created_at_ms: u64,
    created_epoch: u64,
}

/// Anchor a batch. Enforces the monotonic sequence and the on-chain hash chain
/// (C2), then freezes the receipt. See spec §5.2 for the full invariant list.
public fun anchor_batch(
    ns: &mut AgentNamespace,
    cap: &WriterCap,
    run_id: vector<u8>,
    seq_start: u64,
    seq_end: u64,
    merkle_root: vector<u8>,
    blob_ids: vector<vector<u8>>,
    parent_batch_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // C1/C3 — writer cap must bind to this namespace.
    namespace::assert_writer(ns, cap);

    // Sequence: no gaps, no replay.
    let expected = namespace::seq_next(ns);
    assert!(seq_start >= expected, errors::seq_replay());
    assert!(seq_start <= expected, errors::seq_gap());

    // Range + overflow guards.
    assert!(seq_end >= seq_start, errors::seq_gap());
    assert!(seq_end < MAX_U64, errors::seq_overflow());
    let count = seq_end - seq_start + 1;
    assert!(count <= BATCH_MAX_EVENTS, errors::seq_overflow());
    assert!(vector::length(&blob_ids) == count, errors::len_mismatch());

    // C2 — chain head must match what's on-chain.
    assert!(parent_batch_hash == namespace::last_batch_hash(ns), errors::parent_hash_mismatch());

    let blob_ids_digest = hash::sha2_256(bcs::to_bytes(&blob_ids));
    let batch_hash = compute_batch_hash(&parent_batch_hash, &merkle_root, seq_start, seq_end);

    let receipt = BatchReceipt {
        id: object::new(ctx),
        version: VERSION,
        namespace_id: namespace::id(ns),
        run_id,
        batch_index: namespace::batch_index(ns),
        seq_start,
        seq_end,
        merkle_root,
        blob_ids_digest,
        parent_batch_hash,
        batch_hash,
        created_at_ms: clock.timestamp_ms(),
        created_epoch: ctx.epoch(),
    };
    let batch_id = object::id(&receipt);

    // Advance chain head only after the receipt is fully built (C2).
    namespace::advance_after_anchor(ns, seq_end + 1, batch_hash, ctx.epoch());

    events::emit_batch_anchored(
        namespace::id(ns),
        batch_id,
        run_id,
        seq_start,
        seq_end,
        merkle_root,
        blob_ids,
        batch_hash,
    );

    transfer::freeze_object(receipt);
}

/// Verify a single event's inclusion against a receipt's Merkle root.
///
/// Sorted-pair (lexicographic) Merkle scheme — no left/right direction bits.
/// Domain-separated: the leaf binds `seq` (so a proof attests the event's
/// position, not just membership) and uses a distinct prefix from internal
/// nodes (so an internal node cannot be replayed as a leaf). The off-chain SDK
/// prover MUST build the tree identically (see leaf_hash / hash_pair).
public fun verify_event_inclusion(
    receipt: &BatchReceipt,
    seq: u64,
    event_hash: vector<u8>,
    merkle_proof: vector<vector<u8>>,
): bool {
    assert!(seq >= receipt.seq_start && seq <= receipt.seq_end, errors::invalid_merkle_proof());
    let mut computed = leaf_hash(seq, &event_hash);
    let n = vector::length(&merkle_proof);
    let mut i = 0;
    while (i < n) {
        let sib = *vector::borrow(&merkle_proof, i);
        computed = hash_pair(computed, sib);
        i = i + 1;
    };
    computed == receipt.merkle_root
}

fun compute_batch_hash(
    parent: &vector<u8>,
    merkle_root: &vector<u8>,
    seq_start: u64,
    seq_end: u64,
): vector<u8> {
    let mut buf = *parent;
    vector::append(&mut buf, *merkle_root);
    vector::append(&mut buf, bcs::to_bytes(&seq_start));
    vector::append(&mut buf, bcs::to_bytes(&seq_end));
    hash::sha2_256(buf)
}

/// Leaf hash: `sha256(0x00 || bcs(seq) || event_hash)`. Binding `seq` defeats
/// position-forgery; the 0x00 prefix separates leaves from internal nodes.
fun leaf_hash(seq: u64, event_hash: &vector<u8>): vector<u8> {
    let mut buf = vector[LEAF_PREFIX];
    vector::append(&mut buf, bcs::to_bytes(&seq));
    vector::append(&mut buf, *event_hash);
    hash::sha2_256(buf)
}

/// Internal node hash: `sha256(0x01 || min(a,b) || max(a,b))`.
fun hash_pair(a: vector<u8>, b: vector<u8>): vector<u8> {
    let mut buf = vector[NODE_PREFIX];
    if (lte(&a, &b)) {
        vector::append(&mut buf, a);
        vector::append(&mut buf, b);
    } else {
        vector::append(&mut buf, b);
        vector::append(&mut buf, a);
    };
    hash::sha2_256(buf)
}

/// Lexicographic `a <= b` over byte vectors.
fun lte(a: &vector<u8>, b: &vector<u8>): bool {
    let la = vector::length(a);
    let lb = vector::length(b);
    let m = if (la < lb) la else lb;
    let mut i = 0;
    while (i < m) {
        let x = *vector::borrow(a, i);
        let y = *vector::borrow(b, i);
        if (x < y) return true;
        if (x > y) return false;
        i = i + 1;
    };
    la <= lb
}

// ---- test-only exports (let test modules build trees off the real scheme) ----
#[test_only]
public fun leaf_hash_for_test(seq: u64, event_hash: vector<u8>): vector<u8> {
    leaf_hash(seq, &event_hash)
}
#[test_only]
public fun hash_pair_for_test(a: vector<u8>, b: vector<u8>): vector<u8> {
    hash_pair(a, b)
}

// ---- read accessors ----
public fun namespace_id(r: &BatchReceipt): ID { r.namespace_id }
public fun batch_index(r: &BatchReceipt): u64 { r.batch_index }
public fun seq_start(r: &BatchReceipt): u64 { r.seq_start }
public fun seq_end(r: &BatchReceipt): u64 { r.seq_end }
public fun merkle_root(r: &BatchReceipt): vector<u8> { r.merkle_root }
public fun batch_hash(r: &BatchReceipt): vector<u8> { r.batch_hash }
public fun parent_batch_hash(r: &BatchReceipt): vector<u8> { r.parent_batch_hash }
public fun blob_ids_digest(r: &BatchReceipt): vector<u8> { r.blob_ids_digest }

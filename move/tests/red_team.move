/// Red-team regression tests (sui-red-team). These encode attacks that were
/// EXPLOITABLE in the scaffold and are now DEFENDED after the review-chain fix:
///   RT1 — merkle `seq` now bound into the leaf (position-forgery blocked)
///   RT2 — merkle leaf/internal domain separation (internal-node-as-leaf blocked)
///   RT3 — coverage reads on-chain truth for expected_next + timestamp
///   RT3b — coverage rejects a foreign namespace (binding check)
///   RT5 — anchor batch-size overflow guard (was already defended)
///
/// Trees are built off receipt's real scheme via *_for_test exports — no
/// re-implementation, so the tests can't silently drift from production hashing.
#[test_only]
module compliance_vault::red_team;

use std::hash;
use std::string;
use sui::clock;
use sui::test_scenario as ts;
use compliance_vault::policy::{Self, PolicyObject};
use compliance_vault::namespace::{Self, AgentNamespace, AdminCap, WriterCap};
use compliance_vault::receipt::{Self, BatchReceipt};
use compliance_vault::coverage::{Self, CoverageHeartbeat};

const ADMIN: address = @0xA;
const WRITER: address = @0x111;
const AUDITOR: address = @0xA0D;
const STRANGER: address = @0xBAD;

const EMPTY_HASH: vector<u8> = b"";

fun mk_policy(): PolicyObject {
    policy::new_policy(100, policy::enc_seal_threshold(), option::none(), vector[])
}

fun bootstrap(sc: &mut ts::Scenario) {
    let (admin_cap, writer_cap) = namespace::create_namespace(
        string::utf8(b"agent-prod"), mk_policy(), sc.ctx(),
    );
    transfer::public_transfer(admin_cap, ADMIN);
    transfer::public_transfer(writer_cap, WRITER);
}

// =============================================================================
// RT1 — Merkle: `seq` is bound into the leaf (position-forgery DEFENDED)
// =============================================================================
// 2-leaf tree. Proving l0 at its true seq (0) works; replaying the same proof
// while CLAIMING seq 1 now fails because the leaf hash includes seq.
#[test]
fun red_team_round_1_merkle_seq_bound() {
    let e0 = hash::sha2_256(b"event-0");
    let e1 = hash::sha2_256(b"event-1");
    let leaf0 = receipt::leaf_hash_for_test(0, e0);
    let leaf1 = receipt::leaf_hash_for_test(1, e1);
    let root = receipt::hash_pair_for_test(leaf0, leaf1);

    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 1, root, vector[b"b0", b"b1"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::next_tx(&mut sc, AUDITOR);
    {
        let r = ts::take_immutable<BatchReceipt>(&sc);
        // genuine position verifies
        assert!(receipt::verify_event_inclusion(&r, 0, e0, vector[leaf1]), 1);
        // ATTACK now blocked: same proof at a forged seq fails
        assert!(!receipt::verify_event_inclusion(&r, 1, e0, vector[leaf1]), 999);
        ts::return_immutable(r);
    };
    ts::end(sc);
}

// =============================================================================
// RT2 — Merkle: leaf/internal domain separation (internal-node-as-leaf DEFENDED)
// =============================================================================
// 4-leaf tree. The internal node n01 can no longer be passed off as an included
// "event": leaves are hashed under 0x00, internal nodes under 0x01, so no
// event_hash input reproduces n01 without a preimage.
#[test]
fun red_team_round_2_merkle_domain_separation() {
    let leaf0 = receipt::leaf_hash_for_test(0, hash::sha2_256(b"e0"));
    let leaf1 = receipt::leaf_hash_for_test(1, hash::sha2_256(b"e1"));
    let leaf2 = receipt::leaf_hash_for_test(2, hash::sha2_256(b"e2"));
    let leaf3 = receipt::leaf_hash_for_test(3, hash::sha2_256(b"e3"));
    let n01 = receipt::hash_pair_for_test(leaf0, leaf1);
    let n23 = receipt::hash_pair_for_test(leaf2, leaf3);
    let root = receipt::hash_pair_for_test(n01, n23);

    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 3, root,
            vector[b"b0", b"b1", b"b2", b"b3"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::next_tx(&mut sc, AUDITOR);
    {
        let r = ts::take_immutable<BatchReceipt>(&sc);
        // ATTACK now blocked: feeding the raw internal node as an "event" fails
        assert!(!receipt::verify_event_inclusion(&r, 0, n01, vector[n23]), 999);
        ts::return_immutable(r);
    };
    ts::end(sc);
}

// =============================================================================
// RT3 — Coverage: expected_next + time are chain-derived (lie about on-chain
// progress DEFENDED)
// =============================================================================
// A stranger may still post (permissionless by design), and seq_observed is an
// irreducibly off-chain claim — but expected_next now reflects ns.seq_next, not
// the caller's word.
#[test]
fun red_team_round_3_coverage_chain_truth() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, ADMIN);
    {
        let ns = ts::take_shared<AgentNamespace>(&sc);
        let acap = ts::take_from_sender<AdminCap>(&sc);
        coverage::create_heartbeat(&ns, &acap, sc.ctx());
        ts::return_shared(ns);
        ts::return_to_sender(&sc, acap);
    };
    ts::next_tx(&mut sc, STRANGER);
    {
        let mut hb = ts::take_shared<CoverageHeartbeat>(&sc);
        let ns = ts::take_shared<AgentNamespace>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        // stranger claims a huge observed seq; expected_next is forced to chain truth (0)
        coverage::record_observation(&mut hb, &ns, 1_000_000, &clk);
        assert!(coverage::expected_next(&hb) == namespace::seq_next(&ns), 999); // == 0, not a lie
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_shared(hb);
    };
    ts::end(sc);
}

// =============================================================================
// RT3b — Coverage: heartbeat rejects a foreign namespace (binding DEFENDED)
// =============================================================================
#[test]
#[expected_failure(abort_code = 12, location = compliance_vault::coverage)] // unauthorized
fun red_team_round_3b_coverage_cross_namespace_aborts() {
    let mut sc = ts::begin(ADMIN);
    // namespace A + its heartbeat
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, ADMIN);
    {
        let ns = ts::take_shared<AgentNamespace>(&sc);
        let acap = ts::take_from_sender<AdminCap>(&sc);
        coverage::create_heartbeat(&ns, &acap, sc.ctx());
        ts::return_shared(ns);
        ts::return_to_sender(&sc, acap);
    };
    // namespace B (foreign)
    ts::next_tx(&mut sc, ADMIN);
    let (admin_b, writer_b) = namespace::create_namespace(
        string::utf8(b"agent-b"), mk_policy(), sc.ctx(),
    );
    let ns_b_id = namespace::admin_namespace_id(&admin_b);
    transfer::public_transfer(admin_b, ADMIN);
    transfer::public_transfer(writer_b, ADMIN);
    // feed namespace B to A's heartbeat → hb.namespace_id != id(ns_b) → abort
    ts::next_tx(&mut sc, STRANGER);
    {
        let mut hb = ts::take_shared<CoverageHeartbeat>(&sc);
        let ns_b = ts::take_shared_by_id<AgentNamespace>(&sc, ns_b_id);
        let clk = clock::create_for_testing(sc.ctx());
        coverage::record_observation(&mut hb, &ns_b, 5, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(ns_b);
        ts::return_shared(hb);
    };
    ts::end(sc);
}

// =============================================================================
// RT5 — Integer: anchor_batch batch-size overflow guard (DEFENDED)
// =============================================================================
#[test]
#[expected_failure(abort_code = 13, location = compliance_vault::receipt)] // seq_overflow
fun red_team_round_5_batch_too_large() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 4999, b"r", vector[b"x"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::end(sc);
}

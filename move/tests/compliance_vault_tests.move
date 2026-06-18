/// Unit / scenario tests for compliance_vault (spec §13.1).
///
/// Abort-code reference (errors.move): 1 seq_gap · 2 seq_replay · 3 len_mismatch
/// · 4 policy_immutable · 5 namespace_sealed · 6 engagement_expired
/// · 7 engagement_revoked · 8 scope_mismatch · 9 unauthorized_writer
/// · 10 invalid_merkle_proof · 11 parent_hash_mismatch · 12 unauthorized
/// · 13 seq_overflow.
#[test_only]
module compliance_vault::compliance_vault_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use compliance_vault::policy::{Self, PolicyObject};
use compliance_vault::namespace::{Self, AgentNamespace, AdminCap, WriterCap};
use compliance_vault::receipt::{Self, BatchReceipt};
use compliance_vault::engagement::{Self, EngagementObject};
use compliance_vault::seal_policy;

const ADMIN: address = @0xA;
const WRITER: address = @0x111;
const AUDITOR: address = @0xA0D;
const STRANGER: address = @0xBAD;

const EMPTY_HASH: vector<u8> = b"";

fun mk_policy(): PolicyObject {
    policy::new_policy(100, policy::enc_seal_threshold(), option::none(), vector[])
}

/// Create a namespace as ADMIN, route AdminCap→ADMIN, WriterCap→WRITER.
fun bootstrap(sc: &mut ts::Scenario) {
    let (admin_cap, writer_cap) = namespace::create_namespace(
        string::utf8(b"agent-prod"),
        mk_policy(),
        sc.ctx(),
    );
    transfer::public_transfer(admin_cap, ADMIN);
    transfer::public_transfer(writer_cap, WRITER);
}

// ---------------------------------------------------------------------------
// Hot path: anchor_batch sequence + hash chain (C2)
// ---------------------------------------------------------------------------

#[test]
fun anchor_two_batches_advances_chain() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);

    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());

        // batch 0: seq 0..2, parent = empty (genesis head)
        receipt::anchor_batch(
            &mut ns, &wcap, b"run-1", 0, 2,
            b"root-a", vector[b"b0", b"b1", b"b2"], EMPTY_HASH,
            &clk, sc.ctx(),
        );
        assert!(namespace::seq_next(&ns) == 3, 100);
        assert!(namespace::batch_index(&ns) == 1, 101);
        let head1 = namespace::last_batch_hash(&ns);
        assert!(head1 != EMPTY_HASH, 102);

        // batch 1: seq 3..3, parent must equal new head
        receipt::anchor_batch(
            &mut ns, &wcap, b"run-1", 3, 3,
            b"root-b", vector[b"b3"], head1,
            &clk, sc.ctx(),
        );
        assert!(namespace::seq_next(&ns) == 4, 103);
        assert!(namespace::batch_index(&ns) == 2, 104);
        assert!(namespace::last_batch_hash(&ns) != head1, 105);

        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 1, location = compliance_vault::receipt)] // seq_gap
fun anchor_seq_gap_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        // expected seq_start == 0, supply 1 → gap
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 1, 1, b"r", vector[b"b"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 2, location = compliance_vault::receipt)] // seq_replay
fun anchor_seq_replay_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        // advance to seq_next = 3
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 2, b"r", vector[b"b0", b"b1", b"b2"], EMPTY_HASH, &clk, sc.ctx(),
        );
        let head = namespace::last_batch_hash(&ns);
        // replay seq_start = 1 (< 3)
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 1, 4, b"r2", vector[b"a", b"b", b"c", b"d"], head, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 3, location = compliance_vault::receipt)] // len_mismatch
fun anchor_blob_len_mismatch_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        // count = 3 but only 2 blob_ids
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 2, b"r", vector[b"b0", b"b1"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 11, location = compliance_vault::receipt)] // parent_hash_mismatch
fun anchor_parent_hash_mismatch_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        // genesis head is empty; supply a bogus parent
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 0, b"r", vector[b"b0"], b"not-the-head", &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::end(sc);
}

// ---------------------------------------------------------------------------
// Cross-tenant cap misuse (C3)
// ---------------------------------------------------------------------------

#[test]
#[expected_failure(abort_code = 9, location = compliance_vault::namespace)] // unauthorized_writer
fun cross_tenant_writer_cap_aborts() {
    let mut sc = ts::begin(ADMIN);
    // namespace A
    let (admin_a, writer_a) = namespace::create_namespace(
        string::utf8(b"agent-a"), mk_policy(), sc.ctx(),
    );
    let id_a = namespace::writer_namespace_id(&writer_a); // == object::id(ns A)
    transfer::public_transfer(admin_a, ADMIN);
    transfer::public_transfer(writer_a, ADMIN);

    // namespace B (foreign tenant) — keep B's writer cap id
    ts::next_tx(&mut sc, ADMIN);
    let (admin_b, writer_b) = namespace::create_namespace(
        string::utf8(b"agent-b"), mk_policy(), sc.ctx(),
    );
    let writer_b_id = object::id(&writer_b);
    transfer::public_transfer(admin_b, ADMIN);
    transfer::public_transfer(writer_b, ADMIN);

    // apply B's writer cap to namespace A → cap.namespace_id != id(ns A)
    ts::next_tx(&mut sc, ADMIN);
    {
        let mut ns_a = ts::take_shared_by_id<AgentNamespace>(&sc, id_a);
        let wcap_b = ts::take_from_sender_by_id<WriterCap>(&sc, writer_b_id);
        let clk = clock::create_for_testing(sc.ctx());
        receipt::anchor_batch(
            &mut ns_a, &wcap_b, b"run", 0, 0, b"r", vector[b"b0"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns_a);
        ts::return_to_sender(&sc, wcap_b);
    };
    ts::end(sc);
}

// ---------------------------------------------------------------------------
// Policy immutability after seal (B/U)
// ---------------------------------------------------------------------------

#[test]
#[expected_failure(abort_code = 5, location = compliance_vault::namespace)] // namespace_sealed
fun update_policy_after_seal_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, ADMIN);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let acap = ts::take_from_sender<AdminCap>(&sc);
        namespace::seal_namespace(&mut ns, &acap);
        namespace::update_policy(&mut ns, &acap, mk_policy()); // should abort
        ts::return_shared(ns);
        ts::return_to_sender(&sc, acap);
    };
    ts::end(sc);
}

// ---------------------------------------------------------------------------
// Merkle inclusion (scaffold sorted-pair; single-leaf == empty proof)
// ---------------------------------------------------------------------------

#[test]
fun merkle_single_leaf_verifies() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    // single-leaf tree: root == leaf_hash(seq, event), proof empty (domain-separated)
    let root = receipt::leaf_hash_for_test(0, b"event-hash-0");
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 0, root, vector[b"b0"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::next_tx(&mut sc, AUDITOR);
    {
        let r = ts::take_immutable<BatchReceipt>(&sc);
        assert!(receipt::verify_event_inclusion(&r, 0, b"event-hash-0", vector[]), 200);
        assert!(!receipt::verify_event_inclusion(&r, 0, b"wrong-leaf", vector[]), 201);
        ts::return_immutable(r);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 10, location = compliance_vault::receipt)] // invalid_merkle_proof (seq out of range)
fun merkle_seq_out_of_range_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    ts::next_tx(&mut sc, WRITER);
    {
        let mut ns = ts::take_shared<AgentNamespace>(&sc);
        let wcap = ts::take_from_sender<WriterCap>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        receipt::anchor_batch(
            &mut ns, &wcap, b"run", 0, 0, b"leaf", vector[b"b0"], EMPTY_HASH, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(ns);
        ts::return_to_sender(&sc, wcap);
    };
    ts::next_tx(&mut sc, AUDITOR);
    {
        let r = ts::take_immutable<BatchReceipt>(&sc);
        // seq 5 not in [0,0]
        receipt::verify_event_inclusion(&r, 5, b"leaf", vector[]);
        ts::return_immutable(r);
    };
    ts::end(sc);
}

// ---------------------------------------------------------------------------
// seal_approve gate (C4) — happy + abort paths
// ---------------------------------------------------------------------------

fun mint_eng(sc: &mut ts::Scenario, filter: vector<string::String>, expires_at_ms: u64) {
    ts::next_tx(sc, ADMIN);
    let ns = ts::take_shared<AgentNamespace>(sc);
    let acap = ts::take_from_sender<AdminCap>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    engagement::mint_engagement(
        &ns, &acap, AUDITOR, b"pubkey",
        0, 1_000_000, filter, expires_at_ms,
        &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_shared(ns);
    ts::return_to_sender(sc, acap);
}

fun ns_id_bytes(sc: &mut ts::Scenario): vector<u8> {
    ts::next_tx(sc, AUDITOR);
    let ns = ts::take_shared<AgentNamespace>(sc);
    let id = namespace::id(&ns);
    let bytes = object::id_to_bytes(&id);
    ts::return_shared(ns);
    bytes
}

#[test]
fun seal_approve_happy_path() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000);
    let id_bytes = ns_id_bytes(&mut sc);

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let mut clk = clock::create_for_testing(sc.ctx());
        clock::set_for_testing(&mut clk, 500);
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"tool_call"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 8, location = compliance_vault::seal_policy)] // scope_mismatch (wrong identity bytes)
fun seal_approve_identity_mismatch_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000);

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        seal_policy::seal_approve_for_test(
            b"wrong-identity", &eng, string::utf8(b"tool_call"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 8, location = compliance_vault::seal_policy)] // scope_mismatch (sender != auditor)
fun seal_approve_wrong_sender_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000);
    let id_bytes = ns_id_bytes(&mut sc);

    ts::next_tx(&mut sc, STRANGER); // not the auditor
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"tool_call"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 6, location = compliance_vault::seal_policy)] // engagement_expired
fun seal_approve_expired_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 100); // expires at 100ms
    let id_bytes = ns_id_bytes(&mut sc);

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let mut clk = clock::create_for_testing(sc.ctx());
        clock::set_for_testing(&mut clk, 101); // 1ms past expiry
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"tool_call"), 50, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 7, location = compliance_vault::seal_policy)] // engagement_revoked
fun seal_approve_revoked_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000);
    let id_bytes = ns_id_bytes(&mut sc);

    // admin revokes
    ts::next_tx(&mut sc, ADMIN);
    {
        let mut eng = ts::take_shared<EngagementObject>(&sc);
        let acap = ts::take_from_sender<AdminCap>(&sc);
        engagement::revoke_engagement(&mut eng, &acap);
        ts::return_shared(eng);
        ts::return_to_sender(&sc, acap);
    };

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"tool_call"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = 8, location = compliance_vault::seal_policy)] // scope_mismatch (event type not in filter)
fun seal_approve_type_filter_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[string::utf8(b"prompt")], 1_000_000); // only "prompt"
    let id_bytes = ns_id_bytes(&mut sc);

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"tool_call"), 500, &clk, sc.ctx(), // "tool_call" not allowed
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

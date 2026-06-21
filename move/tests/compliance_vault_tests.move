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
#[expected_failure(abort_code = compliance_vault::errors::E_SEQ_GAP, location = compliance_vault::receipt)] // seq_gap
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
#[expected_failure(abort_code = compliance_vault::errors::E_SEQ_REPLAY, location = compliance_vault::receipt)] // seq_replay
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
#[expected_failure(abort_code = compliance_vault::errors::E_LEN_MISMATCH, location = compliance_vault::receipt)] // len_mismatch
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
#[expected_failure(abort_code = compliance_vault::errors::E_PARENT_HASH_MISMATCH, location = compliance_vault::receipt)] // parent_hash_mismatch
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
#[expected_failure(abort_code = compliance_vault::errors::E_UNAUTHORIZED_WRITER, location = compliance_vault::namespace)] // unauthorized_writer
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
#[expected_failure(abort_code = compliance_vault::errors::E_NAMESPACE_SEALED, location = compliance_vault::namespace)] // namespace_sealed
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
#[expected_failure(abort_code = compliance_vault::errors::E_INVALID_MERKLE_PROOF, location = compliance_vault::receipt)] // invalid_merkle_proof (seq out of range)
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

// Full day-0 grant [0 .. 86_399_999]. Day-aligned so the day-coverage gate
// (Stage C leak fix) passes for any ts in epoch_day 0 — the honest grant shape
// now that the released IBE key is day-grained.
fun mint_eng(sc: &mut ts::Scenario, filter: vector<string::String>, expires_at_ms: u64) {
    mint_eng_scoped(sc, filter, 0, 86_399_999, expires_at_ms);
}

fun mint_eng_scoped(
    sc: &mut ts::Scenario,
    filter: vector<string::String>,
    scope_start_ms: u64,
    scope_end_ms: u64,
    expires_at_ms: u64,
) {
    ts::next_tx(sc, ADMIN);
    let ns = ts::take_shared<AgentNamespace>(sc);
    let acap = ts::take_from_sender<AdminCap>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    engagement::mint_engagement(
        &ns, &acap, AUDITOR, b"pubkey",
        scope_start_ms, scope_end_ms, filter, expires_at_ms,
        &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_shared(ns);
    ts::return_to_sender(sc, acap);
}

/// Returns the namespace ID (not bytes) for use in bucket_id computation.
fun ns_id(sc: &mut ts::Scenario): sui::object::ID {
    ts::next_tx(sc, AUDITOR);
    let ns = ts::take_shared<AgentNamespace>(sc);
    let id = namespace::id(&ns);
    ts::return_shared(ns);
    id
}

#[test]
fun seal_approve_happy_path() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000);
    let nid = ns_id(&mut sc);
    // ts=500ms -> epoch_day=0 ; type="tool_call"
    let id_bytes = seal_policy::bucket_id_for_test(nid, 500, string::utf8(b"tool_call"));

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
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)] // scope_mismatch (wrong identity bytes)
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
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)] // scope_mismatch (sender != auditor)
fun seal_approve_wrong_sender_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000);
    let nid = ns_id(&mut sc);
    let id_bytes = seal_policy::bucket_id_for_test(nid, 500, string::utf8(b"tool_call"));

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
#[expected_failure(abort_code = compliance_vault::errors::E_ENGAGEMENT_EXPIRED, location = compliance_vault::seal_policy)] // engagement_expired
fun seal_approve_expired_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 100); // expires at 100ms
    let nid = ns_id(&mut sc);
    // ts=50ms -> epoch_day=0 ; correct bucket id so we reach expiry check
    let id_bytes = seal_policy::bucket_id_for_test(nid, 50, string::utf8(b"tool_call"));

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
#[expected_failure(abort_code = compliance_vault::errors::E_ENGAGEMENT_REVOKED, location = compliance_vault::seal_policy)] // engagement_revoked
fun seal_approve_revoked_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000);
    let nid = ns_id(&mut sc);
    let id_bytes = seal_policy::bucket_id_for_test(nid, 500, string::utf8(b"tool_call"));

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
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)] // scope_mismatch (event type not in filter)
fun seal_approve_type_filter_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[string::utf8(b"prompt")], 1_000_000); // only "prompt"
    let nid = ns_id(&mut sc);
    // Use correct bucket for "tool_call" so we reach the type-filter check
    let id_bytes = seal_policy::bucket_id_for_test(nid, 500, string::utf8(b"tool_call"));

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"tool_call"), 500, &clk, sc.ctx(), // "tool_call" not in filter ["prompt"]
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

// ---------------------------------------------------------------------------
// Bucket-scope tests (Task 1, Stage C) — per-(day, event_type) IBE binding
// ---------------------------------------------------------------------------

#[test]
fun seal_approve_correct_bucket_passes() {
    // Engagement scope: [0 .. 1_000_000], filter=["login"], auditor=AUDITOR, not revoked.
    // ts=500ms -> epoch_day=0 ; type="login" -> compute correct bucket id -> passes
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[string::utf8(b"login")], 1_000_000);
    let nid = ns_id(&mut sc);
    let id_bytes = seal_policy::bucket_id_for_test(nid, 500, string::utf8(b"login"));

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let mut clk = clock::create_for_testing(sc.ctx());
        clock::set_for_testing(&mut clk, 500);
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"login"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)] // scope_mismatch (bucket for day D+1 != bucket for day D)
fun seal_approve_wrong_day_id_aborts() {
    // id derived for epoch_day=1 (ts=86_400_000+500) but requested_ts_ms=500 (epoch_day=0) -> mismatch
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[string::utf8(b"login")], 1_000_000);
    let nid = ns_id(&mut sc);
    // bucket for day D+1 = 86_400_000 + 500
    let next_day_ts: u64 = 86_400_500;
    let wrong_id = seal_policy::bucket_id_for_test(nid, next_day_ts, string::utf8(b"login"));

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        // requested_ts_ms=500 (day 0) but id is for day 1 -> bucket mismatch
        seal_policy::seal_approve_for_test(
            wrong_id, &eng, string::utf8(b"login"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)] // scope_mismatch (bucket for "login" != bucket for "logout")
fun seal_approve_wrong_type_id_aborts() {
    // id derived for type "login" but requested_event_type = "logout" -> mismatch
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[], 1_000_000); // empty filter = all types
    let nid = ns_id(&mut sc);
    let wrong_id = seal_policy::bucket_id_for_test(nid, 500, string::utf8(b"login"));

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        // id is for "login" but we request "logout"
        seal_policy::seal_approve_for_test(
            wrong_id, &eng, string::utf8(b"logout"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)] // scope_mismatch (requested day outside grant)
fun seal_approve_out_of_scope_ts_aborts() {
    // Grant covers day 0 only ([0 .. 86_399_999]). Request a CORRECT bucket for
    // day 1 (ts=86_400_500): id-binding passes, but the day-coverage gate sees
    // day 1 = [86_400_000 .. 172_799_999] is NOT inside the grant -> abort.
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng(&mut sc, vector[string::utf8(b"login")], 200_000_000);
    let nid = ns_id(&mut sc);
    let ts_out: u64 = 86_400_500; // epoch_day=1, outside the day-0 grant
    let id_bytes = seal_policy::bucket_id_for_test(nid, ts_out, string::utf8(b"login"));

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"login"), ts_out, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)] // scope_mismatch (sub-day grant cannot unlock day bucket)
fun seal_approve_subday_grant_denied() {
    // REGRESSION (Stage C day-grain edge-leak fix): a sub-day grant
    // [0 .. 1_000_000] (~16.6 min) must NOT release the day-0 bucket key, which
    // would decrypt the WHOLE day (~288 batches). Everything else is correct
    // (id-binding, sender, type, ts in [start,end]) — only the day-coverage gate
    // denies, proving the released key's breadth can never exceed the grant.
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint_eng_scoped(&mut sc, vector[string::utf8(b"login")], 0, 1_000_000, 200_000_000);
    let nid = ns_id(&mut sc);
    let id_bytes = seal_policy::bucket_id_for_test(nid, 500, string::utf8(b"login"));

    ts::next_tx(&mut sc, AUDITOR);
    {
        let eng = ts::take_shared<EngagementObject>(&sc);
        let mut clk = clock::create_for_testing(sc.ctx());
        clock::set_for_testing(&mut clk, 500);
        seal_policy::seal_approve_for_test(
            id_bytes, &eng, string::utf8(b"login"), 500, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(eng);
    };
    ts::end(sc);
}

// ABI lock (spec §8): the magic-abort sweep made `expected_failure` reference
// errors::E_* constants, so renumbering errors.move would update both source and
// test in lockstep and pass silently. These codes are ABI-stable — pin the numeric
// values here via the public accessors so any renumber fails loudly.
#[test]
fun error_codes_abi_stable() {
    use compliance_vault::errors;
    assert!(errors::seq_gap() == 1, 0);
    assert!(errors::seq_replay() == 2, 0);
    assert!(errors::len_mismatch() == 3, 0);
    assert!(errors::policy_immutable() == 4, 0);
    assert!(errors::namespace_sealed() == 5, 0);
    assert!(errors::engagement_expired() == 6, 0);
    assert!(errors::engagement_revoked() == 7, 0);
    assert!(errors::scope_mismatch() == 8, 0);
    assert!(errors::unauthorized_writer() == 9, 0);
    assert!(errors::invalid_merkle_proof() == 10, 0);
    assert!(errors::parent_hash_mismatch() == 11, 0);
    assert!(errors::unauthorized() == 12, 0);
    assert!(errors::seq_overflow() == 13, 0);
}

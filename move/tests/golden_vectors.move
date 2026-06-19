#[test_only]
/// Emits authoritative leaf/internal/batch_hash hex so the off-chain SDK conformance
/// test (sdk/test/conformance.test.ts) can assert byte-for-byte equality against the
/// real Move implementation. Re-derives the same primitives receipt.move uses and
/// cross-checks leaf against receipt::leaf_hash_for_test.
module compliance_vault::golden_vectors;

use std::hash;
use std::bcs;
use std::debug;
use sui::object;

fun sha(b: vector<u8>): vector<u8> { hash::sha2_256(b) }

fun leaf(seq: u64, eh: vector<u8>): vector<u8> {
    let mut buf = vector[0x00u8];
    vector::append(&mut buf, bcs::to_bytes(&seq));
    vector::append(&mut buf, eh);
    sha(buf)
}

fun le(a: &vector<u8>, b: &vector<u8>): bool {
    let n = vector::length(a);
    let mut i = 0;
    while (i < n) {
        let av = *vector::borrow(a, i);
        let bv = *vector::borrow(b, i);
        if (av < bv) return true;
        if (av > bv) return false;
        i = i + 1;
    };
    true
}

fun internal(a: vector<u8>, b: vector<u8>): vector<u8> {
    let mut buf = vector[0x01u8];
    if (le(&a, &b)) { vector::append(&mut buf, a); vector::append(&mut buf, b); }
    else { vector::append(&mut buf, b); vector::append(&mut buf, a); };
    sha(buf)
}

fun batch_hash(parent: vector<u8>, root: vector<u8>, ss: u64, se: u64): vector<u8> {
    let mut buf = parent;
    vector::append(&mut buf, root);
    vector::append(&mut buf, bcs::to_bytes(&ss));
    vector::append(&mut buf, bcs::to_bytes(&se));
    sha(buf)
}

#[test]
fun emit_golden() {
    let eh0 = sha(vector[1u8]);
    let eh1 = sha(vector[2u8]);
    let eh2 = sha(vector[3u8]);

    let l0 = leaf(0, eh0);
    let l1 = leaf(1, eh1);
    let l2 = leaf(2, eh2);

    // cross-check against the contract's own leaf hasher
    assert!(l0 == compliance_vault::receipt::leaf_hash_for_test(0, eh0), 0);

    let two_root = internal(l0, l1);
    let three_root = internal(internal(l0, l1), l2); // odd promote: l2 carried up
    let bh_genesis = batch_hash(vector[], two_root, 0, 1);
    let bh_chained = batch_hash(bh_genesis, l2, 2, 2);

    // Fixed print order (no labels): leaf0, leaf1, leaf2, two_root, three_root, bh_genesis, bh_chained
    debug::print(&l0);
    debug::print(&l1);
    debug::print(&l2);
    debug::print(&two_root);
    debug::print(&three_root);
    debug::print(&bh_genesis);
    debug::print(&bh_chained);
}

#[test]
fun emit_bucket_vectors() {
    // Fixed namespace id = 0x11 * 32 (matches sdk/test fixture NS = '0x'+'11'.repeat(32)).
    let ns_bytes = x"1111111111111111111111111111111111111111111111111111111111111111";
    let ns_id = object::id_from_bytes(ns_bytes);
    // Case A: ts = 1_700_000_000_000 ms, type = "login"
    debug::print(&compliance_vault::seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"login")));
    // Case B: ts = 1_700_006_400_000 ms, type = "login"
    debug::print(&compliance_vault::seal_policy::bucket_id_for_test(ns_id, 1_700_006_400_000, std::string::utf8(b"login")));
    // Case C: NUL-prefixed type
    debug::print(&compliance_vault::seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"\x00login")));
    // Case D: empty type
    debug::print(&compliance_vault::seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"")));
    // Case E: multi-byte UTF-8 type ("登入")
    debug::print(&compliance_vault::seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"\xe7\x99\xbb\xe5\x85\xa5")));
}

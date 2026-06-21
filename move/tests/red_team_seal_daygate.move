/// sui-red-team — focused adversarial review of the DAY-COVERAGE gate in
/// seal_policy::seal_approve (Stage C day-grain edge-leak fix).
/// Probes: (1) u64 overflow of day_end near u64::MAX, (2) sub-day grant cannot
/// unlock a full day, (3) multi-day grant covers exactly its full days,
/// (4) id-day vs requested_ts-day mismatch.
#[test_only]
module compliance_vault::red_team_seal_daygate;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use compliance_vault::namespace::{Self, AgentNamespace, AdminCap, WriterCap};
use compliance_vault::engagement::{Self, EngagementObject};
use compliance_vault::policy::{Self, PolicyObject};
use compliance_vault::seal_policy;

const ADMIN: address = @0xA;
const WRITER: address = @0x111;
const AUDITOR: address = @0xA0D;

const MS_PER_DAY: u64 = 86_400_000;
const TYPE: vector<u8> = b"tool_call";

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

fun mint(sc: &mut ts::Scenario, start: u64, end: u64) {
    ts::next_tx(sc, ADMIN);
    let ns = ts::take_shared<AgentNamespace>(sc);
    let acap = ts::take_from_sender<AdminCap>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    engagement::mint_engagement(
        &ns, &acap, AUDITOR, b"pubkey", start, end, vector[], 1_000_000_000_000_000, &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_shared(ns);
    ts::return_to_sender(sc, acap);
}

fun nsid(sc: &mut ts::Scenario): sui::object::ID {
    ts::next_tx(sc, AUDITOR);
    let ns = ts::take_shared<AgentNamespace>(sc);
    let id = namespace::id(&ns);
    ts::return_shared(ns);
    id
}

/// Drive seal_approve with an honest id bound to (ts, TYPE). clock set in-range.
fun approve(sc: &mut ts::Scenario, nid: sui::object::ID, ts_ms: u64) {
    let id = seal_policy::bucket_id_for_test(nid, ts_ms, string::utf8(TYPE));
    ts::next_tx(sc, AUDITOR);
    let eng = ts::take_shared<EngagementObject>(sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    clock::set_for_testing(&mut clk, 1); // well before expiry
    seal_policy::seal_approve_for_test(id, &eng, string::utf8(TYPE), ts_ms, &clk, sc.ctx());
    clock::destroy_for_testing(clk);
    ts::return_shared(eng);
}

// ===========================================================================
// VECTOR 1 — Integer overflow of day_end near u64::MAX.
// u64::MAX/MS_PER_DAY = 213503982334. day_start = 213503982334*MS_PER_DAY =
// 18446744073657600000. day_end = day_start + 86_400_000 - 1 = 18446744073743999999
// which EXCEEDS u64::MAX (18446744073709551615) -> Move u64 ADD ABORTS (arith err).
// Grant the maximal possible scope so coverage would pass IF no overflow; the
// only thing that can stop release here is the overflow abort itself.
// EXPECT: arithmetic abort (code 0x..0001 EXECUTION arith), NOT a release and
// NOT a scope_mismatch -> overflow is a hard abort = fail-closed, NOT a bypass.
// ===========================================================================
#[test]
#[expected_failure(arithmetic_error, location = compliance_vault::seal_policy)]
fun rt_v1_dayend_overflow_aborts() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    let max = 18446744073709551615; // u64::MAX
    mint(&mut sc, 0, max);          // widest grant possible
    let nid = nsid(&mut sc);
    // ts in the final partial day. day_end add overflows.
    approve(&mut sc, nid, max);
    ts::end(sc);
}

// ===========================================================================
// VECTOR 2 — sub-day grant must NOT unlock a full day.
// Grant covers [day1_start .. day1_start + 100] (a sub-day sliver inside day 1).
// Auditor requests ts in day 1. day_start(day1) < scope_start -> coverage fails.
// EXPECT: scope_mismatch abort.
// ===========================================================================
#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)]
fun rt_v2_subday_grant_denied() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    let d1 = MS_PER_DAY; // start of day 1
    mint(&mut sc, d1, d1 + 100); // sub-day sliver
    let nid = nsid(&mut sc);
    approve(&mut sc, nid, d1 + 50); // ts within the sliver, but day not fully covered
    ts::end(sc);
}

// ===========================================================================
// VECTOR 3a — multi-day grant covers exactly its full days (D1..D3 inclusive).
// Grant = [day1_start .. day4_start - 1] = full days 1,2,3.
// Requests at start of D1, mid D2, last ms of D3 all RELEASE.
// EXPECT: no abort.
// ===========================================================================
#[test]
fun rt_v3a_multiday_inner_days_release() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    let start = 1 * MS_PER_DAY;
    let end = 4 * MS_PER_DAY - 1; // through end of day 3
    mint(&mut sc, start, end);
    let nid = nsid(&mut sc);
    approve(&mut sc, nid, 1 * MS_PER_DAY);             // first ms of D1
    approve(&mut sc, nid, 2 * MS_PER_DAY + 12345);     // mid D2
    approve(&mut sc, nid, 4 * MS_PER_DAY - 1);         // last ms of D3
    ts::end(sc);
}

// VECTOR 3b — and NOTHING outside: day 0 (just below) is denied.
#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)]
fun rt_v3b_multiday_day_below_denied() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint(&mut sc, 1 * MS_PER_DAY, 4 * MS_PER_DAY - 1);
    let nid = nsid(&mut sc);
    approve(&mut sc, nid, MS_PER_DAY - 1); // ts in day 0 -> day not covered
    ts::end(sc);
}

// VECTOR 3c — day 4 (just above) is denied.
#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)]
fun rt_v3c_multiday_day_above_denied() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint(&mut sc, 1 * MS_PER_DAY, 4 * MS_PER_DAY - 1);
    let nid = nsid(&mut sc);
    approve(&mut sc, nid, 4 * MS_PER_DAY); // first ms of day 4 -> day_end > scope_end
    ts::end(sc);
}

// ===========================================================================
// VECTOR 4 — id-day vs requested_ts-day mismatch.
// id is recomputed inside seal_approve from THE SAME requested_ts_ms via
// bucket_id(ns, requested_ts_ms, type). The caller cannot supply an id whose
// epoch_day differs from requested_ts_ms's day and still pass assert (1): the
// id equality check rebinds both to the same ts. So coverage is ALWAYS checked
// against requested_ts_ms's day, which is the day the released key unlocks.
// Here we PROVE the binding: build id from a DIFFERENT ts (day 0) but pass
// requested_ts_ms in day 1. assert (1) id==bucket_id(.,requested_ts,.) FAILS
// because bucket(day0) != bucket(day1).
// EXPECT: scope_mismatch (identity bytes mismatch) at assert (1).
// ===========================================================================
#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH, location = compliance_vault::seal_policy)]
fun rt_v4_id_day_vs_ts_day_mismatch_denied() {
    let mut sc = ts::begin(ADMIN);
    bootstrap(&mut sc);
    mint(&mut sc, 0, 4 * MS_PER_DAY - 1); // wide grant so only assert(1) can stop us
    let nid = nsid(&mut sc);
    // id bound to day 0 (ts=500), but we pass requested_ts in day 1.
    let id_day0 = seal_policy::bucket_id_for_test(nid, 500, string::utf8(TYPE));
    ts::next_tx(&mut sc, AUDITOR);
    let eng = ts::take_shared<EngagementObject>(&sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    clock::set_for_testing(&mut clk, 1);
    seal_policy::seal_approve_for_test(
        id_day0, &eng, string::utf8(TYPE), MS_PER_DAY + 500, &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_shared(eng);
    ts::end(sc);
}

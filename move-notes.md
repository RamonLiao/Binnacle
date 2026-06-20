# Move Notes — ComplianceVault

> Architecture-level decisions and on-chain constraints. Update after each Move task.

## 2026-05-30 — sui-architect review of spec v0.1 → v0.2

**Purpose:** audit architecture spec for SUI best practices (object model, caps, upgradeability) before scaffolding. No code written yet.

**Spec:** `docs/specs/2026-05-28-compliance-vault-spec.md` bumped v0.1 → v0.2. Full review log in spec §19.

### Object ownership model (the big gap in v0.1 — was unspecified)
| Object | Disposition | Why |
|--------|-------------|-----|
| `AgentNamespace` | **shared** | writer (WriterCap) ≠ admin (AdminCap) address; both need `&mut` → must be shared (B1) |
| `EngagementObject` | **shared** | admin revokes (`&mut`) + Seal reads (`&`); auditor is neither sole owner → shared, auth by `auditor_addr` field (B3) |
| `BatchReceipt` | **frozen** | write-once, public-read for verification; `freeze_object` (E1) |
| `AuditorAttestation` | **frozen** | immutable report anchor |
| `CoverageHeartbeat` | **shared** | off-chain watcher posts gap txs |
| `PolicyObject` | **embedded** (field of AgentNamespace, has `store,drop`, no UID) | hot path needs to read its fields; `ID` can't field-read (B4) |
| `AdminCap`, `WriterCap` | **owned** (`key,store`) | transferred to distinct addresses |

### Key correctness fixes
- **WriterCap** is a separate owned object (closed `[A:3]`). `anchor_batch(ns, cap: &WriterCap, ...)`. Leaked agent key ≠ admin powers.
- **Hash chain now enforced on-chain (C2):** `AgentNamespace.last_batch_hash` stored; `anchor_batch` asserts `parent_batch_hash == ns.last_batch_hash`, then advances. v0.1 took caller-supplied hash with nothing to compare → chain was fake. This is THE core tamper-evidence invariant.
- **Every cap-gated fn asserts `cap.namespace_id == object::id(target)` (C3)** — else cross-tenant cap misuse.
- **Constructors don't return key-only objects (B2):** share/freeze internally, return only `store`-bearing caps.

### Seal integration (confirmed via sui-seal, closes `[A:1]`)
- Move side: `entry fun seal_approve*(id: vector<u8>, ...)` — name MUST start `seal_approve`, first param MUST be `id: vector<u8>`. **Aborts = deny, returns = release share.** NOT a bool getter (was wrong in v0.1).
- **identity `id` = `namespace_id` bytes** — each namespace is its own IBE key domain. Encrypt with `id = <namespace_id>`.
- Key server **dry-runs** an `onlyTransactionKind` PTB and **injects the session-key address as sender** → `ctx.sender() == eng.auditor_addr` check is valid (mechanism behind B3).
- k=2/n=3 supported: SDK `threshold: 2` + three `serverConfigs[].objectId` (object IDs, NOT URLs), weight 1 each.
- SDK: `@mysten/seal ^1.1`, peer `@mysten/sui ^2.16.2`. `SealClient` instantiated directly — NOT `$extend()`. `suiClient` must be v2.x gRPC/JSON-RPC. Don't mix `@mysten/sui` 1.x and 2.x.

### Gas / efficiency
- **blob_ids moved off-chain (E2):** receipt stores only 32B `blob_ids_digest`; full list rides `BatchAnchored` event. ~50-70% storage saving; revised anchor ~1.5-2M MIST (was ~3M).
- **Throughput ceiling (E3):** all batches for one namespace serialize through the single shared `seq_next`/`last_batch_hash` object. Unavoidable cost of monotonic tamper-evidence. Scale = shard across namespaces (SDK fans out by run_id).

### Upgradeability (U1)
- `version: u16` on ALL persisted objects from day 1 + `public(package)` internal mutators. Frozen receipts exempt (append-only, never migrate).

## On-chain constraints to remember when scaffolding
- Move 2024 edition, package `compliance_vault`.
- `id == object::id(eng.namespace_id).to_bytes()` binding in seal_approve (verify exact API: `ID::to_bytes` / `object::id_to_bytes`).
- Overflow guard: `seq_end - seq_start + 1 <= BATCH_MAX` and `seq_end < u64::MAX - BATCH_MAX`.
- Error codes centralized in errors.move (added E_UNAUTHORIZED=12, E_SEQ_OVERFLOW=13).

## 2026-05-30 — Move scaffold (TODO #1, all 9 modules)

**Purpose:** scaffold `move/sources/*.move` from spec v0.2 §3–§5,§7,§8. Package `compliance_vault`, edition 2024.beta.

**Result:** `sui move build` → **exit 0**, no errors. Only W99010 lint warnings (`public entry` redundant), since fixed → `public fun`. CLI is **1.71.0** (spec targets 1.72.2/protocol 124 — minor drift, builds fine).

**Files:** errors, events, policy, namespace, receipt, engagement, seal_policy, attestation, coverage (9) + Move.toml.

**Scaffold decisions that deviate from / refine the spec (review these):**
1. **errors.move uses `public fun` accessors, not `const`** — Move constants are module-private and can't be shared across modules. `assert!(c, errors::seq_gap())` only evaluates the fn on the abort path (no happy-path gas). ABI numbers unchanged (1–13).
2. **`update_policy` + `seal_namespace` live in `namespace.move`, not `policy.move`** — spec §5.1 placed `update_policy` in policy, but it needs `AgentNamespace` while `namespace` already imports `policy` (embeds `PolicyObject`) → would be a circular module dep, which Move forbids. `policy.move` is now a leaf (types + constructors + accessors only).
3. **`BATCH_MAX_EVENTS = 4096`** in receipt.move — on-chain DoS/overflow guard ONLY, decoupled from the SDK's 256-event flush trigger `[A:4]`. Tune later.
4. **Merkle = sorted-pair (lexicographic), scaffold** — `verify_event_inclusion` needs no direction bits, but the **SDK prover MUST build the tree identically**. Confirm before wiring real proofs. (Flagged in code.)
5. **batch_hash preimage = `sha2_256(parent || merkle_root || bcs(seq_start) || bcs(seq_end))`** — SDK must match byte-for-byte (bcs LE u64). (C2 chain.)
6. `seal_approve` identity binding implemented as `id == object::id_to_bytes(&eng.namespace_id)` — compiled OK against 1.71 framework (confirms `[A:1]` API note).
7. `record_observation` (coverage) is permissionless; gas payer still undecided (§16.7).

**Object dispositions honored:** AgentNamespace/EngagementObject/CoverageHeartbeat shared; BatchReceipt/AuditorAttestation frozen (key-only); PolicyObject embedded by value; AdminCap/WriterCap owned; version:u16 on all persisted objects.

**Not yet done at scaffold time:** SDK/indexer/UI. (Tests added next — see below.)

## 2026-05-30 — Move tests (TODO #2)

**Result:** `sui move test` → **15/15 PASS, 0 fail**, no warnings.

**File:** `move/tests/compliance_vault_tests.move` (test_scenario, distinct ADMIN/WRITER/AUDITOR/STRANGER addresses per B1/B3).

**Covered (spec §13.1):** two-batch hash-chain advance + seq gap/replay/len/parent-hash aborts (C2); cross-tenant WriterCap abort (C3); policy immutability after seal_namespace; merkle single-leaf pass/fail + out-of-range abort; seal_approve happy path + 5 abort paths — identity/sender/expired/revoked/type-filter (C4).

**Test gotchas hit (for next time):**
1. `@0xAUD` — `U` is not a hex digit; address literals must be valid hex. Cascaded into "unbound AUDITOR".
2. `#[expected_failure(abort_code = N)]` alone warns (W10007, matches any module). Add `location = compliance_vault::<module>` — and the module is where the `assert!` runs (e.g. `unauthorized_writer` aborts in `namespace::assert_writer`, not `receipt`).
3. Private `entry fun seal_approve` can't be called from an external test module → added `#[test_only] public fun seal_approve_for_test` bridge in seal_policy.move.
4. `take_shared<T>` is ambiguous with multiple shared objects of the same type → use `take_shared_by_id` / `take_from_sender_by_id` (cross-tenant test creates 2 namespaces).

**Still untested (deferred):** multi-leaf merkle (needs SDK-aligned sorted-pair tree), property-based random anchor sequences, monkey/edge cases (§13.3), gas benchmarks. Coverage report not yet run (`sui move test --coverage`).

## 2026-05-31 — Move review chain (TODO #3): move-code-quality → security-guard → red-team

**Result:** `sui move test` → **20/20 PASS** (15 original + 5 red-team regression). 3 exploits found & fixed.

### 🔴 Fixed (red-team EXPLOITED → DEFENDED)
- **RT1+RT2 (receipt.move, merkle)** — scaffold's sorted-pair tree had NO domain
  separation and did NOT bind `seq` into the leaf. Two exploits:
  - position forgery: one proof verified an event at any in-range `seq`;
  - internal-node-as-leaf: an internal node passed `verify_event_inclusion` as a "member".
  **Fix (RFC 6962):** `leaf_hash(seq, e) = sha256(0x00 ++ bcs(seq) ++ e)`,
  `hash_pair = sha256(0x01 ++ min ++ max)`. Added `#[test_only]`
  `leaf_hash_for_test` / `hash_pair_for_test` so tests build trees off the real impl.
- **RT3 (coverage.move)** — `record_observation` was permissionless AND trusted
  caller-supplied `expected_next` / `now_ms`, never reading chain state.
  **Fix:** now takes `ns: &AgentNamespace` + `clock: &Clock`; `expected_next =
  namespace::seq_next(ns)`, time from clock, and asserts `hb.namespace_id ==
  id(ns)` (abort 12). **RESIDUAL (accepted):** `seq_observed` is irreducibly
  off-chain, so false-positive gap spam is still possible — CoverageGapDetected is
  advisory only; posting auth/gas deferred (§16.7, [A:4]).

### ⚠️ Quality (move-code-quality) + security-guard
- **Q1 / Move.toml** — removed explicit `Sui` dep → implicit (Sui 1.45+). Build still green.
- **S1 / .gitignore** — added `.env*`, `*.pem`, `*.key` (was only ignoring tasks/*.md).
- Deferred cosmetic: vector method-syntax (`vector::x()` → `.x()`), `do_ref!` macro,
  `EPascalCase` error consts — NOT changed (adjacent-code churn, behavior-neutral).
- security-guard: secret scan CLEAN; caps not public-transferred (B2); pre-commit
  hook deferred (dir not yet a git repo).

### ⛓️ SDK HARD CONSTRAINT (supersedes scaffold #4/#5)
The off-chain SDK prover MUST mirror byte-for-byte:
- leaf = `sha256(0x00 || bcs_le_u64(seq) || event_hash)`
- internal = `sha256(0x01 || min(a,b) || max(a,b))` (lexicographic sort, no direction bits)
- single-leaf root = the leaf hash (empty proof)
- batch_hash preimage unchanged: `sha256(parent || merkle_root || bcs(seq_start) || bcs(seq_end))`
  — NOTE: parent/merkle_root are raw-appended (not length-prefixed); safe ONLY because both
  are 32B sha256 outputs (or empty genesis parent). No on-chain length assert yet — low-risk
  flag, revisit if root provenance ever changes.

## Known risks / open
- `[A:4]` batch 256/5s — tune after load test (non-blocking).
- `seal_approve` exact identity-binding API call (`ID`→bytes) to confirm at code time against `@mysten/sui` 2.16.2 framework.
- CoverageGapDetected watcher gas payer undecided (§16.7).
- Merkle scheme + batch_hash preimage must be mirrored exactly in the SDK (scaffold decisions 4 & 5 above).

---

## 2026-05-31 — Testnet deploy (sui-deployer, §14 Stage 3)

- **PACKAGE_ID**: `0xcb5cc62066b4bbc2e66961b48d5141f9cf3ec119e33a7f6d6ec235a1d413b14c`
- **UpgradeCap**: `0xb55e338151c217da6fac4f8cc8fbc2b1b08e8df4eb9e35abb8a6fae66b976894` (owner = deployer `0x1509…bc4c`)
- **Tx digest**: `4cxESEGZtLT6us6uf3o7SBdiPjBvjxJ1LicF799dqink` (checkpoint 342977447)
- Network: testnet. CLI 1.71.0. Gas spent ~0.085 SUI (budget 0.5).
- Modules (9): attestation, coverage, engagement, errors, events, namespace, policy, receipt, seal_policy.
- Gate met: `sui move test` 20/20, `sui move build` green, dry-run success.
- Artifacts saved: `docs/deploy-testnet-2026-05-31.json`.
- Wired PACKAGE_ID → `indexer/.env` (created from .env.example) + `apps/auditor-ui/.env.local`.
- ⚠️ UpgradeCap still in deployer address. Spec §14 requires 2-of-3 multisig transfer — that gate is **mainnet (Stage 4)**, deferred. For testnet/hackathon, keep in deployer.

## 2026-06-14 — SDK Stage A: golden-vector conformance for merkle/batch_hash
- Added `move/tests/golden_vectors.move::emit_golden` (test-only): re-derives leaf/internal/batch_hash identically to `receipt.move` and `debug::print`s authoritative hex; cross-checks leaf against `receipt::leaf_hash_for_test`. Move suite now 21/21.
- Off-chain `sdk/` (`core/merkle.ts`) is locked byte-for-byte to these golden vectors via `sdk/test/conformance.test.ts` (7/7). Covers single-leaf, two-leaf, **odd-three (promote path)**, batch_hash genesis+chained. Any future drift in Move/SDK → red test, fail loud.
- **Decision (surgical):** did NOT merge the three merkle impls (Move / indexer seed.ts / auditor-ui lib/merkle.ts). They already matched; conformance test is the contract that keeps them aligned. seed.ts/UI untouched.
- event_hash = `sha256(cbor.encodeCanonical(event))` — SDK-owned (Move never computes it), so canonicalization is internal; not part of on-chain conformance.
- `buildAnchorTx` builds the unsigned `receipt::anchor_batch` PTB. Shared `AgentNamespace` ref resolution is deferred to a client-bearing signer (Stage B) — Stage A tests inspect arg structure via `tx.getData()`, not `tx.build()`. `tx.pure.vector('vector<u8>', blobIds.map(Array.from))` required (Uint8Array[] not directly assignable).

## 2026-06-18 — Stage B e2e runners built (impl); run log TBD by user
Added `sdk/scripts/{_grpc,bootstrap-namespace,anchor-e2e}.ts` + `scripts/README.md` (TODO #13). Bootstrap creates a testnet `AgentNamespace`+`WriterCap` via `policy::new_policy`(enc_none, no seal, empty allowlist) → `namespace::create_namespace('e2e-agent', policy)`, prints `NAMESPACE_ID`/`WRITER_CAP_ID`/`NAMESPACE_INIT_VERSION`. anchor-e2e reads live `seq_next`/`last_batch_hash` over gRPC `getObject({json:true})`, builds a synthetic single-leaf batch at `seq=seq_next`, anchors via `AnchorClient` (mock blobId). typecheck green, 49/49 tests.

### Stage B e2e run log — DONE 2026-06-19 (§6 CLOSED)
- gRPC endpoint used: `https://fullnode.testnet.sui.io:443` (default).
- Signer: testnet addr `0x1509b5fd…bc4c` (~22 SUI). gas budget auto-resolved by SDK `signAndExecuteTransaction` (no manual `setGasBudget` needed).
- **§6 residual — CLOSED.** gRPC `SuiGrpcClient` DID auto-resolve the shared `AgentNamespace` (read live `seq_next`/`last_batch_hash`) + owned `WriterCap` + gas at execute time. No `tx.sharedObjectRef` / explicit-shared-ref fallback needed. Two anchors chained correctly (seq 0 → seq 1, parentBatchHash read back from chain).
- **`last_batch_hash` json render shape = base64 string** (NOT number[] and NOT 0x-hex, contrary to the impl's original assumption). 32-byte value → 44-char base64 (e.g. `"T0yEAv9f…sEg="`). The original `toBytes` decoded it as hex → 22 bytes → contract aborted `parentBatchHash must be empty or 32 bytes`. **Fixed** `anchor-e2e.ts::toBytes` to base64-decode non-0x strings. typecheck + 49/49 tests green after fix.
- Objects (testnet): `NAMESPACE_ID=0x5b4b0c32be8b0f93d58f9c79a8c1ef36bb92afdab7f978c5f50521f517f1af2d`, `WRITER_CAP_ID=0x2ccd045e204e829b98c2cf529683db81d9631321b647924790869f0d20e44376`, `NAMESPACE_INIT_VERSION=907204254`.
- Digests: bootstrap `EW2rvFRCH7PmeW9NStv5ToPmNXPwbTknFWF5Hii55afh` | anchor seq0 `b63BbPVhmF1PH6MpRqeSwggezmcrSAEc2zSmXBto14C` | anchor seq1 `37TZ72fg3o5JVfWE172oBhoj4DK2JqB7w6CWQq9yGkCY`.
- **2nd surprise — bootstrap read-after-write lag.** bootstrap tx succeeded on-chain but the post-exec `getObject` (WriterCap-type probe loop) returned `Object … not found` over gRPC (fullnode hadn't indexed the freshly-created object yet) → script exit 1 *after* the tx finalized. Recovered the IDs via CLI (`sui client object`). Bootstrap is one-shot so it didn't matter here, but the probe-immediately-after-create pattern is fragile — a retry/short-delay on `getObject` would harden it.

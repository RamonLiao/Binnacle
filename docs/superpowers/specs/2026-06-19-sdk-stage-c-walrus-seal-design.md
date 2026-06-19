# SDK Stage C — Real Walrus Upload + Seal Encryption (Prover side)

> Date: 2026-06-19
> Status: Design v0.3 — two review rounds integrated (architect + guard + red-team, then a red-team re-review of the v0.2 fixes); pending spec review
> Depends on: Stage A (`core`/`tx`), Stage B (`client/signer` + `AnchorClient`), testnet deployment (`PACKAGE_ID`, `NAMESPACE_ID`, `WRITER_CAP_ID`)
> Supersedes the `MOCK_BLOB_ID` (32×`0xaa`) placeholder in `scripts/anchor-e2e.ts`.

## 0. Review changelog

**Round 1 (v0.1 → v0.2):** architect + guard + red-team:

| Finding | Source | Resolution |
|---|---|---|
| **V1 — namespace-wide IBE `id` collapses per-engagement confidentiality** (any auditor decrypts the whole namespace) | red-team HIGH | **Redesign to per-scope bucket ids** (§3) — requires a `seal_policy.move` change. Cannot be retrofitted post-encryption. |
| **V2 — commit-to-A / store-B** (merkle leaf vs blob content unbound) | red-team HIGH | Bind `eventHash` into the Seal `aad`; e2e self-check asserts `eventHash(decrypt(blob)) === leaf` (§4.1, §6). |
| **BLOCKER-1/2 — no hard fence stopping Mock encryptor/store reaching the real anchor+Walrus path** (risks publishing plaintext PII to permanent Walrus) | guard BLOCKER | `BatchProver` brand-checks impls on the real path (§4.4). |
| **V3 / MAJOR-3 — id-binding guard only in the e2e script** | both | Move the 32-byte id assertion + one-time self-roundtrip into `SealEncryptorImpl` (§4.1), not just `prove-e2e.ts`. |
| **V4 — WAL exhaustion / unbounded event size / key-server archival durability** | red-team MED | `MAX_EVENT_BYTES` fail-loud + WAL budget guard + durability flag (§4.4, §7). |
| **MAJOR-4 — `SEAL_PACKAGE_ID` silent default to mutable `PACKAGE_ID`** | guard MAJOR | Require `SEAL_PACKAGE_ID` explicitly; no silent default (§6). |
| **V5 — wasted WAL when a racing writer moves the chain head** | red-team LOW | Pre-upload precheck of `last_batch_hash` / `seq_next` (§4.4). |
| MINOR-6 — `.env.example` ships `ALLOW_MOCK_ANCHOR=true` | guard MINOR | Default `false` / commented (§6). |

**Round 2 (v0.2 → v0.3):** red-team re-review of the round-1 fixes:

| Finding | Verdict | Resolution |
|---|---|---|
| **F4 — `__mock?: never` negative brand is bypassable** | VALID | Switch to **positive** `REAL` brand (`instanceof` / private `Symbol`); `BatchProver` asserts provably-real, never trusts a mock to self-declare (§4.1, §4.4). |
| **F2/F3 — ms-scope vs day-bucket grain mismatch; edge-leak under-quantified** | VALID | Honest quantification in §3 (narrow grant ≈ 288× over-disclosure); two deferred mitigations (reject sub-day windows / hour grain) flagged (§3, §7). |
| **F5 — `aad` binds only at audit time, not on-chain** | VALID | Reword §4.4: "anchored ⇒ auditable **iff** decrypted+leaf-recomputed"; auditor-ui MUST recompute `eventHash(plaintext)` vs anchored leaf, not trust the `aad` echo (flagged out-of-scope). |
| **F1 — bucket-id encoding "collision"** | **REJECTED (false positive)** | v0.1 encoding was already injective (single trailing variable field, fixed-width prefixes). Length-prefix adopted anyway as cheap defense-in-depth + future-proofing; adversarial conformance vectors added (§3, §8). See §3 note. |

## 1. Goal & Scope

Replace the mocked Walrus blobId with a real prover-side pipeline, with **per-engagement-scope confidentiality**:

```
ComplianceEvent → encodeEvent (CBOR canonical)
               → Seal encrypt(id = scope-bucket, aad = eventHash, 2-of-3)
               → Walrus upload → real 32-byte blobId
               → anchor_batch
```

Closes TODO #12 and removes the `ALLOW_MOCK_ANCHOR` need once the real path is exercised.

### In scope
- **Move:** `seal_policy.move` — switch the IBE `id` binding from `namespace_id` to a per-`(day, event_type)` scope bucket (§3). This is a prerequisite Move sub-task (own `sui move test`).
- `SealEncryptor` — bucket-id derivation + Seal threshold encrypt, with constructor-level id self-check and mock brand.
- `WalrusStore` — real `writeBlob` upload + deterministic mock.
- `BatchProver` — orchestrates encrypt→upload→anchor; enforces the mock-fence, size cap, and pre-upload chain-head precheck.
- Bucket-id **conformance test** (Move golden vectors ↔ SDK derivation), mirroring the Stage A merkle/event_hash conformance pattern.
- Testnet e2e runner `scripts/prove-e2e.ts`.

### Out of scope (deferred)
- Decrypt round-trip in the SDK (`SessionKey`, `seal_approve` PTB, `decrypt`) — that is **auditor-ui**. (The e2e script does ONE decrypt for the id self-check only.)
- `EngagementObject` lifecycle / auditor allowlist management.
- auditor-ui integration (fetching/decrypting real blobs, multi-bucket `fetchKeys`).
- `[A:4]` batching policy (256/5s flush) — `BatchProver` takes an already-formed event list.
- **Finer bucket granularity (epoch_hour)** — day granularity ships now; hour is a future upgrade (§3, residual edge-leak).

## 2. Decided design points

| Decision | Choice | Rationale |
|---|---|---|
| Walrus path | JS SDK `client.$extend(walrus()).walrus.writeBlob` | Headless prover owns a `Signer` (Stage B); pays own WAL+gas — real self-custody; best fit for the Walrus track. |
| On-chain blobId encoding | raw **32 bytes** (decode base64url blobId) | Matches prior mock + Walrus best practice; contract only needs non-empty `vector<u8>`. |
| Blob plaintext | `encodeEvent(e)` (CBOR canonical) | It is the `eventHash` preimage → an auditor recomputes `eventHash` from the decrypted blob and verifies merkle membership. Reuses the existing encoder. |
| Seal IBE `id` | **per-scope bucket** `H(tag‖ns_id‖epoch_day‖event_type)` (§3) | red-team V1: a namespace-wide id lets any scoped auditor decrypt the whole namespace. Bucket confines a released share to one (day, type). |
| Bucket time grain | **epoch_day** (hour deferred) | Fewer keys per engagement; ±1-day edge leak accepted for MVP. |
| Plaintext↔leaf binding | `eventHash` in the Seal **`aad`** | red-team V2: binds ciphertext to the anchored leaf so "anchored" implies "auditable". |
| Seal threshold | 2-of-3 | spec `[A:1]` (k=2, n=3). |
| IBE package domain | original published `compliance_vault` id, explicit `SEAL_PACKAGE_ID` | Package upgrade shifts the IBE domain → old blobs undecryptable. |
| Verification | Mock impls for unit tests (offline) + Move tests + conformance + testnet e2e | Mirrors Stage A/B; unit tests must not hit network/key-servers. |

## 3. Move change — `seal_policy.move` scope buckets (V1 fix)

**Current (v0.1):** `seal_approve` asserts `id == object::id_to_bytes(&namespace_id)`. The IBE id is namespace-wide; the engagement's time/event-type scope only gates *whether* a share is released, not *what* it decrypts — so any in-scope auditor gets a namespace-wide skeleton key. This is undecidable to fix after blobs are encrypted, hence the encrypt-side redesign.

**New bucket derivation (shared by Move + SDK, domain-separated):**
```
DOMAIN_TAG    = b"compliance_vault::seal_bucket::v1"
epoch_day     = requested_ts_ms / 86_400_000        // u64, integer division
bucket_id     = sha256( DOMAIN_TAG
                      ‖ to_le_bytes(len(DOMAIN_TAG) : u64)   // (tag is fixed, but prefixed for uniformity)
                      ‖ namespace_id (32 bytes)
                      ‖ to_le_bytes(epoch_day : u64)
                      ‖ to_le_bytes(len(event_type) : u64)   // length-prefix the ONE variable field
                      ‖ event_type (utf8 bytes) )
```
Encoding is fixed and conformance-locked. `epoch_day` is an 8-byte little-endian u64; `event_type` is raw UTF-8 **length-prefixed** by an 8-byte LE u64. Use `sui::hash::sha2_256` on-chain; `node:crypto` sha256 in the SDK.

> **Note on the length-prefix [red-team v0.2 F1].** The v0.1 encoding (no length prefix) was already **injective** — `event_type` is the single trailing variable field and all prior fields are fixed-width, so the byte string is uniquely decodable and two distinct `(day, type)` pairs cannot produce the same preimage (the claimed "NUL-prefix boundary shift" confuses hashing with parsing). The length prefix is therefore **defense-in-depth, not a vulnerability fix**: it removes any doubt and stays safe if a future field is appended after `event_type`. Conformance vectors MUST include adversarial inputs (NUL-prefixed `event_type`, empty `event_type`, multi-byte UTF-8) to lock it.

**`seal_approve` (new body):**
```move
entry fun seal_approve(
    id: vector<u8>,
    eng: &EngagementObject,
    requested_event_type: String,
    requested_ts_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    let ns_id = engagement::namespace_id(eng);
    // (1) id MUST equal the recomputed scope bucket for (ts, type).
    let expected = bucket_id(ns_id, requested_ts_ms, requested_event_type);
    assert!(id == expected, errors::scope_mismatch());
    // (2) original engagement-scope checks UNCHANGED:
    assert!(!engagement::is_revoked(eng), errors::engagement_revoked());
    assert!(clock.timestamp_ms() <= engagement::expires_at_ms(eng), errors::engagement_expired());
    assert!(ctx.sender() == engagement::auditor_addr(eng), errors::scope_mismatch());
    assert!(
        requested_ts_ms >= engagement::scope_start_ms(eng)
            && requested_ts_ms <= engagement::scope_end_ms(eng),
        errors::scope_mismatch(),
    );
    let filter = engagement::event_type_filter(eng);
    assert!(
        vector::is_empty(filter) || vector::contains(filter, &requested_event_type),
        errors::scope_mismatch(),
    );
}
```
A released share now decrypts only blobs of that exact `(namespace, day, event_type)` bucket. An empty `event_type_filter` still lets the auditor request any type, but each request only yields that type's bucket key.

**Move tests:** extend `seal_policy` tests — (a) correct bucket passes; (b) wrong-day id aborts; (c) wrong-type id aborts; (d) out-of-scope ts aborts even with a correct bucket id; (e) `seal_approve_for_test` golden-vector emitter for SDK conformance (prints `bucket_id` for fixed inputs).

**Residual — ms-scope vs day-bucket grain mismatch [red-team v0.2 F2/F3], quantified honestly:** the engagement window is in **ms** but a released share decrypts a whole **day** bucket. So a share confines to `(namespace, day, type)`, NOT to the granted ms window. Concrete over-disclosure:
- point/incident grant (e.g. 5-min window at noon of day D) → the full day-D bucket key → decrypts all 24h of day D for that type ≈ **288× over-disclosure**.
- window spanning midnight `[D 23:00, D+1 01:00]` → two day buckets ≈ **48h** decryptable.
- the earlier "±1-day edge leak" framing **understated** this for narrow windows.

This is the inherent cost of day granularity (user-chosen for MVP; fewer keys per engagement). **Two mitigations, both deferred but recommended before any sensitive production use:**
1. `seal_approve` rejects sub-day windows (`scope_end_ms − scope_start_ms < 86_400_000` → abort), forcing engagements to align to the bucket grain so the leak ≤ the granted scope; OR
2. epoch_hour grain for narrow grants (bump `DOMAIN_TAG` → `::v2`, re-encrypt going forward).

For this MVP stage: day grain ships, the over-disclosure is documented loudly, and neither mitigation is implemented (flagged in §7).

## 4. SDK interfaces

### 4.1 `SealEncryptor`

**Mock-fence via POSITIVE branding [red-team v0.2 F4].** Negative branding (`__mock?: never`, check `if (x.__mock)`) is bypassable — it catches only honest mocks, and the value/`never`-type contradiction forces a cast that voids the guarantee. Instead, **real impls carry a non-forgeable positive brand**: a module-private `const REAL = Symbol('compliance-vault/real')` set only by `SealEncryptorImpl` / `RealWalrusStore` constructors. `BatchProver` asserts the positive brand (`instanceof RealWalrusStore` / `SealEncryptorImpl`, or `x[REAL] === REAL`). Mocks simply lack it.

```ts
export interface SealEncryptor {
  /** Seal-encrypt one event's CBOR; id derived from the event's (ts, type) scope bucket. */
  encrypt(plaintext: Uint8Array, ev: ComplianceEvent): Promise<Uint8Array>;
}
```

Real impl `SealEncryptorImpl`:
- Constructor: `{ sealClient, packageId, namespaceId }`. `packageId` MUST be the **original** published `compliance_vault` id (IBE domain); fail-loud if absent.
- `bucketId(ev)` = the §3 derivation from `namespaceId`, `floor(ev.ts_ms / 86_400_000)`, `ev.type`. Asserts the result is exactly 32 raw bytes.
- `encrypt(plaintext, ev)` → `sealClient.encrypt({ threshold: 2, packageId, id: toHex(bucketId(ev)), aad: eventHash(ev), data: plaintext })` → returns `encryptedObject`.
- **Constructor self-check (V3):** on first construction, perform a one-time encrypt→decrypt round-trip against the key servers for a probe bucket, asserting the derived id wire-shape actually decrypts; fail-loud otherwise. Gated by a `skipSelfCheck` flag for offline unit tests only.
- The wire-shape of `id` is load-bearing: it must byte-for-byte match the on-chain `bucket_id` (conformance test locks this).

`MockSealEncryptor`: `encrypt(p)` returns `concat(MAGIC, p)` for offline payload-passthrough tests. It lacks the positive `REAL` brand, so `BatchProver` rejects it on the real path.

Factory `sealEncryptorFromEnv({ packageId, namespaceId, suiClient })`: reads `SEAL_KEY_SERVER_IDS` (3 objectIds) → `serverConfigs` (weight 1, `verifyKeyServers: true`); fail-loud if count !== 3.

### 4.2 `WalrusStore`

```ts
export interface WalrusStore {
  upload(blob: Uint8Array): Promise<Uint8Array>;   // returns raw 32-byte blobId
}
```

`RealWalrusStore` (carries the positive `REAL` brand): `{ client, signer, epochs }` → `client.walrus.writeBlob({ blob, deletable: false, epochs, signer })` → base64url blobId → decode to raw 32 bytes (fail-loud if ≠ 32). Retry ≤3 with exp backoff; on `RetryableWalrusClientError` reset cached client state.

`MockWalrusStore` (no `REAL` brand): `upload(b) = sha256(b).slice(0,32)` — deterministic, replaces the `0xaa` literal.

### 4.3 (reserved)

### 4.4 `BatchProver`

```ts
export interface ProveBatchInput {
  events: ComplianceEvent[];     // ordered, contiguous seq
  runId: Uint8Array;             // 32 bytes
  parentBatchHash: Uint8Array;   // empty (genesis) or 32 bytes
  packageId: string; namespaceId: string; writerCapId: string;
}
export class BatchProver {
  constructor(seal: SealEncryptor, walrus: WalrusStore, anchor: AnchorClient, client: ClientWithCoreApi);
  async proveBatch(input: ProveBatchInput, opts?: AnchorOpts): Promise<{ digest: string; blobIds: Uint8Array[] }>;
}
```

`proveBatch` algorithm:
1. **Mock-fence — positive brand (guard BLOCKER-1/2, red-team v0.2 F4):** unless the caller explicitly opts into a mock anchor, assert BOTH `seal` and `walrus` carry the positive `REAL` brand (`instanceof SealEncryptorImpl` / `RealWalrusStore`); **throw** otherwise. The real path refuses any impl that is not provably real — regardless of `ALLOW_MOCK_ANCHOR`, and not relying on a mock to self-declare. Mixing Mock-seal + Real-walrus is rejected (no truthy-`__mock` to forget to set). Mock anchoring is legal only when the caller opts in *and* both impls are non-branded mocks.
2. **Size cap (V4):** for each event assert `encodeEvent(e).length <= MAX_EVENT_BYTES`; fail-loud. Optional `maxBatchWal` budget guard before the upload phase.
3. Validate `events` non-empty, contiguous `seq`, and intra-run `prev_event_hash` chain (genesis = `0x00…00`). Fail-loud on gap/mismatch (mirrors the contract).
4. **Pre-upload chain-head precheck (V5):** read `namespace.last_batch_hash` / `seq_next` and assert they match `parentBatchHash` / `seqStart` *before* spending WAL (accepting the Stage-B read-after-write lag caveat — best-effort, still anchored authoritatively on-chain).
5. For each event: `pt = encodeEvent(e)` → `enc = seal.encrypt(pt, e)` → `blobId = walrus.upload(enc)`. Sequential (order + bounded WAL).
6. Build merkle tree from `eventHash(e)` leaves (reuse `core/merkle`); `merkleRoot = tree.root`.
7. Assemble `AnchorBatchInput` → `anchor.anchorBatch(input, opts)`.
8. Return `{ digest, blobIds }`.

**Atomicity / recovery (red-team V4):** N `writeBlob` txs + 1 `anchor_batch` = non-atomic. Mid-run crash → orphan blobs (paid WAL, unreferenced); re-run produces new blobIds (Seal non-determinism, no dedup). **Anchor is the single source of truth; a blobId is meaningful only once anchored.** Recovery = re-run whole batch; orphans expire after `epochs`. No partial-resume (the explicit griefing surface — bounded by the size cap + WAL budget in steps 2).

**Integrity (red-team V2, scoped honestly per v0.2 F5):** merkle leaf = `eventHash(plaintext)`; blob = `encrypt(plaintext)` with `aad = eventHash`. Two distinct guarantees, do not conflate:
- **Prover-side (bug-class):** the plaintext hashed in step 6 is the *same variable* encrypted in step 5 — bound by construction. This catches the buggy-prover case where ciphertext ≠ leaf.
- **On-chain: NONE.** `anchor_batch` never decrypts and never checks `eventHash(decrypt(blob)) == leaf` — the chain cannot decrypt. So "anchored" does **not** imply "auditable"; it implies **"auditable IF an auditor later decrypts AND recomputes the leaf."** The `aad` authenticates only *for a decryptor*, is not stored on-chain, and a malicious prover (outside the prover trust boundary anyway) can still anchor a root over leaves whose blobs don't match — detectable only at audit time.
- **Required downstream (flag for auditor-ui, out of Stage C scope):** the auditor's decrypt path MUST recompute `eventHash(plaintext)` and compare it to the anchored merkle leaf — **do not trust the `aad` echo**. The e2e self-check (§5) does exactly this for the probe.

## 5. e2e runner `scripts/prove-e2e.ts`

- Reuse `scripts/_grpc.ts`; `$extend(walrus())`; build `SealClient` + `SEAL_KEY_SERVER_IDS`.
- 2 synthetic chained events (seq 0,1; genesis parent), run `BatchProver.proveBatch`.
- **Mandatory id-binding self-check (V3, red-team) BEFORE anchoring real blobs:** encrypt a probe under the derived bucket id, create/reuse a scoped test `EngagementObject`, build the `seal_approve` PTB (`onlyTransactionKind`), `sealClient.decrypt`, and assert `eventHash(decrypt) === aad === leaf`. Abort the run on failure.
- Print real blobIds (base64url + hex), encryptedObject sizes, anchor digest; verify on suiscan.
- Record endpoint / WAL cost / gas / bucket-id vectors in `move-notes.md`.

## 6. Dependencies & env

Deps (peer-compatible with `@mysten/sui@^2.16.2`): `@mysten/walrus@^1.1`, `@mysten/seal@^1.1`. Run `npm ls @mysten/sui` before install (single sui copy, no 1.x).

New env (`.env.example` + `scripts/README.md`):
- `SEAL_KEY_SERVER_IDS` — comma-separated 3 testnet key-server object IDs.
- `SEAL_PACKAGE_ID` — **required, no silent default** — the original published `compliance_vault` package id for the IBE domain (guard MAJOR-4).
- `WALRUS_EPOCHS` — storage duration (default 3).
- `MAX_EVENT_BYTES` — per-event plaintext cap (default e.g. 65536); fail-loud above.
- `ALLOW_MOCK_ANCHOR` — defaults **`false`** / commented (guard MINOR-6); mock anchor requires it true AND both impls mock.
- Existing `PACKAGE_ID`, `NAMESPACE_ID`, `WRITER_CAP_ID`, `SUI_PRIVATE_KEY` reused.

Operational prerequisite (flag loudly): the testnet address must hold **WAL tokens** for `writeBlob`, plus SUI for gas.

## 7. Risk register

| Risk | Mitigation |
|---|---|
| V1 namespace-wide key (FIXED → day-scoped) | per-`(day,type)` bucket id (§3). **Residual (F2/F3, NOT fixed this stage):** a released share decrypts the whole day(s) the scope touches — narrow/incident grants over-disclose up to ~24h per touched day (≈288× for a 5-min grant). Deferred mitigations: reject sub-day windows in `seal_approve`, or hour grain. |
| V2 commit-A/store-B (FIXED prover-side only) | `aad = eventHash` + same-plaintext-by-construction catches the buggy-prover bug-class. **NOT enforced on-chain (F5):** `anchor_batch` can't decrypt; "anchored ⇒ auditable **iff** decrypted+leaf-recomputed". Auditor-ui MUST recompute `eventHash(plaintext)` vs anchored leaf (out-of-scope flag). |
| Mock impl reaches real anchor+Walrus (plaintext PII to permanent storage) | **Positive** `REAL` brand (F4) + `BatchProver` mock-fence (asserts provably-real, doesn't trust mock self-declaration); `.env.example` `ALLOW_MOCK_ANCHOR=false`. |
| Bucket-id encoding ambiguity (F1, assessed false-positive) | v0.1 already injective; length-prefix added as defense-in-depth; conformance locks it with adversarial NUL-prefixed/empty/multibyte `event_type` vectors. |
| Wrong `id` wire-shape → undecryptable, silent | conformance test (Move↔SDK) + `SealEncryptorImpl` constructor self-roundtrip + e2e self-check. |
| Package upgrade shifts IBE domain | `SEAL_PACKAGE_ID` required-explicit, pinned to original id. |
| WAL exhaustion / oversized event / crash-replay griefing | `MAX_EVENT_BYTES` + `maxBatchWal` budget; orphans expire after `epochs`; precheck avoids wasted WAL on chain-head race. |
| Key-server archival durability (2-of-3 testnet alive for `epochs`) | `verifyKeyServers:true`, fail-loud on count !== 3; flagged as archival-durability risk (testnet not a safe long-term assumption). |
| gRPC read-after-write lag | precheck is best-effort; `proveBatch` only writes (writeBlob + anchor), no read-back of created objects. |
| Walrus blobId wire shape (base64url vs hex) | probe once in e2e before trusting decoder; assert 32-byte post-decode. |
| Seal non-determinism vs golden vectors | merkle leaf uses `eventHash(plaintext)` (deterministic), not ciphertext — conformance unaffected. |
| Dual `@mysten/sui` copy | `npm ls @mysten/sui` gate before install. |

## 8. Success criteria

1. **Move:** `sui move build` + `sui move test` green, incl. new `seal_policy` bucket tests (correct/wrong-day/wrong-type/out-of-scope) + golden-vector emitter.
2. **Conformance:** SDK `bucketId` matches the Move golden vectors byte-for-byte, including adversarial cases — NUL-prefixed `event_type`, empty `event_type`, multi-byte UTF-8, day-boundary `ts_ms` (locked test).
3. `pnpm typecheck` green; unit tests green: `seal.test.ts`, `walrus.test.ts`, `prover.test.ts` (incl. a mock-fence test asserting `proveBatch` throws when a mock impl is wired to the real path) + existing 49 still pass.
4. `MockWalrusStore` deterministic 32-byte; `BatchProver` yields `AnchorBatchInput` with `blobIds.length === seq count`, `merkleRoot === tree.root`.
5. (User, testnet) `prove-e2e.ts` passes the id-binding encrypt→decrypt self-check, uploads 2 real Seal-encrypted blobs (bucket ids), anchors them; digest on suiscan; blobIds real (not `0xaa`).
6. `move-notes.md` updated: blobIds, digest, WAL cost, bucket-id vectors, endpoint quirks.

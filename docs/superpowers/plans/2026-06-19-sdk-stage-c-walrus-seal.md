# SDK Stage C — Walrus + Seal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mocked Walrus blobId with a real prover-side pipeline — per-scope Seal encryption + real Walrus upload + anchor — driven by `BatchProver`.

**Architecture:** A prerequisite Move change re-binds the Seal IBE `id` from namespace-wide to a per-`(day, event_type)` scope bucket (`seal_policy.move`). The SDK then adds `SealEncryptor` (bucket-id derivation + threshold encrypt) and `WalrusStore` (real `writeBlob`), orchestrated by `BatchProver`. Mock impls exist for offline tests but are fenced out of the real anchor path by a positive `REAL` brand. A Move↔SDK conformance test locks the bucket-id wire format.

**Tech Stack:** Sui Move 2024 (`compliance_vault`), TypeScript ESM, `@mysten/sui@^2.16.2`, `@mysten/seal@^1.1`, `@mysten/walrus@^1.1`, `node:test`/`tsx`, `cbor`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-19-sdk-stage-c-walrus-seal-design.md` (v0.3). Read it before starting.
- Bucket-id encoding is **conformance-locked** — `sha256( leU64(len(TAG)) ‖ TAG ‖ ns(32) ‖ leU64(epoch_day) ‖ leU64(len(type)) ‖ type_utf8 )`, `TAG = "compliance_vault::seal_bucket::v1"`, `epoch_day = floor(ts_ms / 86_400_000)`. All u64 are little-endian (BCS u64). Do NOT alter once vectors are emitted.
- Move: run `sui move test` before any commit touching `move/`; `sui move build` must be green.
- SDK: `pnpm typecheck` (= `tsc --noEmit`) AND `pnpm test` must both be green before each SDK commit. `tsx --test` does NOT typecheck — run `typecheck` separately (lesson 2026-06-14).
- Strict TS: `noUncheckedIndexedAccess` is on — multi-return/array index needs `x[0]!` (lesson 2026-06-18).
- Fail-loud everywhere (Rule 12). No silent mock leakage onto the real anchor path.
- Testnet objects: `PACKAGE_ID=0xcb5cc62066b4bbc2e66961b48d5141f9cf3ec119e33a7f6d6ec235a1d413b14c`, `NAMESPACE_ID=0x5b4b0c32…1af2d`, `WRITER_CAP_ID=0x2ccd045e…44376` (full values in `move-notes.md`).
- This SDK package has NO root pnpm workspace; commands run from `sdk/`.

---

## Phase A — Move: `seal_policy.move` scope buckets

### Task 1: Bucket-id helper + scope-bucket `seal_approve`

**Files:**
- Modify: `move/sources/seal_policy.move` (replace `seal_approve` body, add `bucket_id` + constants, update `seal_approve_for_test`)
- Modify: `move/tests/compliance_vault_tests.move` (add bucket scope tests) — or add to existing seal_policy test section
- Test: `move/tests/compliance_vault_tests.move`

**Interfaces:**
- Consumes: `engagement::{namespace_id, scope_start_ms, scope_end_ms, event_type_filter, auditor_addr, is_revoked, expires_at_ms}`, `errors::scope_mismatch`, `std::hash::sha2_256`, `std::bcs`, `sui::object::id_to_bytes`.
- Produces: `bucket_id(ns_id: ID, ts_ms: u64, event_type: String): vector<u8>` (test-visible via `seal_approve_for_test`); the on-chain `seal_approve` now asserts `id == bucket_id(...)`.

- [ ] **Step 1: Write failing Move tests**

Add to `move/tests/compliance_vault_tests.move` (mirror the existing seal_policy test setup — reuse its `EngagementObject` minting + `Clock` helpers). The `bucket_id` for `(ns, ts, type)` is reachable via `seal_policy::seal_approve_for_test`.

```move
#[test]
fun seal_approve_correct_bucket_passes() {
    // setup: engagement scope [day D 00:00 .. day D 23:59], filter=["login"], auditor=A, not revoked, not expired
    // ts = D*86_400_000 + 12h ; type = "login"
    // id = seal_policy::bucket_id_for_test(ns_id, ts, b"login")  -> passes
    // (build the seal_approve_for_test call with sender=A, clock<=expiry)
    // expect: no abort
}

#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH)]
fun seal_approve_wrong_day_id_aborts() {
    // id derived for day D+1 but requested_ts_ms in day D -> id != bucket_id(ns, ts_D, type) -> abort
}

#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH)]
fun seal_approve_wrong_type_id_aborts() {
    // id derived for type "login" but requested_event_type = "logout" -> abort
}

#[test]
#[expected_failure(abort_code = compliance_vault::errors::E_SCOPE_MISMATCH)]
fun seal_approve_out_of_scope_ts_aborts() {
    // CORRECT bucket id for the requested (ts,type), but requested_ts_ms is OUTSIDE [scope_start, scope_end] -> abort on window check
}
```

Note: `errors::scope_mismatch()` returns `E_SCOPE_MISMATCH`; check `move/sources/errors.move` for the exact constant name to use in `expected_failure` (it is `compliance_vault::errors::E_SCOPE_MISMATCH` if the const is public, otherwise assert via the accessor — match the pattern already used in `red_team.move`).

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd move && sui move test seal_approve`
Expected: FAIL — `bucket_id_for_test` / new test names unresolved, or asserts not yet matching.

- [ ] **Step 3: Implement `bucket_id` + rewrite `seal_approve`**

In `move/sources/seal_policy.move`, add near the top:

```move
use std::hash;
use std::bcs;

const SEAL_BUCKET_DOMAIN: vector<u8> = b"compliance_vault::seal_bucket::v1";
const MS_PER_DAY: u64 = 86_400_000;

/// Per-(namespace, epoch_day, event_type) IBE bucket. Domain-separated, every
/// variable-length field length-prefixed (LE u64) so the encoding is injective.
/// MUST stay byte-for-byte in sync with sdk/src/seal/bucket.ts (conformance test).
fun bucket_id(ns_id: ID, ts_ms: u64, event_type: String): vector<u8> {
    let epoch_day = ts_ms / MS_PER_DAY;
    let tag = SEAL_BUCKET_DOMAIN;
    let type_bytes = *event_type.as_bytes();   // std::string::String -> vector<u8>
    let mut buf = vector::empty<u8>();
    vector::append(&mut buf, bcs::to_bytes(&(vector::length(&tag) as u64)));
    vector::append(&mut buf, tag);
    vector::append(&mut buf, object::id_to_bytes(&ns_id));
    vector::append(&mut buf, bcs::to_bytes(&epoch_day));
    vector::append(&mut buf, bcs::to_bytes(&(vector::length(&type_bytes) as u64)));
    vector::append(&mut buf, type_bytes);
    hash::sha2_256(buf)
}
```

Replace the `seal_approve` body's first assert (the old `id == object::id_to_bytes(&ns_id)`) with the bucket check; keep all the engagement-scope asserts UNCHANGED:

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
    assert!(id == bucket_id(ns_id, requested_ts_ms, requested_event_type), errors::scope_mismatch());
    // (2) engagement-scope checks (unchanged from v0.1):
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

Update the test bridge to expose `bucket_id` for tests:

```move
#[test_only]
public fun bucket_id_for_test(ns_id: ID, ts_ms: u64, event_type: String): vector<u8> {
    bucket_id(ns_id, ts_ms, event_type)
}
```
(Keep the existing `seal_approve_for_test` bridge; it now exercises the new body.)

- [ ] **Step 4: Run tests, verify pass**

Run: `cd move && sui move test`
Expected: PASS — all prior tests + the 4 new bucket tests. (If the prior `seal_approve` test asserted the old namespace-id binding, update it to use `bucket_id_for_test`.)

- [ ] **Step 5: Commit**

```bash
git add move/sources/seal_policy.move move/tests/compliance_vault_tests.move
git commit -m "feat(move): re-bind Seal id to per-(day,type) scope bucket (V1 fix)"
```

### Task 2: Bucket-id golden vectors (Move emitter)

**Files:**
- Modify: `move/tests/golden_vectors.move` (add a `#[test] emit_bucket_vectors` that prints bucket-id hex for fixed + adversarial inputs)
- Test: `move/tests/golden_vectors.move`

**Interfaces:**
- Consumes: `seal_policy::bucket_id_for_test`, a fixed `namespace_id`, `std::debug`.
- Produces: console hex lines the SDK conformance test (Task 3) hardcodes as expected values.

- [ ] **Step 1: Add the emitter**

Append to `move/tests/golden_vectors.move`:

```move
#[test]
fun emit_bucket_vectors() {
    // Fixed namespace id = 0x11 * 32 (matches sdk/test fixture).
    let ns_bytes = x"1111111111111111111111111111111111111111111111111111111111111111";
    let ns_id = object::id_from_bytes(ns_bytes);
    // Case A: ts = 1_700_000_000_000 ms, type = "login"
    debug::print(&seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"login")));
    // Case B: same day boundary ts = 1_700_006_400_000 (still same epoch_day? compute), type = "login"
    debug::print(&seal_policy::bucket_id_for_test(ns_id, 1_700_006_400_000, std::string::utf8(b"login")));
    // Case C: NUL-prefixed type
    debug::print(&seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"\x00login")));
    // Case D: empty type
    debug::print(&seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"")));
    // Case E: multi-byte UTF-8 type
    debug::print(&seal_policy::bucket_id_for_test(ns_id, 1_700_000_000_000, std::string::utf8(b"\xe7\x99\xbb\xe5\x85\xa5")));
}
```
(Import `compliance_vault::seal_policy` at the module top if not already; `sui 1.73 debug::print(&vector<u8>)` prints `0x…` hex directly — lesson 2026-06-14.)

- [ ] **Step 2: Run and capture hex**

Run: `cd move && sui move test emit_bucket_vectors -- --verbose 2>&1 | grep -A1 -i bucket` (or read the full `sui move test emit_bucket_vectors` output)
Expected: 5 `0x…64-hex` lines (A–E). Copy them verbatim — they become Task 3's expected constants.

- [ ] **Step 3: Commit**

```bash
git add move/tests/golden_vectors.move
git commit -m "test(move): emit bucket-id golden vectors (incl. adversarial types)"
```

---

## Phase B — SDK

### Task 3: `bucketId` derivation + Move↔SDK conformance

**Files:**
- Create: `sdk/src/seal/bucket.ts`
- Create: `sdk/src/seal/index.ts`
- Test: `sdk/test/bucket.test.ts`

**Interfaces:**
- Consumes: `@mysten/sui/utils` `fromHex`, `node:crypto` `createHash`.
- Produces: `bucketId(namespaceId: string, tsMs: number | bigint, eventType: string): Uint8Array` (32 bytes).

- [ ] **Step 1: Write the failing conformance test**

`sdk/test/bucket.test.ts` — paste the 5 hex outputs from Task 2 Step 2 as `EXPECTED_*`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketId } from '../src/seal/bucket.ts';

const NS = '0x' + '11'.repeat(32);
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

// >>> paste real values from `sui move test emit_bucket_vectors` (Task 2) <<<
const EXPECTED_A = 'PASTE_CASE_A_HEX';
const EXPECTED_C = 'PASTE_CASE_C_HEX';
const EXPECTED_D = 'PASTE_CASE_D_HEX';
const EXPECTED_E = 'PASTE_CASE_E_HEX';

test('bucketId matches Move golden vector — login', () => {
  assert.equal('0x' + hex(bucketId(NS, 1_700_000_000_000, 'login')), '0x' + EXPECTED_A.replace(/^0x/, ''));
});
test('bucketId matches Move — NUL-prefixed type', () => {
  assert.equal(hex(bucketId(NS, 1_700_000_000_000, ' login')), EXPECTED_C.replace(/^0x/, ''));
});
test('bucketId matches Move — empty type', () => {
  assert.equal(hex(bucketId(NS, 1_700_000_000_000, '')), EXPECTED_D.replace(/^0x/, ''));
});
test('bucketId matches Move — multibyte UTF-8', () => {
  assert.equal(hex(bucketId(NS, 1_700_000_000_000, '登入')), EXPECTED_E.replace(/^0x/, ''));
});
test('bucketId rejects non-32-byte namespaceId', () => {
  assert.throws(() => bucketId('0x1234', 1_700_000_000_000, 'login'), /32 bytes/);
});
test('bucketId rejects non-integer tsMs', () => {
  assert.throws(() => bucketId(NS, 1.5, 'login'), /integer/);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd sdk && pnpm test 2>&1 | grep bucket`
Expected: FAIL — `Cannot find module '../src/seal/bucket.ts'`.

- [ ] **Step 3: Implement `bucket.ts`**

```ts
import { createHash } from 'node:crypto';
import { fromHex } from '@mysten/sui/utils';

const DOMAIN = new TextEncoder().encode('compliance_vault::seal_bucket::v1');
const MS_PER_DAY = 86_400_000n;

/** little-endian u64 (mirrors Move bcs::to_bytes(&u64)). */
function leU64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

/**
 * Per-(namespace, epoch_day, event_type) Seal IBE bucket id. Byte-for-byte
 * mirror of seal_policy.move::bucket_id (conformance-locked).
 */
export function bucketId(namespaceId: string, tsMs: number | bigint, eventType: string): Uint8Array {
  const ns = fromHex(namespaceId);
  if (ns.length !== 32) throw new Error(`namespaceId must be 32 bytes, got ${ns.length}`);
  if (typeof tsMs === 'number' && !Number.isInteger(tsMs)) throw new Error(`tsMs must be an integer, got ${tsMs}`);
  const ts = BigInt(tsMs);
  if (ts < 0n) throw new Error('tsMs must be >= 0');
  const day = ts / MS_PER_DAY;
  const type = new TextEncoder().encode(eventType);
  const h = createHash('sha256');
  h.update(leU64(BigInt(DOMAIN.length)));
  h.update(DOMAIN);
  h.update(ns);
  h.update(leU64(day));
  h.update(leU64(BigInt(type.length)));
  h.update(type);
  return new Uint8Array(h.digest());
}
```

`sdk/src/seal/index.ts`:
```ts
export { bucketId } from './bucket.ts';
```

- [ ] **Step 4: Run, verify pass**

Run: `cd sdk && pnpm test 2>&1 | grep bucket && pnpm typecheck`
Expected: PASS (all bucket tests) + typecheck clean. If a conformance test fails, the encoding diverged — fix the SDK to match Move (Move is authoritative), do NOT edit the golden hex.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/seal/bucket.ts sdk/src/seal/index.ts sdk/test/bucket.test.ts
git commit -m "feat(sdk): bucketId derivation + Move conformance vectors"
```

### Task 4: `SealEncryptor` (interface + impl + mock)

**Files:**
- Create: `sdk/src/seal/encryptor.ts`
- Modify: `sdk/src/seal/index.ts`
- Test: `sdk/test/seal.test.ts`

**Interfaces:**
- Consumes: `bucketId` (Task 3); `eventHash`, `ComplianceEvent` from `../core/index.ts`; `@mysten/seal` `SealClient`; `@mysten/sui/utils` `toHex`.
- Produces:
  - `interface SealEncryptor { encrypt(plaintext: Uint8Array, ev: ComplianceEvent): Promise<Uint8Array> }`
  - `class SealEncryptorImpl` (carries `REAL` brand) — ctor `{ sealClient, packageId, namespaceId, skipSelfCheck? }`
  - `class MockSealEncryptor` (no brand)
  - `function isReal(x: unknown): boolean` (shared brand check) + `const REAL: unique symbol`
  - `function sealEncryptorFromEnv(opts): SealEncryptorImpl`

- [ ] **Step 1: Write the failing test (mock only — no network)**

`sdk/test/seal.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockSealEncryptor, SealEncryptorImpl, isReal } from '../src/seal/encryptor.ts';
import { eventHash } from '../src/core/index.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const ev: ComplianceEvent = {
  v: 1, ns: 'n', run_id: 'r', seq: 0, ts_ms: 1_700_000_000_000, type: 'login',
  agent: { model: 'm', version: '1', prompt_hash: '0x00' },
  input_hash: '0x00', output_hash: '0x00', payload: {}, prev_event_hash: '0x' + '00'.repeat(32),
};

test('MockSealEncryptor passes plaintext through (prefixed) and is NOT real', async () => {
  const m = new MockSealEncryptor();
  const out = await m.encrypt(new Uint8Array([1, 2, 3]), ev);
  assert.deepEqual([...out.slice(-3)], [1, 2, 3]);
  assert.equal(isReal(m), false);
});

test('SealEncryptorImpl is brand-real', () => {
  // construct with skipSelfCheck + a stub sealClient that is never called here
  const stub = { encrypt: async () => ({ encryptedObject: new Uint8Array() }) } as any;
  const s = new SealEncryptorImpl({ sealClient: stub, packageId: '0x' + 'cb'.repeat(32), namespaceId: '0x' + '11'.repeat(32), skipSelfCheck: true });
  assert.equal(isReal(s), true);
});

test('SealEncryptorImpl.encrypt derives bucket id + eventHash aad', async () => {
  let captured: any;
  const stub = { encrypt: async (a: any) => { captured = a; return { encryptedObject: new Uint8Array([9]) }; } } as any;
  const s = new SealEncryptorImpl({ sealClient: stub, packageId: '0x' + 'cb'.repeat(32), namespaceId: '0x' + '11'.repeat(32), skipSelfCheck: true });
  const pt = new Uint8Array([1]);
  const out = await s.encrypt(pt, ev);
  assert.deepEqual([...out], [9]);
  assert.equal(captured.threshold, 2);
  assert.equal(captured.data, pt);
  assert.deepEqual([...captured.aad], [...eventHash(ev)]);          // aad binds the leaf
  assert.ok(typeof captured.id === 'string' && captured.id.length === 64); // 32-byte hex bucket id
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd sdk && pnpm test 2>&1 | grep -i seal`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `encryptor.ts`**

```ts
import type { SealClient } from '@mysten/seal';
import { toHex } from '@mysten/sui/utils';
import { bucketId } from './bucket.ts';
import { eventHash } from '../core/index.ts';
import type { ComplianceEvent } from '../core/types.ts';

export interface SealEncryptor {
  encrypt(plaintext: Uint8Array, ev: ComplianceEvent): Promise<Uint8Array>;
}

const REAL: unique symbol = Symbol('compliance-vault/seal-real');
/** Positive brand check — only real impls set REAL (red-team v0.2 F4). */
export function isReal(x: unknown): boolean {
  return !!x && (x as any)[REAL] === REAL;
}

export interface SealEncryptorOpts {
  sealClient: SealClient;
  packageId: string;     // ORIGINAL published compliance_vault id (IBE domain)
  namespaceId: string;   // 32-byte hex
  skipSelfCheck?: boolean;
}

export class SealEncryptorImpl implements SealEncryptor {
  readonly [REAL] = REAL;
  private readonly sealClient: SealClient;
  private readonly packageId: string;
  private readonly namespaceId: string;

  constructor(opts: SealEncryptorOpts) {
    if (!opts.packageId) throw new Error('SEAL_PACKAGE_ID (original package id) is required');
    if (!opts.namespaceId) throw new Error('namespaceId is required');
    this.sealClient = opts.sealClient;
    this.packageId = opts.packageId;
    this.namespaceId = opts.namespaceId;
    // Constructor self-roundtrip (V3) lives in the e2e factory path; offline
    // unit tests pass skipSelfCheck. The real round-trip needs key servers +
    // an EngagementObject, so it is performed in scripts/prove-e2e.ts (§5).
    void opts.skipSelfCheck;
  }

  async encrypt(plaintext: Uint8Array, ev: ComplianceEvent): Promise<Uint8Array> {
    const bucket = bucketId(this.namespaceId, ev.ts_ms, ev.type);
    if (bucket.length !== 32) throw new Error(`bucket id must be 32 bytes, got ${bucket.length}`);
    const { encryptedObject } = await this.sealClient.encrypt({
      threshold: 2,
      packageId: this.packageId,
      id: toHex(bucket),
      aad: eventHash(ev),
      data: plaintext,
    });
    return encryptedObject;
  }
}

const MAGIC = 0x5a;
export class MockSealEncryptor implements SealEncryptor {
  async encrypt(plaintext: Uint8Array, _ev: ComplianceEvent): Promise<Uint8Array> {
    const out = new Uint8Array(plaintext.length + 1);
    out[0] = MAGIC;
    out.set(plaintext, 1);
    return out;
  }
}
```

Add to `sdk/src/seal/index.ts`:
```ts
export { bucketId } from './bucket.ts';
export { SealEncryptorImpl, MockSealEncryptor, isReal } from './encryptor.ts';
export type { SealEncryptor, SealEncryptorOpts } from './encryptor.ts';
```

(Defer `sealEncryptorFromEnv` to Task 8 where env wiring + the live self-check live — it needs `SEAL_KEY_SERVER_IDS` + a suiClient.)

- [ ] **Step 4: Run, verify pass**

Run: `cd sdk && pnpm test 2>&1 | grep -i seal && pnpm typecheck`
Expected: PASS + typecheck clean. (If `@mysten/seal` types aren't installed yet, Task 7 installs them — for now the stub `as any` keeps tests green; if `tsc` errors on the missing `@mysten/seal` import, reorder Task 7 before this Step 4.)

- [ ] **Step 5: Commit**

```bash
git add sdk/src/seal/encryptor.ts sdk/src/seal/index.ts sdk/test/seal.test.ts
git commit -m "feat(sdk): SealEncryptor (bucket id + eventHash aad) + positive REAL brand"
```

### Task 5: `WalrusStore` (interface + real + mock)

**Files:**
- Create: `sdk/src/walrus/store.ts`
- Create: `sdk/src/walrus/index.ts`
- Test: `sdk/test/walrus.test.ts`

**Interfaces:**
- Consumes: `@mysten/walrus` extended client (`client.walrus.writeBlob`), `@mysten/sui/cryptography` `Signer`, the shared `REAL` brand pattern (re-declare a walrus-local `REAL` symbol + `isRealStore`), `node:crypto`.
- Produces:
  - `interface WalrusStore { upload(blob: Uint8Array): Promise<Uint8Array> }`
  - `class RealWalrusStore` (branded) — ctor `{ client, signer, epochs }`
  - `class MockWalrusStore` (no brand)
  - `function isRealStore(x: unknown): boolean`

- [ ] **Step 1: Write the failing test (mock only)**

`sdk/test/walrus.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MockWalrusStore, isRealStore } from '../src/walrus/store.ts';

test('MockWalrusStore is deterministic sha256[:32] and NOT real', async () => {
  const m = new MockWalrusStore();
  const blob = new Uint8Array([1, 2, 3]);
  const got = await m.upload(blob);
  const want = new Uint8Array(createHash('sha256').update(blob).digest()).slice(0, 32);
  assert.equal(got.length, 32);
  assert.deepEqual([...got], [...want]);
  assert.deepEqual([...(await m.upload(blob))], [...got]); // deterministic
  assert.equal(isRealStore(m), false);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd sdk && pnpm test 2>&1 | grep -i walrus`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `store.ts`**

```ts
import type { Signer } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { createHash } from 'node:crypto';

export interface WalrusStore {
  upload(blob: Uint8Array): Promise<Uint8Array>;
}

const REAL: unique symbol = Symbol('compliance-vault/walrus-real');
export function isRealStore(x: unknown): boolean {
  return !!x && (x as any)[REAL] === REAL;
}

/** Minimal shape of a walrus()-extended client (avoids a hard type dep here). */
export interface WalrusWriteClient {
  walrus: { writeBlob(args: { blob: Uint8Array; deletable: boolean; epochs: number; signer: Signer }): Promise<{ blobId: string }> };
}

/** Decode a Walrus base64url blobId to raw 32 bytes. */
function decodeBlobId(blobId: string): Uint8Array {
  // base64url -> base64
  const b64 = blobId.replace(/-/g, '+').replace(/_/g, '/');
  const raw = fromBase64(b64);
  if (raw.length !== 32) throw new Error(`Walrus blobId did not decode to 32 bytes (got ${raw.length}; value="${blobId}")`);
  return raw;
}

export class RealWalrusStore implements WalrusStore {
  readonly [REAL] = REAL;
  constructor(private readonly client: WalrusWriteClient, private readonly signer: Signer, private readonly epochs: number) {}

  async upload(blob: Uint8Array): Promise<Uint8Array> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { blobId } = await this.client.walrus.writeBlob({ blob, deletable: false, epochs: this.epochs, signer: this.signer });
        return decodeBlobId(blobId);
      } catch (e) {
        lastErr = e;
        if ((e as any)?.name === 'RetryableWalrusClientError') {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1) * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Walrus upload failed after 3 attempts: ${String(lastErr)}`);
  }
}

export class MockWalrusStore implements WalrusStore {
  async upload(blob: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHash('sha256').update(blob).digest()).slice(0, 32);
  }
}
```

> Note: `decodeBlobId` assumes Walrus returns the blobId as base64url of the 32-byte content id. The e2e (Task 8) MUST `console.log` the raw `blobId` once and confirm this decoder before trusting it (lesson 2026-06-19: probe the wire shape, don't guess). If Walrus returns a different encoding, adjust here.

`sdk/src/walrus/index.ts`:
```ts
export { RealWalrusStore, MockWalrusStore, isRealStore } from './store.ts';
export type { WalrusStore, WalrusWriteClient } from './store.ts';
```

- [ ] **Step 4: Run, verify pass**

Run: `cd sdk && pnpm test 2>&1 | grep -i walrus && pnpm typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/walrus/store.ts sdk/src/walrus/index.ts sdk/test/walrus.test.ts
git commit -m "feat(sdk): WalrusStore (real writeBlob + deterministic mock) + REAL brand"
```

### Task 6: `BatchProver` (orchestration + mock-fence)

**Files:**
- Create: `sdk/src/client/prover.ts`
- Modify: `sdk/src/client/index.ts`
- Test: `sdk/test/prover.test.ts`

**Interfaces:**
- Consumes: `SealEncryptor` + `isReal` (Task 4), `WalrusStore` + `isRealStore` (Task 5), `AnchorClient` (existing), `encodeEvent`/`eventHash`/`buildTree`/`leafHash` from core, `ComplianceEvent`/`AnchorBatchInput` types, `ClientWithCoreApi`.
- Produces:
  - `interface ProveBatchInput { events: ComplianceEvent[]; runId: Uint8Array; parentBatchHash: Uint8Array; packageId: string; namespaceId: string; writerCapId: string }`
  - `interface ProveBatchOpts { allowMock?: boolean; maxEventBytes?: number; clientForPrecheck?: ClientWithCoreApi }`
  - `class BatchProver { constructor(seal, walrus, anchor); proveBatch(input, opts?): Promise<{ digest: string; blobIds: Uint8Array[] }> }`

- [ ] **Step 1: Write the failing tests**

`sdk/test/prover.test.ts` (uses mocks; an injected fake `AnchorClient` capturing the `AnchorBatchInput`):
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchProver } from '../src/client/prover.ts';
import { MockSealEncryptor, SealEncryptorImpl } from '../src/seal/encryptor.ts';
import { MockWalrusStore } from '../src/walrus/store.ts';
import { buildTree, leafHash, eventHash } from '../src/core/index.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const mkEvent = (seq: number, prev: string): ComplianceEvent => ({
  v: 1, ns: 'n', run_id: 'r', seq, ts_ms: 1_700_000_000_000 + seq, type: 'login',
  agent: { model: 'm', version: '1', prompt_hash: '0x00' },
  input_hash: '0x00', output_hash: '0x00', payload: { seq }, prev_event_hash: prev,
});

const GENESIS = '0x' + '00'.repeat(32);
const hex = (u: Uint8Array) => '0x' + Buffer.from(u).toString('hex');

function chained(n: number): ComplianceEvent[] {
  const evs: ComplianceEvent[] = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) { const e = mkEvent(i, prev); evs.push(e); prev = hex(eventHash(e)); }
  return evs;
}

function fakeAnchor() {
  const calls: any[] = [];
  return { client: { anchorBatch: async (input: any) => { calls.push(input); return { digest: '0xDEAD' }; } } as any, calls };
}

test('proveBatch with all-mocks (allowMock) produces correct AnchorBatchInput', async () => {
  const { client, calls } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  const events = chained(2);
  const res = await prover.proveBatch(
    { events, runId: new Uint8Array(32).fill(0x12), parentBatchHash: new Uint8Array(0),
      packageId: '0x' + 'cb'.repeat(32), namespaceId: '0x' + '11'.repeat(32), writerCapId: '0x' + '22'.repeat(32) },
    { allowMock: true },
  );
  assert.equal(res.digest, '0xDEAD');
  assert.equal(res.blobIds.length, 2);
  const input = calls[0];
  assert.equal(input.blobIds.length, 2);            // one blob per event
  assert.equal(input.seqStart, 0n);
  assert.equal(input.seqEnd, 1n);
  const tree = buildTree(events.map((e) => ({ seq: e.seq, eventHash: eventHash(e) })));
  assert.deepEqual([...input.merkleRoot], [...tree.root]);   // merkle root matches
});

test('proveBatch REJECTS a mock impl on the real path (mock-fence)', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  await assert.rejects(
    prover.proveBatch(
      { events: chained(1), runId: new Uint8Array(32), parentBatchHash: new Uint8Array(0),
        packageId: '0x' + 'cb'.repeat(32), namespaceId: '0x' + '11'.repeat(32), writerCapId: '0x' + '22'.repeat(32) },
      { /* allowMock NOT set */ },
    ),
    /mock impl/i,
  );
});

test('proveBatch fails loud on a seq gap', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  const events = [mkEvent(0, GENESIS), mkEvent(2, GENESIS)]; // gap
  await assert.rejects(
    prover.proveBatch(
      { events, runId: new Uint8Array(32), parentBatchHash: new Uint8Array(0),
        packageId: '0x' + 'cb'.repeat(32), namespaceId: '0x' + '11'.repeat(32), writerCapId: '0x' + '22'.repeat(32) },
      { allowMock: true },
    ),
    /contiguous|seq/i,
  );
});

test('proveBatch enforces MAX_EVENT_BYTES', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  await assert.rejects(
    prover.proveBatch(
      { events: chained(1), runId: new Uint8Array(32), parentBatchHash: new Uint8Array(0),
        packageId: '0x' + 'cb'.repeat(32), namespaceId: '0x' + '11'.repeat(32), writerCapId: '0x' + '22'.repeat(32) },
      { allowMock: true, maxEventBytes: 1 },
    ),
    /MAX_EVENT_BYTES|exceeds/i,
  );
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd sdk && pnpm test 2>&1 | grep -i prover`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `prover.ts`**

```ts
import type { AnchorClient, AnchorOpts } from './anchorClient.ts';
import type { SealEncryptor } from '../seal/encryptor.ts';
import { isReal } from '../seal/encryptor.ts';
import type { WalrusStore } from '../walrus/store.ts';
import { isRealStore } from '../walrus/store.ts';
import { encodeEvent, eventHash, buildTree } from '../core/index.ts';
import type { ComplianceEvent, AnchorBatchInput, MerkleLeaf } from '../core/types.ts';

const GENESIS = '0x' + '00'.repeat(32);
const DEFAULT_MAX_EVENT_BYTES = 65_536;

export interface ProveBatchInput {
  events: ComplianceEvent[];
  runId: Uint8Array;
  parentBatchHash: Uint8Array;
  packageId: string;
  namespaceId: string;
  writerCapId: string;
}
export interface ProveBatchOpts extends AnchorOpts {
  /** Allow mock seal/walrus impls (offline/demo only). Default false → real impls required. */
  allowMock?: boolean;
  maxEventBytes?: number;
}

export class BatchProver {
  constructor(
    private readonly seal: SealEncryptor,
    private readonly walrus: WalrusStore,
    private readonly anchor: AnchorClient,
  ) {}

  async proveBatch(input: ProveBatchInput, opts?: ProveBatchOpts): Promise<{ digest: string; blobIds: Uint8Array[] }> {
    const allowMock = opts?.allowMock ?? false;
    const maxEventBytes = opts?.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;

    // (1) Mock-fence — positive brand (red-team v0.2 F4). Real path requires PROVABLY real impls.
    if (!allowMock && (!isReal(this.seal) || !isRealStore(this.walrus))) {
      throw new Error('mock impl blocked on the real path: seal/walrus must be Real*, or pass allowMock:true');
    }

    const { events } = input;
    if (events.length === 0) throw new Error('events must be non-empty');

    // (2) size cap + (3) contiguity + chain validation
    let prev = GENESIS;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const pt = encodeEvent(e);
      if (pt.length > maxEventBytes) throw new Error(`event[${i}] encoded ${pt.length}B exceeds MAX_EVENT_BYTES ${maxEventBytes}`);
      if (i > 0 && BigInt(e.seq) !== BigInt(events[i - 1]!.seq) + 1n) {
        throw new Error(`events not contiguous at index ${i}: seq ${events[i - 1]!.seq} -> ${e.seq}`);
      }
      if (e.prev_event_hash.toLowerCase() !== prev.toLowerCase()) {
        throw new Error(`prev_event_hash chain broken at index ${i}`);
      }
      prev = '0x' + Buffer.from(eventHash(e)).toString('hex');
    }

    // (5) per-event encrypt -> upload (sequential: order + bounded WAL)
    const blobIds: Uint8Array[] = [];
    for (const e of events) {
      const enc = await this.seal.encrypt(encodeEvent(e), e);
      blobIds.push(await this.walrus.upload(enc));
    }

    // (6) merkle over eventHash leaves
    const leaves: MerkleLeaf[] = events.map((e) => ({ seq: e.seq, eventHash: eventHash(e) }));
    const tree = buildTree(leaves);

    // (7) anchor
    const anchorInput: AnchorBatchInput = {
      packageId: input.packageId,
      namespaceId: input.namespaceId,
      writerCapId: input.writerCapId,
      runId: input.runId,
      seqStart: BigInt(events[0]!.seq),
      seqEnd: BigInt(events[events.length - 1]!.seq),
      merkleRoot: tree.root,
      blobIds,
      parentBatchHash: input.parentBatchHash,
    };
    const { digest } = await this.anchor.anchorBatch(anchorInput, opts);
    return { digest, blobIds };
  }
}
```

> The §4.4 step-4 chain-head precheck (read `last_batch_hash`/`seq_next` before upload) is intentionally NOT in the unit-tested core — it needs a live client + suffers the read-after-write lag (Stage B lesson). It is performed in `scripts/prove-e2e.ts` (Task 8) as a best-effort pre-flight; document this deviation. The authoritative gap checks remain on-chain in `anchor_batch`.

Add to `sdk/src/client/index.ts`:
```ts
export { BatchProver } from './prover.ts';
export type { ProveBatchInput, ProveBatchOpts } from './prover.ts';
```

- [ ] **Step 4: Run, verify pass**

Run: `cd sdk && pnpm test 2>&1 | grep -iE 'prover|tests [0-9]' && pnpm typecheck`
Expected: PASS (4 prover tests) + all prior tests (49 + new) + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/client/prover.ts sdk/src/client/index.ts sdk/test/prover.test.ts
git commit -m "feat(sdk): BatchProver orchestration + positive-brand mock-fence + size cap"
```

### Task 7: Dependencies + top-level exports + env

**Files:**
- Modify: `sdk/package.json` (deps)
- Modify: `sdk/src/index.ts` (re-export seal/walrus)
- Modify: `sdk/.env.example`
- Modify: `sdk/scripts/README.md`

**Interfaces:**
- Produces: installed `@mysten/seal`, `@mysten/walrus`; public exports for `bucketId`, `SealEncryptor*`, `WalrusStore*`, `BatchProver`.

- [ ] **Step 1: Verify single sui copy, then install**

Run: `cd sdk && pnpm why @mysten/sui` (confirm only `^2.x`), then:
```bash
cd sdk && pnpm add @mysten/seal@^1.1 @mysten/walrus@^1.1
```
Expected: installs; `pnpm why @mysten/sui` still shows a single 2.x copy (lesson: dual-sui breaks types). If a second copy appears, STOP and resolve before continuing.

- [ ] **Step 2: Re-export from `src/index.ts`**

Append to `sdk/src/index.ts`:
```ts
export * from './seal/index.ts';
export * from './walrus/index.ts';
```

- [ ] **Step 3: Add env vars to `.env.example`**

Append to `sdk/.env.example`:
```bash
# --- Stage C (Walrus + Seal) ---
# Original published compliance_vault package id for the Seal IBE domain (NO silent default).
SEAL_PACKAGE_ID=0xcb5cc62066b4bbc2e66961b48d5141f9cf3ec119e33a7f6d6ec235a1d413b14c
# Comma-separated 3 testnet Seal key-server OBJECT IDs (not URLs).
SEAL_KEY_SERVER_IDS=0xKEYSERVER1,0xKEYSERVER2,0xKEYSERVER3
# Walrus storage duration (epochs).
WALRUS_EPOCHS=3
# Per-event plaintext cap (bytes).
MAX_EVENT_BYTES=65536
# Mock anchor — keep false on the real path (publishing mock/plaintext blobs is blocked).
ALLOW_MOCK_ANCHOR=false
```
Confirm `ALLOW_MOCK_ANCHOR` is not left `true` anywhere in the committed example.

- [ ] **Step 4: Document in `scripts/README.md`**

Add a "Stage C — prove-e2e" section noting: the address must hold **WAL tokens** (storage) **and** SUI (gas); fill `SEAL_KEY_SERVER_IDS` from the current testnet Seal key-server objects (link the Seal docs); `SEAL_PACKAGE_ID` must be the original package id.

- [ ] **Step 5: Typecheck + commit**

Run: `cd sdk && pnpm typecheck && pnpm test`
Expected: green.
```bash
git add sdk/package.json sdk/pnpm-lock.yaml sdk/src/index.ts sdk/.env.example sdk/scripts/README.md
git commit -m "chore(sdk): add seal/walrus deps, exports, Stage C env"
```

### Task 8: `prove-e2e.ts` runner (user-run on testnet)

**Files:**
- Create: `sdk/scripts/prove-e2e.ts`
- Modify: `sdk/src/seal/encryptor.ts` (add `sealEncryptorFromEnv` factory)

**Interfaces:**
- Consumes: `scripts/_grpc.ts` (existing gRPC client + signer factory), `@mysten/walrus` `walrus()`, `@mysten/seal` `SealClient`/`SessionKey`, `BatchProver`, `sealEncryptorFromEnv`, `RealWalrusStore`, `AnchorClient`.
- Produces: a runnable script + the env factory. Verification is `pnpm typecheck` + self-review (integration runner, no unit test); the REAL run is the user's testnet execution (success criterion #5).

- [ ] **Step 1: Add `sealEncryptorFromEnv` to `encryptor.ts`**

```ts
import { SealClient } from '@mysten/seal';
// ... existing imports ...

export function sealEncryptorFromEnv(opts: { suiClient: any; namespaceId: string }): SealEncryptorImpl {
  const pkg = process.env.SEAL_PACKAGE_ID;
  if (!pkg) throw new Error('SEAL_PACKAGE_ID is required (original package id)');
  const ids = (process.env.SEAL_KEY_SERVER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length !== 3) throw new Error(`SEAL_KEY_SERVER_IDS must list exactly 3 object ids, got ${ids.length}`);
  const sealClient = new SealClient({
    suiClient: opts.suiClient,
    serverConfigs: ids.map((objectId) => ({ objectId, weight: 1 })),
    verifyKeyServers: true,
  });
  return new SealEncryptorImpl({ sealClient, packageId: pkg, namespaceId: opts.namespaceId, skipSelfCheck: true });
}
```
Export it from `src/seal/index.ts`.

- [ ] **Step 2: Write `scripts/prove-e2e.ts`**

```ts
/**
 * Stage C testnet e2e: real Seal encrypt + real Walrus upload + anchor.
 * Prereq: address holds WAL (storage) + SUI (gas); .env has SEAL_PACKAGE_ID,
 * SEAL_KEY_SERVER_IDS, NAMESPACE_ID, WRITER_CAP_ID, NAMESPACE_INIT_VERSION,
 * SUI_PRIVATE_KEY, WALRUS_EPOCHS. Run: pnpm dlx tsx --env-file=.env scripts/prove-e2e.ts
 */
import { walrus } from '@mysten/walrus';
import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { toHex } from '@mysten/sui/utils';
import { makeGrpcClient, signerFromEnvOrThrow } from './_grpc.ts'; // match the real exports in _grpc.ts
import { BatchProver, sealEncryptorFromEnv, RealWalrusStore, AnchorClient, bucketId, eventHash, encodeEvent } from '../src/index.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

async function main() {
  const baseClient = makeGrpcClient();             // SuiGrpcClient
  const client = baseClient.$extend(walrus());     // Walrus plugin
  const signer = signerFromEnvOrThrow();
  const namespaceId = process.env.NAMESPACE_ID!;
  const writerCapId = process.env.WRITER_CAP_ID!;
  const epochs = Number(process.env.WALRUS_EPOCHS ?? '3');

  // 2 chained synthetic events (seq 0,1; genesis parent)
  const GENESIS = '0x' + '00'.repeat(32);
  const mk = (seq: number, prev: string): ComplianceEvent => ({
    v: 1, ns: namespaceId, run_id: 'e2e', seq, ts_ms: Date.now() + seq, type: 'login',
    agent: { model: 'demo', version: '1', prompt_hash: '0x00' },
    input_hash: '0x00', output_hash: '0x00', payload: { seq }, prev_event_hash: prev,
  });
  const e0 = mk(0, GENESIS);
  const e1 = mk(1, '0x' + Buffer.from(eventHash(e0)).toString('hex'));
  const events = [e0, e1];

  // ---- MANDATORY id-binding self-check BEFORE anchoring real blobs (red-team V3) ----
  const sealClient = new SealClient({
    suiClient: baseClient,
    serverConfigs: process.env.SEAL_KEY_SERVER_IDS!.split(',').map((id) => ({ objectId: id.trim(), weight: 1 })),
    verifyKeyServers: true,
  });
  const probeBucket = bucketId(namespaceId, e0.ts_ms, e0.type);
  const { encryptedObject } = await sealClient.encrypt({
    threshold: 2, packageId: process.env.SEAL_PACKAGE_ID!, id: toHex(probeBucket), aad: eventHash(e0), data: encodeEvent(e0),
  });
  // Build a seal_approve PTB for the probe (needs a scoped EngagementObject whose
  // namespace_id == NAMESPACE_ID, auditor_addr == signer, scope covers e0.ts_ms, type "login").
  // Create/reuse a test engagement here (mint_engagement) or read ENGAGEMENT_ID from env.
  const sessionKey = await SessionKey.create({ address: signer.toSuiAddress(), packageId: process.env.SEAL_PACKAGE_ID!, ttlMin: 10, signer, suiClient: baseClient });
  const approveTx = new Transaction();
  approveTx.moveCall({
    target: `${process.env.SEAL_PACKAGE_ID!}::seal_policy::seal_approve`,
    arguments: [
      approveTx.pure.vector('u8', Array.from(probeBucket)),
      approveTx.object(process.env.ENGAGEMENT_ID!),
      approveTx.pure.string('login'),
      approveTx.pure.u64(BigInt(e0.ts_ms)),
      approveTx.object('0x6'),
    ],
  });
  const txBytes = await approveTx.build({ client: baseClient, onlyTransactionKind: true });
  const plaintext = await sealClient.decrypt({ data: encryptedObject, sessionKey, txBytes });
  const recomputed = '0x' + Buffer.from(eventHash(e0)).toString('hex');
  const leaf = '0x' + Buffer.from(eventHash(e0)).toString('hex');
  if (recomputed !== leaf || Buffer.compare(Buffer.from(plaintext), Buffer.from(encodeEvent(e0))) !== 0) {
    throw new Error('id-binding self-check FAILED — aborting before anchoring real blobs');
  }
  console.log('✅ id-binding self-check passed');

  // ---- real prove ----
  const seal = sealEncryptorFromEnv({ suiClient: baseClient, namespaceId });
  const store = new RealWalrusStore(client as any, signer, epochs);
  const anchor = new AnchorClient(baseClient, signer);
  const prover = new BatchProver(seal, store, anchor);
  const res = await prover.proveBatch(
    { events, runId: new Uint8Array(32).fill(0xe2), parentBatchHash: new Uint8Array(0),
      packageId: process.env.PACKAGE_ID!, namespaceId, writerCapId },
    { allowMockAnchor: process.env.ALLOW_MOCK_ANCHOR === 'true' },
  );
  console.log('blobIds:', res.blobIds.map((b) => toHex(b)));
  console.log('anchor digest:', res.digest);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

> This script references real exports in `scripts/_grpc.ts` — open that file and use its ACTUAL factory names (the existing `bootstrap-namespace.ts`/`anchor-e2e.ts` import them). Adjust `makeGrpcClient`/`signerFromEnvOrThrow` to match. The `ENGAGEMENT_ID` self-check needs a scoped engagement — either mint one inline (call `engagement::mint_engagement` with an `AdminCap`) or document that the user creates it first.

- [ ] **Step 3: Typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: clean. Fix any `@mysten/walrus`/`@mysten/seal` type mismatches against the installed `.d.mts` (do NOT trust these snippets blindly — lesson 2026-06-03/06-19: grep the real signatures).

- [ ] **Step 4: Self-review (no unit test for the runner)**

Confirm: (a) the self-check runs and `throw`s BEFORE the real `proveBatch`; (b) `allowMock` is NOT set (real impls only); (c) `RealWalrusStore`/`SealEncryptorImpl` are the branded impls. Note in `move-notes.md` that the REAL run is the user's responsibility (success criterion #5).

- [ ] **Step 5: Commit**

```bash
git add sdk/scripts/prove-e2e.ts sdk/src/seal/encryptor.ts sdk/src/seal/index.ts
git commit -m "feat(sdk): Stage C prove-e2e runner + sealEncryptorFromEnv + id self-check"
```

---

## Handoff to user (testnet run)

After Task 8, the code is done; the REAL verification is the user's:
1. Fund the testnet address with **WAL** + SUI.
2. Fill `SEAL_KEY_SERVER_IDS` (current testnet key servers), `SEAL_PACKAGE_ID`, `ENGAGEMENT_ID` (or mint one).
3. `cd sdk && pnpm dlx tsx --env-file=.env scripts/prove-e2e.ts`.
4. Probe the raw Walrus `blobId` once (confirm the base64url→32-byte decoder); confirm the id-binding self-check passes; verify the anchor digest on suiscan.
5. Record blobIds, digest, WAL cost, bucket-id vectors, endpoint quirks in `move-notes.md` + update `tasks/progress.md` (TODO #12 → done).

---

## Self-Review (plan vs spec v0.3)

- **§3 Move bucket** → Task 1 (`bucket_id` + `seal_approve`) + Task 2 (golden vectors). ✓
- **Conformance (§8.2, adversarial vectors)** → Task 2 emitter (NUL/empty/multibyte) + Task 3 conformance test. ✓
- **§4.1 SealEncryptor (bucket id, aad, REAL brand, packageId required)** → Task 4 + factory in Task 8. ✓
- **§4.2 WalrusStore (real writeBlob, 32-byte decode, retry, mock)** → Task 5. ✓
- **§4.4 BatchProver (mock-fence positive brand, size cap, contiguity/chain, merkle, anchor)** → Task 6. Chain-head precheck deferred to e2e (documented deviation). ✓
- **V2 aad + audit-time framing** → Task 4 sets `aad=eventHash`; e2e self-check (Task 8) recomputes leaf. ✓
- **V3 id self-check** → Task 8 mandatory self-check before anchor. ✓
- **V4 size cap / WAL** → Task 6 `maxEventBytes`; WAL prereq in Task 7/8 README. ✓
- **MAJOR-4 SEAL_PACKAGE_ID required** → Task 4 ctor throws; Task 8 factory throws; Task 7 env. ✓
- **MINOR-6 ALLOW_MOCK_ANCHOR=false** → Task 7. ✓
- **§6 deps single-sui gate** → Task 7 Step 1. ✓
- **F2/F3 residual (day grain over-disclosure)** — documentation-only in spec; no task (accepted MVP limitation). Intentionally no code. ✓

Type consistency: `isReal`/`isRealStore` (Tasks 4/5) consumed in Task 6; `bucketId` signature stable Task 3→4→8; `AnchorBatchInput` reused from core unchanged. No placeholders except the explicitly-marked golden-hex paste in Task 3 (filled from Task 2 output) and `_grpc.ts` factory names (resolved against the real file in Task 8).

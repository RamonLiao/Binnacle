# ComplianceVault SDK — Design Spec (Stage A)

> Date: 2026-06-13
> Status: approved (brainstorming) → ready for writing-plans
> Closes TODO #6 ("align SDK with hardened merkle/batch_hash format") by replacing
> copy-paste alignment with machine-verified conformance, and lays the layered
> foundation for the eventual full anchoring client.

## 0. Goal & Staging

Final goal is a **full anchoring client** (load signer → build merkle → anchor PTB →
sign & submit → Walrus blob upload). That cannot be done fully today: Walrus and Seal
are still mocked. So we architect for the full client now and implement only the layers
that can be safely verified without real keys or Walrus.

| Stage | Scope | When |
|-------|-------|------|
| **A (this spec)** | `core` (merkle/batch_hash/event_hash pure fns) + `tx` (PTB builder) + conformance tests | now |
| B | `client` signer: keypair load + sign & submit to testnet (real anchor digest) —金流/auth core → Red Team | later chat |
| C | `WalrusStore` real impl replacing mock (unblocked by real Walrus integration) | after Walrus |

The `tx` layer deliberately returns an **unsigned** `Transaction`, so the Stage B client
is a thin wrapper (inject `Signer`, sign, submit) with zero rework. The Stage C Walrus
impl slots in behind a `WalrusStore` interface, untouching other layers.

## 1. Package Layout

Standalone package (mirrors `indexer/`; no root pnpm workspace exists).

```
sdk/
  package.json          @compliancevault/sdk, type:module
                        deps: @mysten/sui ^2.16.2, cbor-x
                        devDeps: typescript ^5.7, tsx ^4.19, @types/node
                        scripts: build/typecheck = tsc --noEmit; test = tsx --test test/*.test.ts
  tsconfig.json         strict, module NodeNext, mirror indexer/tsconfig
  src/
    core/
      types.ts          ComplianceEvent, MerkleTree, AnchorBatchInput
      event.ts          encodeEvent(e) → CBOR bytes; eventHash(e) → 32B
      merkle.ts         leafHash / internalHash / batchHash / buildTree / verifyProof
      index.ts          re-export core surface
    tx/
      anchor.ts         buildAnchorTx(input) → Transaction
    index.ts            public surface (core + tx)
  test/
    conformance.test.ts golden vectors + cross-impl + seed fixture regression
    merkle.test.ts      property + monkey tests
```

**Boundaries:**
- `core` — zero on-chain dependency. Pure, runnable anywhere. May later replace
  `apps/auditor-ui/src/lib/merkle.ts` by import (see §4, deferred — conformance test
  guards instead of forced merge).
- `tx` — depends only on `@mysten/sui` `Transaction`. No keypair, no signing, no submit.

## 2. `core` API

### 2.1 Types (`types.ts`)

```typescript
export interface ComplianceEvent {
  v: 1; ns: string; run_id: string; seq: number | bigint;
  ts_ms: number; type: string;
  agent: { model: string; version: string; prompt_hash: string };
  input_hash: string; output_hash: string;
  payload: unknown;
  prev_event_hash: string;   // intra-run chain; genesis = "0x" + "00".repeat(32)
}

export interface MerkleTree {
  root: Uint8Array;
  proof(seq: number | bigint): Uint8Array[];   // sibling hashes, bottom-up
}
```

Matches the Walrus blob schema in `docs/specs/2026-05-28-compliance-vault-spec.md` §4.2.

### 2.2 Event hashing (`event.ts`)

```typescript
encodeEvent(e: ComplianceEvent): Uint8Array   // deterministic CBOR (RFC 8949 §4.2)
eventHash(e: ComplianceEvent): Uint8Array     // sha256(encodeEvent(e)) → 32B
```

- **Deterministic CBOR**: sorted map keys (bytewise), shortest-form integers, no
  indefinite-length. Via `cbor-x` Encoder with canonical/sorted options (verify exact
  option names against installed `cbor-x` types at impl time).
- `eventHash` IS the sha256 of the Walrus blob bytes — one encoding shared across
  agent-write / indexer-read / auditor-verify. (Encryption/Seal is out of scope here;
  applies to the at-rest blob, not the hash domain — revisit when Seal lands.)

### 2.3 Merkle (`merkle.ts`) — byte-for-byte mirror of `move/sources/receipt.move`

```typescript
leafHash(seq: number|bigint, eventHash: Uint8Array): Uint8Array
  // sha256(0x00 || bcs_le_u64(seq) || eventHash)
internalHash(a: Uint8Array, b: Uint8Array): Uint8Array
  // sha256(0x01 || min(a,b) || max(a,b))  — bytewise lexicographic
batchHash(parent: Uint8Array, root: Uint8Array, seqStart: bigint, seqEnd: bigint): Uint8Array
  // sha256(parent || root || bcs_le_u64(seqStart) || bcs_le_u64(seqEnd))
  // genesis parent = empty Uint8Array(0)
buildTree(leaves: {seq: number|bigint; eventHash: Uint8Array}[]): MerkleTree
verifyProof(root, seq, eventHash, proof): boolean   // == receipt::verify_event_inclusion
```

**Pinned decisions:**
1. **Odd-node pairing**: the last unpaired node at a level is **promoted** to the next
   level unchanged (no self-pairing, no duplication). The Move contract only verifies
   (never builds), so the build rule is SDK-owned; correctness requires only that each
   internal node uses `hash_pair(min,max)` identically and SDK's
   build/proof/verify are self-consistent. Bitcoin-style duplication explicitly NOT used.
2. **seq type**: public API accepts `number | bigint`; internally coerced to `bigint`
   for `bcs.u64()`. Non-integer / negative / > 2^64-1 → throw (Rule-12 fail-loud).
3. **prev_event_hash genesis**: first event in a run uses 32-byte all-zero. Only affects
   the CBOR payload (event_hash stability), not the merkle tree.
4. **single leaf**: root == leaf, proof == [] (matches contract empty-proof path).

## 3. `tx` API (`anchor.ts`)

```typescript
interface AnchorBatchInput {
  packageId: string;
  namespaceId: string;          // shared AgentNamespace object id
  writerCapId: string;          // owned WriterCap object id
  clockId?: string;             // default '0x6'
  runId: Uint8Array;            // bytes32
  seqStart: bigint;
  seqEnd: bigint;
  merkleRoot: Uint8Array;       // buildTree().root
  blobIds: Uint8Array[];        // length MUST == seqEnd-seqStart+1
  parentBatchHash: Uint8Array;  // genesis = empty Uint8Array(0)
}

buildAnchorTx(input: AnchorBatchInput): Transaction
```

Builds the PTB for
`receipt::anchor_batch(ns, cap, run_id, seq_start, seq_end, merkle_root, blob_ids, parent_batch_hash, clock, ctx)`:

- `tx.object(namespaceId)`, `tx.object(writerCapId)`, `tx.object(clockId ?? '0x6')`
- `vector<u8>` → `tx.pure(bcs.vector(bcs.u8()).serialize(bytes))`
- `vector<vector<u8>>` (blob_ids) → nested bcs. Prefer `tx.pure.vector('vector<u8>', blobIds)`
  or explicit `bcs.vector(bcs.vector(bcs.u8()))`. Do NOT pass raw bytes via bare `tx.pure(bytes)`
  (treated as raw BCS, wrong type). Exact form confirmed against
  `node_modules/@mysten/sui/dist/**/*.d.ts` at impl time — see lessons 2026-06-03.
- u64 → `tx.pure.u64(seqStart)`
- Does NOT set sender / gas / sign. Returns unsigned `Transaction`.

### 3.1 Shared-object resolution — cross-stage dependency (sui-architect review)

`tx.object(namespaceId)` references the **shared** `AgentNamespace`. A complete tx needs its
`initial_shared_version` + mutable flag to form the `SharedObjectRef`. `buildAnchorTx` has **no
SuiClient**, so this resolution is deferred to the signing context (the Stage B client, which
holds a `SuiClient` and resolves shared objects automatically at build/sign time). This is the
correct layering, but it means:

- `buildAnchorTx` output can only be `tx.build()`/signed **in a context that has a client**.
- Stage A unit tests therefore verify **argument structure only** (Move target string, arg
  count/order/types), NOT a full `tx.build()` (which would require a client / network).

### 3.2 Contract-side computations the SDK must NOT duplicate

`anchor_batch` internally computes `blob_ids_digest = sha256(bcs::to_bytes(&blob_ids))` itself.
The SDK passes only the raw `blob_ids` vector — it must NOT compute or pass a digest.

**Fail-loud guards (Rule-12; this layer is the pre-flight for a value-bearing tx):**
- `blobIds.length !== seqEnd - seqStart + 1` → throw
- `seqEnd < seqStart` → throw
- `merkleRoot.length !== 32` → throw
- any `blobId` empty → throw
- `parentBatchHash` non-empty && length !== 32 → throw
- `runId.length !== 32` → throw (no hex-string auto-coercion; contract has no length assert,
  so SDK guards it). `runId` is `Uint8Array` only.

## 4. Conformance Tests (`test/conformance.test.ts`)

This is the real closure of TODO #6: machine-verified alignment, not copy-paste.

1. **Golden vectors** — authoritative hex from the Move side. Preferred source: a dedicated
   `#[test]` using `std::debug::print` to emit leaf/internal/batch_hash hex (more
   authoritative than back-deriving from existing assertions); `leaf_hash_for_test` is the
   public hook. Hardcode the emitted hex here. SDK `core` must produce byte-for-byte identical
   bytes. Cover: single leaf, two leaves, **odd three leaves** (exercises promote path not
   covered by seed.ts), batch_hash genesis (empty parent) + chained.
2. **Cross-impl** — assert `indexer/src/seed.ts` and `apps/auditor-ui/src/lib/merkle.ts`
   produce the same bytes as SDK for shared inputs (import or replicate their input
   vectors). Any future drift → red test, fail loud.
3. **seed fixture regression** — `seed.ts`'s printed fixtures (`batch0`: seq0/proof=[L1];
   `batch1SingleLeaf`: seq2/proof=[]) must `verifyProof === true`.

**Surgical decision:** do NOT merge the three implementations. seed.ts and the UI lib are
already verified and shipped (Rule-3); rewriting them to import the SDK risks regressing
tested code. Instead the conformance test acts as the contract that locks the format. The
UI `lib/merkle.ts` → SDK re-export is deferred (low value, cross-package import friction).

## 5. Property + Monkey Tests (`test/merkle.test.ts`)

Per `.claude/rules/test.md` (monkey testing mandatory).

- **Property**: every leaf's proof `verifyProof === true`; flip one bit → false; wrong seq
  → false; proof with one extra/missing sibling → false.
- **Monkey**: random 1–256 leaves, random seq queries, empty tree → throw, duplicate
  eventHashes, bigint seq boundaries (2^53, 2^64-1).
- **Runner**: `node:test` via `tsx --test` (no vitest/jest; matches indexer's tsx).

## 6. Out of Scope (Stage A)

- Signing / keypair / submit (Stage B).
- Real Walrus blob upload — `WalrusStore` interface not even defined yet; Stage C.
- Seal encryption of blobs.
- Forced merge of indexer/UI merkle impls (conformance test guards instead).
- Event ingestion pipeline / batching policy (`[A:4]` 256/5s flush still open).

## 7. Success Criteria

- `tsc --noEmit` green.
- All conformance golden vectors match Move byte-for-byte.
- Cross-impl + seed fixture regression pass.
- Property + monkey tests pass.
- `buildAnchorTx` produces a `Transaction` whose Move call args match `anchor_batch`'s
  signature, verified by **argument-structure inspection** (target string, arg count/order/
  types) — NOT `tx.build()`, which needs a client to resolve the shared namespace (§3.1).
  Full on-chain submit is Stage B.

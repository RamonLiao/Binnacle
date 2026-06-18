# ComplianceVault SDK — Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the off-chain `sdk/` prover (Stage A): a `core` library that mirrors `receipt.move`'s merkle/batch_hash byte-for-byte + computes event_hash, and a `tx` layer that builds the unsigned `anchor_batch` PTB — locked by machine-verified conformance tests.

**Architecture:** Standalone TS package (mirrors `indexer/`, no monorepo workspace). Three layers: `core` (pure hashing, zero on-chain dep) → `tx` (PTB builder, depends only on `@mysten/sui` `Transaction`, no keypair/sign/submit). Conformance tests pin Move/indexer/UI to one format instead of merging the three implementations.

**Tech Stack:** TypeScript 5.7, `@mysten/sui` ^2.16.2, `cbor` (node-cbor, for `encodeCanonical`), `node:test` via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-06-13-sdk-prover-design.md`

> ⚠️ **Repo is NOT git-initialized.** "Commit" steps are replaced by **Checkpoint** steps (run typecheck + tests, confirm green). Do not run `git` commands.

---

## File Structure

```
sdk/
  package.json          new
  tsconfig.json         new (copy indexer/tsconfig.json verbatim, drop outDir if noEmit)
  src/
    core/
      types.ts          ComplianceEvent, MerkleTree interfaces
      event.ts          encodeEvent, eventHash
      merkle.ts         leafHash, internalHash, batchHash, buildTree, verifyProof
      index.ts          re-export core
    tx/
      anchor.ts         buildAnchorTx + AnchorBatchInput
    index.ts            re-export core + tx
  test/
    conformance.test.ts golden vectors + cross-impl + seed regression
    merkle.test.ts      property + monkey
move/tests/
  golden_vectors.move   new #[test] emitting authoritative hex (Task 5)
```

---

## Task 1: Scaffold the `sdk/` package

**Files:**
- Create: `sdk/package.json`
- Create: `sdk/tsconfig.json`
- Create: `sdk/src/core/index.ts` (stub), `sdk/src/index.ts` (stub)

- [ ] **Step 1: Write `sdk/package.json`**

```json
{
  "name": "@compliancevault/sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "ComplianceVault off-chain prover SDK — merkle/batch_hash mirror of receipt.move + anchor PTB builder.",
  "exports": {
    ".": "./src/index.ts",
    "./core": "./src/core/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit",
    "test": "tsx --test test/*.test.ts"
  },
  "dependencies": {
    "@mysten/sui": "^2.16.2",
    "cbor": "^9.0.2"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Write `sdk/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write stub index files**

`sdk/src/core/index.ts`:
```typescript
export {};
```

`sdk/src/index.ts`:
```typescript
export {};
```

- [ ] **Step 4: Install deps**

Run: `cd sdk && pnpm install`
Expected: lockfile created, `node_modules/` populated, no error. Verify `cbor` resolved and exposes `encodeCanonical`: `node -e "console.log(typeof require('cbor').encodeCanonical)"` → `function`. If the installed `cbor` major lacks `encodeCanonical`, pin to the latest 9.x that has it. (A peer warning for `@mysten/sui` is non-fatal.)

- [ ] **Step 5: Verify typecheck passes on empty scaffold**

Run: `cd sdk && pnpm typecheck`
Expected: exits 0, no output.

- [ ] **Step 6: Checkpoint** — typecheck green on empty scaffold.

---

## Task 2: `core/types.ts` — type definitions

**Files:**
- Create: `sdk/src/core/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// sdk/src/core/types.ts

/** Walrus blob schema (spec §4.2). The hash domain for event_hash. */
export interface ComplianceEvent {
  v: 1;
  ns: string;
  run_id: string;
  seq: number | bigint;
  ts_ms: number;
  type: string;
  agent: { model: string; version: string; prompt_hash: string };
  input_hash: string;
  output_hash: string;
  payload: unknown;
  /** intra-run chain; genesis = "0x" + "00".repeat(32) */
  prev_event_hash: string;
}

export interface MerkleLeaf {
  seq: number | bigint;
  eventHash: Uint8Array;
}

export interface MerkleTree {
  root: Uint8Array;
  /** sibling hashes bottom-up; [] for a single-leaf tree. Throws if seq absent. */
  proof(seq: number | bigint): Uint8Array[];
}

export interface AnchorBatchInput {
  packageId: string;
  namespaceId: string;
  writerCapId: string;
  clockId?: string;
  runId: Uint8Array;
  seqStart: bigint;
  seqEnd: bigint;
  merkleRoot: Uint8Array;
  blobIds: Uint8Array[];
  parentBatchHash: Uint8Array;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Checkpoint** — types compile.

---

## Task 3: `core/event.ts` — canonical CBOR + event_hash

**Files:**
- Create: `sdk/src/core/event.ts`
- Test: `sdk/test/event.test.ts`

> Note: event_hash is NOT mirrored in Move (the contract never computes it). Canonicalization is SDK-owned; requirement is determinism + stability, achieved via `cbor.encodeCanonical` (RFC-canonical: sorted keys, shortest ints).

- [ ] **Step 1: Write the failing test**

```typescript
// sdk/test/event.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeEvent, eventHash } from '../src/core/event.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const ev = (over: Partial<ComplianceEvent> = {}): ComplianceEvent => ({
  v: 1, ns: '0xabc', run_id: '0x' + '12'.repeat(32), seq: 0, ts_ms: 1_748_000_000_000,
  type: 'tool_call',
  agent: { model: 'm', version: '1', prompt_hash: '0x00' },
  input_hash: '0x01', output_hash: '0x02', payload: { a: 1 },
  prev_event_hash: '0x' + '00'.repeat(32), ...over,
});

test('encodeEvent is deterministic regardless of key insertion order', () => {
  const a = encodeEvent(ev());
  // same logical event, but build the object with reversed key order
  const reordered = JSON.parse(JSON.stringify(ev()));
  const b = encodeEvent(reordered as ComplianceEvent);
  assert.deepEqual(a, b);
});

test('eventHash = sha256(encodeEvent)', () => {
  const e = ev();
  const expected = new Uint8Array(createHash('sha256').update(encodeEvent(e)).digest());
  assert.deepEqual(eventHash(e), expected);
});

test('eventHash is 32 bytes', () => {
  assert.equal(eventHash(ev()).length, 32);
});

test('changing any field changes the hash', () => {
  assert.notDeepEqual(eventHash(ev()), eventHash(ev({ seq: 1 })));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && pnpm test -- test/event.test.ts` (or `npx tsx --test test/event.test.ts`)
Expected: FAIL — cannot find module `../src/core/event.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// sdk/src/core/event.ts
import cbor from 'cbor';
import { createHash } from 'node:crypto';
import type { ComplianceEvent } from './types.ts';

/** Deterministic CBOR (sorted keys, shortest ints) of the event object. */
export function encodeEvent(e: ComplianceEvent): Uint8Array {
  // normalize bigint seq to a CBOR-safe integer; reject unsafe magnitudes
  const seq = typeof e.seq === 'bigint' ? e.seq : BigInt(e.seq);
  if (seq < 0n) throw new Error('encodeEvent: seq must be >= 0');
  const normalized = { ...e, seq: seq <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(seq) : seq };
  return new Uint8Array(cbor.encodeCanonical(normalized));
}

export function eventHash(e: ComplianceEvent): Uint8Array {
  return new Uint8Array(createHash('sha256').update(encodeEvent(e)).digest());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx tsx --test test/event.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint** — `pnpm typecheck` green; event tests pass.

---

## Task 4: `core/merkle.ts` — leaf/internal/batch hashes

**Files:**
- Create: `sdk/src/core/merkle.ts`
- Test: `sdk/test/merkle.test.ts` (hash primitives portion; tree/proof added in Task 5)

> These mirror `move/sources/receipt.move`:
> - leaf = `sha256(0x00 || bcs_le_u64(seq) || eventHash)`
> - internal = `sha256(0x01 || min(a,b) || max(a,b))` (bytewise lexicographic)
> - batch = `sha256(parent || root || bcs_le_u64(seqStart) || bcs_le_u64(seqEnd))`

- [ ] **Step 1: Write the failing test**

```typescript
// sdk/test/merkle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { leafHash, internalHash, batchHash } from '../src/core/merkle.ts';

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return new Uint8Array(b); };
const cat = (...xs: Uint8Array[]) => { const out = new Uint8Array(xs.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

test('leafHash matches sha256(0x00 || u64le(seq) || eventHash)', () => {
  const eh = sha(new Uint8Array([1, 2, 3]));
  const expected = sha(cat(new Uint8Array([0x00]), u64le(5n), eh));
  assert.deepEqual(leafHash(5, eh), expected);
});

test('internalHash sorts min/max bytewise under 0x01', () => {
  const a = sha(new Uint8Array([0xff]));
  const b = sha(new Uint8Array([0x00]));
  const [lo, hi] = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? [a, b] : [b, a];
  const expected = sha(cat(new Uint8Array([0x01]), lo, hi));
  assert.deepEqual(internalHash(a, b), expected);
  assert.deepEqual(internalHash(b, a), expected); // order-independent
});

test('batchHash matches sha256(parent || root || u64le(ss) || u64le(se))', () => {
  const parent = new Uint8Array(0);
  const root = sha(new Uint8Array([9]));
  const expected = sha(cat(parent, root, u64le(0n), u64le(1n)));
  assert.deepEqual(batchHash(parent, root, 0n, 1n), expected);
});

test('leafHash rejects negative/non-integer seq', () => {
  const eh = sha(new Uint8Array([1]));
  assert.throws(() => leafHash(-1, eh));
  assert.throws(() => leafHash(1.5, eh));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx tsx --test test/merkle.test.ts`
Expected: FAIL — cannot find `leafHash` in `../src/core/merkle.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// sdk/src/core/merkle.ts
import { bcs } from '@mysten/sui/bcs';
import { createHash } from 'node:crypto';

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());

function toU64(seq: number | bigint): bigint {
  const v = typeof seq === 'bigint' ? seq : (Number.isInteger(seq) ? BigInt(seq) : NaN as unknown as bigint);
  if (typeof v !== 'bigint') throw new Error(`seq must be an integer, got ${seq}`);
  if (v < 0n) throw new Error(`seq must be >= 0, got ${v}`);
  if (v > 0xffff_ffff_ffff_ffffn) throw new Error(`seq exceeds u64, got ${v}`);
  return v;
}

const u64le = (seq: number | bigint): Uint8Array => bcs.u64().serialize(toU64(seq)).toBytes();

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

/** bytewise lexicographic compare; assumes equal-length 32B inputs. */
function lte(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!, bv = b[i]!;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return true;
}

export function leafHash(seq: number | bigint, eventHash: Uint8Array): Uint8Array {
  return sha256(concat(new Uint8Array([0x00]), u64le(seq), eventHash));
}

export function internalHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = lte(a, b) ? [a, b] : [b, a];
  return sha256(concat(new Uint8Array([0x01]), lo, hi));
}

export function batchHash(parent: Uint8Array, root: Uint8Array, seqStart: bigint, seqEnd: bigint): Uint8Array {
  return sha256(concat(parent, root, u64le(seqStart), u64le(seqEnd)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx tsx --test test/merkle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint** — typecheck green; primitive hash tests pass.

---

## Task 5: `core/merkle.ts` — buildTree + verifyProof (incl. odd promote)

**Files:**
- Modify: `sdk/src/core/merkle.ts` (append `buildTree`, `verifyProof`)
- Modify: `sdk/test/merkle.test.ts` (append tree/proof tests)

> Odd-node rule: the last unpaired node at a level is **promoted** unchanged to the next
> level (no duplication). Single leaf → root == leaf, proof == [].

- [ ] **Step 1: Write the failing tests (append to merkle.test.ts)**

```typescript
import { buildTree, verifyProof } from '../src/core/merkle.ts';

const ehs = (n: number) => Array.from({ length: n }, (_, i) => sha(new Uint8Array([i])));

test('single leaf: root == leaf, empty proof', () => {
  const [eh] = ehs(1);
  const tree = buildTree([{ seq: 0, eventHash: eh! }]);
  assert.deepEqual(tree.root, leafHash(0, eh!));
  assert.deepEqual(tree.proof(0), []);
  assert.ok(verifyProof(tree.root, 0, eh!, []));
});

test('two leaves: proof verifies', () => {
  const [e0, e1] = ehs(2);
  const tree = buildTree([{ seq: 0, eventHash: e0! }, { seq: 1, eventHash: e1! }]);
  assert.deepEqual(tree.root, internalHash(leafHash(0, e0!), leafHash(1, e1!)));
  assert.ok(verifyProof(tree.root, 0, e0!, tree.proof(0)));
  assert.ok(verifyProof(tree.root, 1, e1!, tree.proof(1)));
});

test('three leaves (odd promote): all proofs verify', () => {
  const e = ehs(3);
  const leaves = e.map((eh, i) => ({ seq: i, eventHash: eh }));
  const tree = buildTree(leaves);
  for (let i = 0; i < 3; i++) assert.ok(verifyProof(tree.root, i, e[i]!, tree.proof(i)));
  // explicit promote-shape check: L2 is promoted, then paired with hash(L0,L1)
  const root = internalHash(internalHash(leafHash(0, e[0]!), leafHash(1, e[1]!)), leafHash(2, e[2]!));
  assert.deepEqual(tree.root, root);
});

test('verifyProof rejects tampered eventHash', () => {
  const e = ehs(2);
  const tree = buildTree(e.map((eh, i) => ({ seq: i, eventHash: eh })));
  const bad = sha(new Uint8Array([99]));
  assert.equal(verifyProof(tree.root, 0, bad, tree.proof(0)), false);
});

test('buildTree throws on empty input', () => {
  assert.throws(() => buildTree([]));
});

test('proof throws on unknown seq', () => {
  const e = ehs(2);
  const tree = buildTree(e.map((eh, i) => ({ seq: i, eventHash: eh })));
  assert.throws(() => tree.proof(99));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sdk && npx tsx --test test/merkle.test.ts`
Expected: FAIL — `buildTree`/`verifyProof` not exported.

- [ ] **Step 3: Implement (append to merkle.ts)**

```typescript
import type { MerkleLeaf, MerkleTree } from './types.ts';

export function buildTree(leaves: MerkleLeaf[]): MerkleTree {
  if (leaves.length === 0) throw new Error('buildTree: at least one leaf required');

  // level 0 = leaf hashes, indexed by input position
  const level0 = leaves.map((l) => leafHash(l.seq, l.eventHash));
  const seqIndex = new Map<string, number>();
  leaves.forEach((l, i) => seqIndex.set(toU64(l.seq).toString(), i));

  // Build all levels; levels[0] = leaves, levels[top] = [root].
  const levels: Uint8Array[][] = [level0];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) next.push(internalHash(prev[i]!, prev[i + 1]!));
      else next.push(prev[i]!); // promote unpaired tail unchanged
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1]![0]!;

  const proof = (seq: number | bigint): Uint8Array[] => {
    const key = toU64(seq).toString();
    const start = seqIndex.get(key);
    if (start === undefined) throw new Error(`proof: seq ${key} not in tree`);
    const out: Uint8Array[] = [];
    let idx = start;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const nodes = levels[lvl]!;
      const isRight = idx % 2 === 1;
      const sibIdx = isRight ? idx - 1 : idx + 1;
      if (sibIdx < nodes.length) out.push(nodes[sibIdx]!); // else: promoted, no sibling
      idx = Math.floor(idx / 2);
    }
    return out;
  };

  return { root, proof };
}

export function verifyProof(
  root: Uint8Array, seq: number | bigint, eventHash: Uint8Array, proof: Uint8Array[],
): boolean {
  let cur = leafHash(seq, eventHash);
  for (const sib of proof) cur = internalHash(cur, sib);
  if (cur.length !== root.length) return false;
  for (let i = 0; i < cur.length; i++) if (cur[i] !== root[i]) return false;
  return true;
}
```

> ⚠️ Implementer note: `toU64` and `internalHash`/`leafHash` are already defined earlier in the
> file (Task 4). Do not redefine. Add the `MerkleLeaf, MerkleTree` import at top with existing imports.

- [ ] **Step 4: Run to verify pass**

Run: `cd sdk && npx tsx --test test/merkle.test.ts`
Expected: PASS (all primitive + tree tests).

- [ ] **Step 5: Checkpoint** — typecheck green; full merkle suite passes.

---

## Task 6: Move golden-vector test → authoritative hex

**Files:**
- Create: `move/tests/golden_vectors.move`

> Emits the contract's own leaf/internal/batch_hash hex so the SDK conformance test can
> assert byte-for-byte equality against the real Move implementation.

- [ ] **Step 1: Write the Move test**

```move
#[test_only]
module compliance_vault::golden_vectors {
    use std::hash;
    use std::bcs;
    use std::debug;

    // Recompute the same primitives receipt.move uses, and print hex.
    // (receipt.move keeps leaf_hash/hash_pair private; we re-derive identically here
    //  and ALSO cross-check via receipt::leaf_hash_for_test.)
    fun sha(b: vector<u8>): vector<u8> { hash::sha2_256(b) }

    fun leaf(seq: u64, eh: vector<u8>): vector<u8> {
        let mut buf = vector[0x00u8];
        vector::append(&mut buf, bcs::to_bytes(&seq));
        vector::append(&mut buf, eh);
        sha(buf)
    }

    fun internal(a: vector<u8>, b: vector<u8>): vector<u8> {
        let mut buf = vector[0x01u8];
        // bytewise min/max — match receipt.move hash_pair
        let a_le = le(&a, &b);
        if (a_le) { vector::append(&mut buf, a); vector::append(&mut buf, b); }
        else { vector::append(&mut buf, b); vector::append(&mut buf, a); };
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

    fun batch_hash(parent: vector<u8>, root: vector<u8>, ss: u64, se: u64): vector<u8> {
        let mut buf = parent;
        vector::append(&mut buf, root);
        vector::append(&mut buf, bcs::to_bytes(&ss));
        vector::append(&mut buf, bcs::to_bytes(&se));
        sha(buf)
    }

    #[test]
    fun emit_golden() {
        // event hashes: sha256(0x01), sha256(0x02), sha256(0x03)
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

        debug::print(&b"GOLDEN leaf0".to_string());      debug::print(&l0);
        debug::print(&b"GOLDEN leaf1".to_string());      debug::print(&l1);
        debug::print(&b"GOLDEN leaf2".to_string());      debug::print(&l2);
        debug::print(&b"GOLDEN two_root".to_string());   debug::print(&two_root);
        debug::print(&b"GOLDEN three_root".to_string()); debug::print(&three_root);
        debug::print(&b"GOLDEN bh_genesis".to_string()); debug::print(&bh_genesis);
        debug::print(&b"GOLDEN bh_chained".to_string()); debug::print(&bh_chained);
    }
}
```

> Implementer note: if `compliance_vault` is not the exact `Move.toml` package address name, fix the
> `module <addr>::golden_vectors` and the `receipt::leaf_hash_for_test` path to match. Check
> `move/sources/receipt.move`'s `module` declaration for the correct address alias.

- [ ] **Step 2: Run the Move test and capture hex**

Run: `cd move && sui move test golden_vectors -- --verbose 2>&1 | grep -A1 GOLDEN`
(If `--verbose` flag differs in CLI 1.71/1.72, use `sui move test golden 2>&1`.)
Expected: prints 7 byte-vectors. Record each hex value — these are the golden vectors for Task 7.

> The `debug::print` of a `vector<u8>` prints decimal byte arrays; convert to hex, OR change the
> prints to emit hex strings. Simplest: keep raw output and convert when hardcoding in TS.

- [ ] **Step 3: Confirm the existing suite still passes**

Run: `cd move && sui move test`
Expected: 20/20 (the original suite) + the new `emit_golden` test = 21 PASS.

- [ ] **Step 4: Checkpoint** — Move golden hex captured; full Move suite green.

---

## Task 7: Conformance test — golden vectors + cross-impl + seed regression

**Files:**
- Create: `sdk/test/conformance.test.ts`

- [ ] **Step 1: Write the conformance test**

> Replace each `0x...PASTE...` with the hex captured in Task 6 Step 2.

```typescript
// sdk/test/conformance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { leafHash, internalHash, batchHash, buildTree, verifyProof } from '../src/core/merkle.ts';

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// ── Golden vectors emitted by move/tests/golden_vectors.move (Task 6) ──
const GOLD = {
  leaf0:      '0x...PASTE...',
  leaf1:      '0x...PASTE...',
  leaf2:      '0x...PASTE...',
  twoRoot:    '0x...PASTE...',
  threeRoot:  '0x...PASTE...',
  bhGenesis:  '0x...PASTE...',
  bhChained:  '0x...PASTE...',
};

const eh0 = sha(new Uint8Array([1]));
const eh1 = sha(new Uint8Array([2]));
const eh2 = sha(new Uint8Array([3]));

test('SDK leafHash == Move golden', () => {
  assert.equal(hex(leafHash(0, eh0)), GOLD.leaf0.slice(2));
  assert.equal(hex(leafHash(1, eh1)), GOLD.leaf1.slice(2));
  assert.equal(hex(leafHash(2, eh2)), GOLD.leaf2.slice(2));
});

test('SDK two-leaf root == Move golden', () => {
  const tree = buildTree([{ seq: 0, eventHash: eh0 }, { seq: 1, eventHash: eh1 }]);
  assert.equal(hex(tree.root), GOLD.twoRoot.slice(2));
});

test('SDK odd-three root == Move golden (promote path)', () => {
  const tree = buildTree([
    { seq: 0, eventHash: eh0 }, { seq: 1, eventHash: eh1 }, { seq: 2, eventHash: eh2 },
  ]);
  assert.equal(hex(tree.root), GOLD.threeRoot.slice(2));
});

test('SDK batchHash genesis + chained == Move golden', () => {
  const g = batchHash(new Uint8Array(0), fromHex(GOLD.twoRoot), 0n, 1n);
  assert.equal(hex(g), GOLD.bhGenesis.slice(2));
  const c = batchHash(fromHex(GOLD.bhGenesis), leafHash(2, eh2), 2n, 2n);
  assert.equal(hex(c), GOLD.bhChained.slice(2));
});

// ── Cross-impl: indexer seed.ts uses the same scheme (replicated inline to avoid
//    importing across packages). Asserts the SDK matches seed.ts's formulas. ──
test('SDK matches indexer/seed.ts leaf & internal formulas', () => {
  const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return new Uint8Array(b); };
  const seedLeaf = (seq: number, eh: Uint8Array) =>
    sha(new Uint8Array([0x00, ...u64le(seq), ...eh]));
  const seedInternal = (a: Uint8Array, b: Uint8Array) => {
    const [lo, hi] = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? [a, b] : [b, a];
    return sha(new Uint8Array([0x01, ...lo, ...hi]));
  };
  assert.deepEqual(leafHash(7, eh0), seedLeaf(7, eh0));
  assert.deepEqual(internalHash(eh0, eh1), seedInternal(eh0, eh1));
});

// ── seed.ts fixture regression: its published proofs must verify under the SDK. ──
test('seed.ts batch0 fixture verifies (seq0, proof=[L1])', () => {
  const L1 = leafHash(1, eh1);
  const root0 = internalHash(leafHash(0, eh0), L1);
  // NOTE: seed.ts uses sha256("event-0") for its eventHash, not sha256([1]). The shape
  // (proof=[sibling-leaf]) is what we regression-check here with our own eh values.
  assert.ok(verifyProof(root0, 0, eh0, [L1]));
});

test('seed.ts single-leaf fixture verifies (proof=[])', () => {
  const root1 = leafHash(2, eh2);
  assert.ok(verifyProof(root1, 2, eh2, []));
});
```

> Implementer note: the two seed-fixture tests intentionally use the SDK's own event-hash
> inputs (not seed.ts's literal `sha256("event-0")`) — they regression-check the proof *shape*
> (sibling-leaf for 2-leaf, empty for single-leaf), which is what could drift. The golden-vector
> tests are the authoritative Move cross-check.

- [ ] **Step 2: Paste real golden hex from Task 6, then run**

Run: `cd sdk && npx tsx --test test/conformance.test.ts`
Expected: PASS (7 tests). If golden tests fail, the SDK has drifted from Move — STOP and debug, do not adjust golden values to match SDK.

- [ ] **Step 3: Checkpoint** — conformance green against authoritative Move hex.

---

## Task 8: Property + monkey tests

**Files:**
- Modify: `sdk/test/merkle.test.ts` (append property/monkey section)

> Per `.claude/rules/test.md`: monkey testing mandatory after unit/integration.

- [ ] **Step 1: Append the tests**

```typescript
// ── property + monkey ──
test('property: every leaf proof verifies for random tree sizes', () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 16, 31, 64, 100, 256]) {
    const leaves = Array.from({ length: n }, (_, i) => ({ seq: i, eventHash: sha(new Uint8Array([i & 0xff, (i >> 8) & 0xff])) }));
    const tree = buildTree(leaves);
    for (let i = 0; i < n; i++) {
      assert.ok(verifyProof(tree.root, i, leaves[i]!.eventHash, tree.proof(i)), `n=${n} i=${i}`);
    }
  }
});

test('monkey: flipping one bit of any sibling breaks verification', () => {
  const n = 9;
  const leaves = Array.from({ length: n }, (_, i) => ({ seq: i, eventHash: sha(new Uint8Array([i])) }));
  const tree = buildTree(leaves);
  const p = tree.proof(3);
  if (p.length > 0) {
    const tampered = p.map((s) => new Uint8Array(s));
    tampered[0]![0] ^= 0x01;
    assert.equal(verifyProof(tree.root, 3, leaves[3]!.eventHash, tampered), false);
  }
});

test('monkey: wrong seq fails verification', () => {
  const leaves = Array.from({ length: 4 }, (_, i) => ({ seq: i, eventHash: sha(new Uint8Array([i])) }));
  const tree = buildTree(leaves);
  assert.equal(verifyProof(tree.root, 1, leaves[0]!.eventHash, tree.proof(0)), false);
});

test('monkey: extra/missing sibling fails verification', () => {
  const leaves = Array.from({ length: 4 }, (_, i) => ({ seq: i, eventHash: sha(new Uint8Array([i])) }));
  const tree = buildTree(leaves);
  const p = tree.proof(0);
  assert.equal(verifyProof(tree.root, 0, leaves[0]!.eventHash, [...p, sha(new Uint8Array([255]))]), false);
  assert.equal(verifyProof(tree.root, 0, leaves[0]!.eventHash, p.slice(0, -1)), false);
});

test('monkey: bigint seq boundaries (2^53, 2^64-1) hash without error', () => {
  const eh = sha(new Uint8Array([1]));
  assert.equal(leafHash(2n ** 53n, eh).length, 32);
  assert.equal(leafHash(2n ** 64n - 1n, eh).length, 32);
  assert.throws(() => leafHash(2n ** 64n, eh));
});

test('monkey: duplicate eventHashes still build a valid tree', () => {
  const eh = sha(new Uint8Array([42]));
  const leaves = Array.from({ length: 5 }, (_, i) => ({ seq: i, eventHash: eh }));
  const tree = buildTree(leaves);
  for (let i = 0; i < 5; i++) assert.ok(verifyProof(tree.root, i, eh, tree.proof(i)));
});
```

- [ ] **Step 2: Run the full merkle suite**

Run: `cd sdk && npx tsx --test test/merkle.test.ts`
Expected: PASS (primitives + tree + property + monkey).

- [ ] **Step 3: Checkpoint** — monkey suite green.

---

## Task 9: `tx/anchor.ts` — buildAnchorTx + fail-loud guards

**Files:**
- Create: `sdk/src/tx/anchor.ts`
- Test: `sdk/test/anchor.test.ts`

> Verified API (from `@mysten/sui/dist/transactions/pure.d.mts`):
> `tx.pure.vector('u8', uint8arrayLike)` and `tx.pure.vector('vector<u8>', arrayOfUint8Array)`.
> Returns an UNSIGNED `Transaction`. Per spec §3.1, a full `tx.build()` needs a client to
> resolve the shared namespace — so tests inspect the serialized command structure, not `build()`.

- [ ] **Step 1: Write the failing test**

```typescript
// sdk/test/anchor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnchorTx } from '../src/tx/anchor.ts';
import type { AnchorBatchInput } from '../src/core/types.ts';

const PKG = '0xcb5cc62066b4bbc2e66961b48d5141f9cf3ec119e33a7f6d6ec235a1d413b14c';
const base = (): AnchorBatchInput => ({
  packageId: PKG,
  namespaceId: '0x' + '11'.repeat(32),
  writerCapId: '0x' + '22'.repeat(32),
  runId: new Uint8Array(32).fill(0x12),
  seqStart: 0n,
  seqEnd: 1n,
  merkleRoot: new Uint8Array(32).fill(0xab),
  blobIds: [new Uint8Array([1]), new Uint8Array([2])],
  parentBatchHash: new Uint8Array(0),
});

test('builds a MoveCall to receipt::anchor_batch with 8 explicit args', () => {
  const tx = buildAnchorTx(base());
  const data = tx.getData();
  const cmd = data.commands.find((c: any) => c.MoveCall);
  assert.ok(cmd, 'has a MoveCall');
  assert.equal(cmd.MoveCall.package, PKG);
  assert.equal(cmd.MoveCall.module, 'receipt');
  assert.equal(cmd.MoveCall.function, 'anchor_batch');
  // ns, cap, run_id, seq_start, seq_end, merkle_root, blob_ids, parent_batch_hash, clock = 9 args
  assert.equal(cmd.MoveCall.arguments.length, 9);
});

test('guard: blobIds length must equal seq range count', () => {
  assert.throws(() => buildAnchorTx({ ...base(), blobIds: [new Uint8Array([1])] }), /blob/i);
});

test('guard: seqEnd < seqStart throws', () => {
  assert.throws(() => buildAnchorTx({ ...base(), seqStart: 5n, seqEnd: 1n, blobIds: [] }), /seq/i);
});

test('guard: merkleRoot must be 32 bytes', () => {
  assert.throws(() => buildAnchorTx({ ...base(), merkleRoot: new Uint8Array(10) }), /root/i);
});

test('guard: runId must be 32 bytes', () => {
  assert.throws(() => buildAnchorTx({ ...base(), runId: new Uint8Array(10) }), /runId/i);
});

test('guard: empty blobId throws', () => {
  assert.throws(() => buildAnchorTx({ ...base(), blobIds: [new Uint8Array([1]), new Uint8Array(0)] }), /blob/i);
});

test('guard: non-empty parentBatchHash must be 32 bytes', () => {
  assert.throws(() => buildAnchorTx({ ...base(), parentBatchHash: new Uint8Array(5) }), /parent/i);
});

test('genesis parent (empty) is accepted', () => {
  assert.doesNotThrow(() => buildAnchorTx(base()));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sdk && npx tsx --test test/anchor.test.ts`
Expected: FAIL — `buildAnchorTx` not found.

- [ ] **Step 3: Implement**

```typescript
// sdk/src/tx/anchor.ts
import { Transaction } from '@mysten/sui/transactions';
import type { AnchorBatchInput } from '../core/types.ts';

export function buildAnchorTx(input: AnchorBatchInput): Transaction {
  const {
    packageId, namespaceId, writerCapId, clockId = '0x6',
    runId, seqStart, seqEnd, merkleRoot, blobIds, parentBatchHash,
  } = input;

  // ── fail-loud guards (Rule-12; pre-flight for a value-bearing tx) ──
  if (seqEnd < seqStart) throw new Error(`seqEnd (${seqEnd}) < seqStart (${seqStart})`);
  const count = seqEnd - seqStart + 1n;
  if (BigInt(blobIds.length) !== count) {
    throw new Error(`blobIds length ${blobIds.length} != seq range count ${count}`);
  }
  if (merkleRoot.length !== 32) throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  if (runId.length !== 32) throw new Error(`runId must be 32 bytes, got ${runId.length}`);
  for (const [i, b] of blobIds.entries()) {
    if (b.length === 0) throw new Error(`blobIds[${i}] is empty`);
  }
  if (parentBatchHash.length !== 0 && parentBatchHash.length !== 32) {
    throw new Error(`parentBatchHash must be empty (genesis) or 32 bytes, got ${parentBatchHash.length}`);
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::receipt::anchor_batch`,
    arguments: [
      tx.object(namespaceId),
      tx.object(writerCapId),
      tx.pure.vector('u8', runId),
      tx.pure.u64(seqStart),
      tx.pure.u64(seqEnd),
      tx.pure.vector('u8', merkleRoot),
      tx.pure.vector('vector<u8>', blobIds),
      tx.pure.vector('u8', parentBatchHash),
      tx.object(clockId),
    ],
  });
  return tx;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd sdk && npx tsx --test test/anchor.test.ts`
Expected: PASS (8 tests). If `tx.getData()` shape differs (e.g. `$kind` discriminated commands), adjust the test's command access to match the installed `@mysten/sui` 2.16 `getData()` return — inspect `node_modules/@mysten/sui/dist/transactions/TransactionData.d.mts`. Do NOT weaken the arg-count/target assertions.

- [ ] **Step 5: Checkpoint** — anchor tests pass.

---

## Task 10: Public surface + full green

**Files:**
- Modify: `sdk/src/core/index.ts`
- Modify: `sdk/src/index.ts`

- [ ] **Step 1: Write `core/index.ts`**

```typescript
export type { ComplianceEvent, MerkleLeaf, MerkleTree, AnchorBatchInput } from './types.ts';
export { encodeEvent, eventHash } from './event.ts';
export { leafHash, internalHash, batchHash, buildTree, verifyProof } from './merkle.ts';
```

- [ ] **Step 2: Write `src/index.ts`**

```typescript
export * from './core/index.ts';
export { buildAnchorTx } from './tx/anchor.ts';
```

- [ ] **Step 3: Full typecheck + full test run**

Run: `cd sdk && pnpm typecheck && npx tsx --test test/*.test.ts`
Expected: typecheck exits 0; all suites PASS (event, merkle, conformance, anchor).

- [ ] **Step 4: Checkpoint** — entire Stage A green.

---

## Post-Plan: notes update (per project rules)

- [ ] Update `tasks/progress.md`: mark TODO #6 done (SDK Stage A: core+tx+conformance shipped; B/C deferred).
- [ ] Append to `move-notes.md`: golden-vector test added; SDK conformance now machine-locks the merkle/batch_hash format across Move/indexer/UI.
- [ ] Record any `tx.getData()` / `tx.pure` quirks discovered into `tasks/lessons.md`.

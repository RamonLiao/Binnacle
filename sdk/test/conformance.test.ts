import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { leafHash, internalHash, batchHash, buildTree, verifyProof } from '../src/core/merkle.ts';

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// ── Golden vectors emitted by move/tests/golden_vectors.move::emit_golden ──
// Authoritative output of `sui move test emit_golden` (sui 1.73.1). Do NOT edit to
// match the SDK — if these fail, the SDK has drifted from receipt.move.
const GOLD = {
  leaf0:     '0x8189bb3c0875057b9f188d5f2db63731a480ed5041b64f5d2ff8eec484c1e7f5',
  leaf1:     '0xf2234e436a76674f568e8025f7543b9607910800a7ee560f4dc3bd91820ee7b8',
  leaf2:     '0xd73fa9a97cea9dddf6807108fe6a46445c4d30cd8a42a2c82ac79f2b77ba6227',
  twoRoot:   '0x632991edead2eab1c374ab1d65b63e1464735ba6ebf98ea926cecb901337e670',
  threeRoot: '0xbaa12f2cfec5eaf9e016213f1446f929d3764f2b93dafcf4915fa77e0f4e7813',
  bhGenesis: '0x61b23c206750ebe2a985691ea1ea3871e8b96e04f43fa91956a643f9620b11d1',
  bhChained: '0x7b8a190283daa18b26897e2865d2ec8b610560c0d5037ea0d6281b1fec5aea9b',
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

// ── Cross-impl: indexer/seed.ts uses the same scheme (replicated inline to avoid
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

// ── seed.ts fixture regression: proof SHAPE (sibling-leaf / empty) must verify. ──
test('seed.ts batch0 fixture shape verifies (seq0, proof=[L1])', () => {
  const L1 = leafHash(1, eh1);
  const root0 = internalHash(leafHash(0, eh0), L1);
  assert.ok(verifyProof(root0, 0, eh0, [L1]));
});

test('seed.ts single-leaf fixture shape verifies (proof=[])', () => {
  const root1 = leafHash(2, eh2);
  assert.ok(verifyProof(root1, 2, eh2, []));
});

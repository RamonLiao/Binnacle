import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { leafHash, internalHash, batchHash, buildTree, verifyProof } from '../src/core/merkle.ts';

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

// ── tree / proof (Task 5) ──
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

// ── property + monkey (Task 8) ──
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
    const first = tampered[0]!;
    first[0] = first[0]! ^ 0x01;
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

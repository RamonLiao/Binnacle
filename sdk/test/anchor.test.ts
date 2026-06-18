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

test('builds a MoveCall to receipt::anchor_batch with 9 explicit args', () => {
  const tx = buildAnchorTx(base());
  const data = tx.getData();
  const cmd = data.commands.find((c: any) => c.MoveCall) as any;
  assert.ok(cmd, 'has a MoveCall');
  assert.equal(cmd.MoveCall.package, PKG);
  assert.equal(cmd.MoveCall.module, 'receipt');
  assert.equal(cmd.MoveCall.function, 'anchor_batch');
  // ns, cap, run_id, seq_start, seq_end, merkle_root, blob_ids, parent_batch_hash, clock
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

test('guard: batch size > BATCH_MAX_EVENTS (4096) throws', () => {
  assert.throws(
    () => buildAnchorTx({ ...base(), seqStart: 0n, seqEnd: 4096n, blobIds: Array.from({ length: 4097 }, () => new Uint8Array([1])) }),
    /BATCH_MAX_EVENTS|4096/,
  );
});

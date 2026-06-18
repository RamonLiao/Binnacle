import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';
import { AnchorClient } from '../src/client/anchorClient.ts';
import type { AnchorBatchInput } from '../src/core/types.ts';

const ADDR = '0x' + 'ab'.repeat(32);

function stubSigner(result: unknown) {
  const calls: { transaction: Transaction; client: unknown }[] = [];
  const signer = {
    toSuiAddress: () => ADDR,
    signAndExecuteTransaction: async (opts: { transaction: Transaction; client: unknown }) => {
      calls.push(opts);
      return result;
    },
  } as unknown as Signer;
  return { signer, calls };
}

const DUMMY_CLIENT = {} as never;

function validInput(): AnchorBatchInput {
  return {
    packageId: '0x' + '1'.repeat(64),
    namespaceId: '0x' + '2'.repeat(64),
    writerCapId: '0x' + '3'.repeat(64),
    runId: new Uint8Array(32).fill(9),
    seqStart: 0n,
    seqEnd: 1n,
    merkleRoot: new Uint8Array(32).fill(1),
    blobIds: [new Uint8Array([1]), new Uint8Array([2])],
    parentBatchHash: new Uint8Array(0),
  };
}

const okResult = {
  $kind: 'Transaction' as const,
  Transaction: { digest: 'DIGEST123', effects: { status: { success: true, error: null } } },
};

test('refuses to anchor mock data by default (no allowMockAnchor)', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  await assert.rejects(() => client.anchorBatch(validInput()), /mock anchor blocked/);
  assert.equal(calls.length, 0, 'signer must not be called when blocked');
});

test('with allowMockAnchor:true, returns the digest and sets sender to signer address', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const { digest } = await client.anchorBatch(validInput(), { allowMockAnchor: true });
  assert.equal(digest, 'DIGEST123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.transaction.getData().sender, ADDR);
  assert.equal(calls[0]!.client, DUMMY_CLIENT, 'client forwarded to signer');
});

test('throws when execution returns FailedTransaction (vector 5a)', async () => {
  const failed = { $kind: 'FailedTransaction' as const, FailedTransaction: { digest: 'X' } };
  const { signer } = stubSigner(failed);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  await assert.rejects(() => client.anchorBatch(validInput(), { allowMockAnchor: true }), /failed before execution/);
});

test('throws when effects.status.success is false — Move abort with a digest (vector 5b)', async () => {
  const aborted = {
    $kind: 'Transaction' as const,
    Transaction: { digest: 'ABORTED_DIGEST', effects: { status: { success: false, error: { kind: 'MoveAbort', code: 7 } } } },
  };
  const { signer } = stubSigner(aborted);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  await assert.rejects(() => client.anchorBatch(validInput(), { allowMockAnchor: true }), /aborted on-chain/);
});

test('seq/blobIds mismatch throws via the reused anchor guard, before signing (vector 2)', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const bad = validInput();
  bad.blobIds = [new Uint8Array([1])];
  await assert.rejects(() => client.anchorBatch(bad, { allowMockAnchor: true }), /blobIds length/);
  assert.equal(calls.length, 0, 'must fail before reaching the signer');
});

// monkey tests
test('monkey: oversized batch (count 4097) rejected before signing', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const bad = validInput();
  bad.seqStart = 0n;
  bad.seqEnd = 4096n;
  bad.blobIds = Array.from({ length: 4097 }, () => new Uint8Array([1]));
  await assert.rejects(() => client.anchorBatch(bad, { allowMockAnchor: true }), /exceeds BATCH_MAX_EVENTS/);
  assert.equal(calls.length, 0);
});

test('monkey: seqEnd = 2^64-1 boundary rejected before signing', async () => {
  const { signer } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const bad = validInput();
  bad.seqEnd = 0xffff_ffff_ffff_ffffn;
  await assert.rejects(() => client.anchorBatch(bad, { allowMockAnchor: true }), /2\^64-1|exceeds/);
});

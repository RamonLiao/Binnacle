import { Transaction } from '@mysten/sui/transactions';
import type { AnchorBatchInput } from '../core/types.ts';

export function buildAnchorTx(input: AnchorBatchInput): Transaction {
  const {
    packageId, namespaceId, writerCapId, clockId = '0x6',
    runId, seqStart, seqEnd, merkleRoot, blobIds, parentBatchHash,
  } = input;

  // ── fail-loud guards (Rule-12; pre-flight for a value-bearing tx) ──
  if (seqStart < 0n) throw new Error(`seqStart must be >= 0, got ${seqStart}`);
  if (seqEnd < seqStart) throw new Error(`seqEnd (${seqEnd}) < seqStart (${seqStart})`);
  // mirror receipt.move: seq_end < MAX_U64, count <= BATCH_MAX_EVENTS (4096)
  if (seqEnd >= 0xffff_ffff_ffff_ffffn) throw new Error(`seqEnd must be < 2^64-1, got ${seqEnd}`);
  const count = seqEnd - seqStart + 1n;
  if (count > 4096n) throw new Error(`batch size ${count} exceeds BATCH_MAX_EVENTS (4096)`);
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
      tx.pure.vector('vector<u8>', blobIds.map((b) => Array.from(b))),
      tx.pure.vector('u8', parentBatchHash),
      tx.object(clockId),
    ],
  });
  return tx;
}

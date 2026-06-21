import { signerFromEnv } from '../src/client/signer.ts';
import { AnchorClient } from '../src/client/anchorClient.ts';
import { eventHash, buildTree, type ComplianceEvent } from '../src/core/index.ts';
import { PACKAGE_ID, grpcClient, requireEnv, suiscan } from './_grpc.ts';

const GENESIS_EVENT_HASH = '0x' + '00'.repeat(32);

// Fixed 32-byte literals (no @noble/hashes dep in this package).
const RUN_ID = Uint8Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff);
const MOCK_BLOB_ID = Uint8Array.from({ length: 32 }, () => 0xaa);

/** Deterministic synthetic event for seq `s` linked to `prevEventHash`. */
function makeEvent(namespaceId: string, s: bigint, prevEventHash: string): ComplianceEvent {
  return {
    v: 1,
    ns: namespaceId,
    run_id: '0x' + '11'.repeat(32),
    seq: s,
    ts_ms: 0,
    type: 'e2e.test',
    agent: { model: 'e2e', version: '0', prompt_hash: '0x' + '00'.repeat(32) },
    input_hash: '0x' + '00'.repeat(32),
    output_hash: '0x' + '00'.repeat(32),
    payload: { note: 'stage-b e2e' },
    prev_event_hash: prevEventHash,
  };
}

async function main() {
  const signer = signerFromEnv();
  const client = grpcClient();
  const namespaceId = requireEnv('NAMESPACE_ID');
  const writerCapId = requireEnv('WRITER_CAP_ID');

  // ⭐ §6 check: gRPC must resolve the shared AgentNamespace and expose its fields.
  const { object } = await client.core.getObject({
    objectId: namespaceId,
    include: { json: true },
  });
  if (!object.json) throw new Error('AgentNamespace has no json content over gRPC');
  const seqNextRaw = object.json.seq_next;
  const lastHashRaw = object.json.last_batch_hash;
  if (seqNextRaw === undefined || lastHashRaw === undefined) {
    throw new Error(`unexpected namespace json shape: ${JSON.stringify(object.json)}`);
  }
  const seqNext = BigInt(seqNextRaw as string | number);
  // last_batch_hash: gRPC may render vector<u8> as number[] or 0x-hex. Normalize to Uint8Array.
  const parentBatchHash = toBytes(lastHashRaw);

  // synthetic single-leaf batch at seq = seqNext.
  // The event chain is hash-linked: prev_event_hash[n] = eventHash(event[n-1]),
  // with event[0].prev = genesis. Events aren't persisted (only batch hashes go
  // on-chain), but every field except `seq` is deterministic, so fold the chain
  // from 0 up to seqNext to recover the correct prev hash. Anchoring at seqNext
  // with a fixed genesis prev (the old behavior) breaks the chain on any re-run
  // where seq_next has advanced past 0.
  let prevEventHash = GENESIS_EVENT_HASH;
  for (let s = 0n; s < seqNext; s++) {
    prevEventHash = '0x' + Buffer.from(eventHash(makeEvent(namespaceId, s, prevEventHash))).toString('hex');
  }
  const event = makeEvent(namespaceId, seqNext, prevEventHash);
  const eh = eventHash(event);
  const tree = buildTree([{ seq: seqNext, eventHash: eh }]);

  const result = await new AnchorClient(client, signer).anchorBatch({
    packageId: PACKAGE_ID,
    namespaceId,
    writerCapId,
    runId: RUN_ID,
    seqStart: seqNext,
    seqEnd: seqNext,
    merkleRoot: tree.root,
    blobIds: [MOCK_BLOB_ID],
    parentBatchHash,
  });

  console.log(`✅ anchor finalized at seq ${seqNext}: ${suiscan(result.digest)}`);
}

/**
 * vector<u8> from gRPC json. Verified on testnet (2026-06-19): the gRPC
 * `getObject({json:true})` renders vector<u8> as a **base64 string**, NOT
 * number[] or 0x-hex. (A 32-byte value → 44-char base64; decoding it as hex
 * yielded 22 bytes and aborted the contract's `parentBatchHash` length check.)
 * Empty vector → "" → empty. 0x-hex and number[] kept as defensive fallbacks.
 */
function toBytes(v: unknown): Uint8Array {
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (typeof v === 'string') {
    if (v.length === 0) return new Uint8Array(0);
    if (v.startsWith('0x')) {
      const hex = v.slice(2);
      return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    }
    return Uint8Array.from(Buffer.from(v, 'base64'));
  }
  throw new Error(`cannot decode vector<u8> from ${JSON.stringify(v)}`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});

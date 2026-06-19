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

    // (2) size cap + (3) contiguity + intra-run chain validation (mirrors the contract).
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

    // (5) per-event encrypt -> upload (sequential: order + bounded WAL).
    const blobIds: Uint8Array[] = [];
    for (const e of events) {
      const enc = await this.seal.encrypt(encodeEvent(e), e);
      blobIds.push(await this.walrus.upload(enc));
    }

    // (6) merkle over eventHash leaves.
    const leaves: MerkleLeaf[] = events.map((e) => ({ seq: e.seq, eventHash: eventHash(e) }));
    const tree = buildTree(leaves);

    // (7) anchor.
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
    // BatchProver's positive-brand mock-fence (step 1) is the authoritative real/mock
    // gate; it strictly supersedes AnchorClient's own `allowMockAnchor` guard. Since
    // we only reach here with proven-real impls (or an explicit allowMock opt-in),
    // permit the anchor unconditionally — the lower guard must not re-deny a real
    // batch. Without this, a real run requires the misleadingly-named
    // ALLOW_MOCK_ANCHOR=true env (final-review Important).
    const { digest } = await this.anchor.anchorBatch(anchorInput, { ...opts, allowMockAnchor: true });
    return { digest, blobIds };
  }
}

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchProver } from '../src/client/prover.ts';
import { MockSealEncryptor, SealEncryptorImpl } from '../src/seal/encryptor.ts';
import { MockWalrusStore, RealWalrusStore } from '../src/walrus/store.ts';
import { buildTree, eventHash } from '../src/core/index.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const PKG = '0x' + 'cb'.repeat(32);
const NS = '0x' + '11'.repeat(32);
const CAP = '0x' + '22'.repeat(32);
const GENESIS = '0x' + '00'.repeat(32);
const hex = (u: Uint8Array) => '0x' + Buffer.from(u).toString('hex');

const mkEvent = (seq: number, prev: string): ComplianceEvent => ({
  v: 1, ns: 'n', run_id: 'r', seq, ts_ms: 1_700_000_000_000 + seq, type: 'login',
  agent: { model: 'm', version: '1', prompt_hash: '0x00' },
  input_hash: '0x00', output_hash: '0x00', payload: { seq }, prev_event_hash: prev,
});

function chained(n: number): ComplianceEvent[] {
  const evs: ComplianceEvent[] = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const e = mkEvent(i, prev);
    evs.push(e);
    prev = hex(eventHash(e));
  }
  return evs;
}

function fakeAnchor() {
  const calls: any[] = [];
  return { client: { anchorBatch: async (input: any) => { calls.push(input); return { digest: '0xDEAD' }; } } as any, calls };
}

const baseInput = (events: ComplianceEvent[]) => ({
  events, runId: new Uint8Array(32).fill(0x12), parentBatchHash: new Uint8Array(0),
  packageId: PKG, namespaceId: NS, writerCapId: CAP,
});

test('proveBatch with all-mocks (allowMock) produces correct AnchorBatchInput', async () => {
  const { client, calls } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  const events = chained(2);
  const res = await prover.proveBatch(baseInput(events), { allowMock: true });
  assert.equal(res.digest, '0xDEAD');
  assert.equal(res.blobIds.length, 2);
  const input = calls[0];
  assert.equal(input.blobIds.length, 2); // one blob per event
  assert.equal(input.seqStart, 0n);
  assert.equal(input.seqEnd, 1n);
  const tree = buildTree(events.map((e) => ({ seq: e.seq, eventHash: eventHash(e) })));
  assert.deepEqual([...input.merkleRoot], [...tree.root]);
});

test('proveBatch REJECTS a mock impl on the real path (mock-fence)', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  await assert.rejects(() => prover.proveBatch(baseInput(chained(1))), /mock impl/i);
});

test('mock-fence rejects a MIXED real-seal + mock-walrus combo (the dangerous case)', async () => {
  const { client } = fakeAnchor();
  const stub = { encrypt: async () => ({ encryptedObject: new Uint8Array([1]), key: new Uint8Array() }) } as any;
  const realSeal = new SealEncryptorImpl({ sealClient: stub, packageId: PKG, namespaceId: NS, skipSelfCheck: true });
  const prover = new BatchProver(realSeal, new MockWalrusStore(), client); // real seal, MOCK walrus
  await assert.rejects(() => prover.proveBatch(baseInput(chained(1))), /mock impl/i);
});

test('real-branded seal + real-branded walrus passes the fence', async () => {
  const { client } = fakeAnchor();
  const stub = { encrypt: async () => ({ encryptedObject: new Uint8Array([1]), key: new Uint8Array() }) } as any;
  const realSeal = new SealEncryptorImpl({ sealClient: stub, packageId: PKG, namespaceId: NS, skipSelfCheck: true });
  const fakeWalrusClient = { walrus: { writeBlob: async () => ({ blobId: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString('base64url') }) } } as any;
  const realStore = new RealWalrusStore(fakeWalrusClient, {} as any, 3);
  const prover = new BatchProver(realSeal, realStore, client);
  const res = await prover.proveBatch(baseInput(chained(1))); // no allowMock — must pass
  assert.equal(res.digest, '0xDEAD');
});

test('proveBatch fails loud on a seq gap', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  const events = [mkEvent(0, GENESIS), mkEvent(2, GENESIS)]; // gap
  await assert.rejects(() => prover.proveBatch(baseInput(events), { allowMock: true }), /contiguous|seq/i);
});

test('proveBatch fails loud on a broken prev_event_hash chain', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  const events = [mkEvent(0, GENESIS), mkEvent(1, GENESIS)]; // e1.prev should be hash(e0), not genesis
  await assert.rejects(() => prover.proveBatch(baseInput(events), { allowMock: true }), /chain broken/i);
});

test('proveBatch enforces MAX_EVENT_BYTES', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  await assert.rejects(() => prover.proveBatch(baseInput(chained(1)), { allowMock: true, maxEventBytes: 1 }), /MAX_EVENT_BYTES|exceeds/i);
});

test('proveBatch anchors a real batch WITHOUT requiring ALLOW_MOCK_ANCHOR (gate superseded)', async () => {
  // Stub that mimics AnchorClient's default-deny guard: throws unless allowMockAnchor.
  const seen: any[] = [];
  const gatedAnchor = {
    anchorBatch: async (_input: any, opts?: any) => {
      seen.push(opts);
      if (!opts?.allowMockAnchor) throw new Error('mock anchor blocked');
      return { digest: '0xOK' };
    },
  } as any;
  const stub = { encrypt: async () => ({ encryptedObject: new Uint8Array([1]), key: new Uint8Array() }) } as any;
  const realSeal = new SealEncryptorImpl({ sealClient: stub, packageId: PKG, namespaceId: NS, skipSelfCheck: true });
  const fakeWalrusClient = { walrus: { writeBlob: async () => ({ blobId: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString('base64url') }) } } as any;
  const realStore = new RealWalrusStore(fakeWalrusClient, {} as any, 3);
  const prover = new BatchProver(realSeal, realStore, gatedAnchor);
  const res = await prover.proveBatch(baseInput(chained(1))); // no env, no allowMock — must still anchor
  assert.equal(res.digest, '0xOK');
  assert.equal(seen[0].allowMockAnchor, true); // BatchProver forwarded the permit
});

// monkey: empty batch
test('proveBatch rejects an empty event list', async () => {
  const { client } = fakeAnchor();
  const prover = new BatchProver(new MockSealEncryptor(), new MockWalrusStore(), client);
  await assert.rejects(() => prover.proveBatch(baseInput([]), { allowMock: true }), /non-empty/i);
});

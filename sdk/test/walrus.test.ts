import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MockWalrusStore, isRealStore, RealWalrusStore, decodeBlobId } from '../src/walrus/store.ts';

test('MockWalrusStore is deterministic sha256[:32] and NOT real', async () => {
  const m = new MockWalrusStore();
  const blob = new Uint8Array([1, 2, 3]);
  const got = await m.upload(blob);
  const want = new Uint8Array(createHash('sha256').update(blob).digest()).slice(0, 32);
  assert.equal(got.length, 32);
  assert.deepEqual([...got], [...want]);
  assert.deepEqual([...(await m.upload(blob))], [...got]); // deterministic
  assert.equal(isRealStore(m), false);
});

test('RealWalrusStore is brand-real and decodes blobId from a fake client', async () => {
  // blobId = base64url of 32 raw bytes (0x01..0x20)
  const raw = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const blobId = Buffer.from(raw).toString('base64url');
  const fakeClient = { walrus: { writeBlob: async () => ({ blobId }) } } as any;
  const store = new RealWalrusStore(fakeClient, {} as any, 3);
  assert.equal(isRealStore(store), true);
  const out = await store.upload(new Uint8Array([9]));
  assert.deepEqual([...out], [...raw]);
});

test('decodeBlobId rejects a non-32-byte blobId', () => {
  const short = Buffer.from(new Uint8Array(10)).toString('base64url');
  assert.throws(() => decodeBlobId(short), /32 bytes/);
});

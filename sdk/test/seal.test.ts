import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockSealEncryptor, SealEncryptorImpl, isReal } from '../src/seal/encryptor.ts';
import { eventHash } from '../src/core/index.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const ev: ComplianceEvent = {
  v: 1, ns: 'n', run_id: 'r', seq: 0, ts_ms: 1_700_000_000_000, type: 'login',
  agent: { model: 'm', version: '1', prompt_hash: '0x00' },
  input_hash: '0x00', output_hash: '0x00', payload: {}, prev_event_hash: '0x' + '00'.repeat(32),
};

const PKG = '0x' + 'cb'.repeat(32);
const NS = '0x' + '11'.repeat(32);

test('MockSealEncryptor passes plaintext through (prefixed) and is NOT real', async () => {
  const m = new MockSealEncryptor();
  const out = await m.encrypt(new Uint8Array([1, 2, 3]), ev);
  assert.deepEqual([...out.slice(-3)], [1, 2, 3]);
  assert.equal(isReal(m), false);
});

test('SealEncryptorImpl is brand-real', () => {
  const stub = { encrypt: async () => ({ encryptedObject: new Uint8Array(), key: new Uint8Array() }) } as any;
  const s = new SealEncryptorImpl({ sealClient: stub, packageId: PKG, namespaceId: NS, skipSelfCheck: true });
  assert.equal(isReal(s), true);
});

test('SealEncryptorImpl requires packageId', () => {
  const stub = {} as any;
  assert.throws(() => new SealEncryptorImpl({ sealClient: stub, packageId: '', namespaceId: NS, skipSelfCheck: true }), /SEAL_PACKAGE_ID/);
});

test('SealEncryptorImpl.encrypt derives 32-byte bucket id (hex) + eventHash aad', async () => {
  let captured: any;
  const stub = { encrypt: async (a: any) => { captured = a; return { encryptedObject: new Uint8Array([9]), key: new Uint8Array() }; } } as any;
  const s = new SealEncryptorImpl({ sealClient: stub, packageId: PKG, namespaceId: NS, skipSelfCheck: true });
  const pt = new Uint8Array([1]);
  const out = await s.encrypt(pt, ev);
  assert.deepEqual([...out], [9]);
  assert.equal(captured.threshold, 2);
  assert.equal(captured.packageId, PKG);
  assert.equal(captured.data, pt);
  assert.deepEqual([...captured.aad], [...eventHash(ev)]); // aad binds the leaf
  assert.equal(typeof captured.id, 'string');
  assert.equal(captured.id.replace(/^0x/, '').length, 64); // 32-byte hex bucket id
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MockSealEncryptor, SealEncryptorImpl, isReal,
  parseSealServerConfigs, resolveSealThreshold,
} from '../src/seal/encryptor.ts';
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
  const s = new SealEncryptorImpl({ sealClient: stub, packageId: PKG, namespaceId: NS, threshold: 2, skipSelfCheck: true });
  assert.equal(isReal(s), true);
});

test('SealEncryptorImpl requires packageId', () => {
  const stub = {} as any;
  assert.throws(() => new SealEncryptorImpl({ sealClient: stub, packageId: '', namespaceId: NS, threshold: 2, skipSelfCheck: true }), /SEAL_PACKAGE_ID/);
});

test('SealEncryptorImpl.encrypt derives 32-byte bucket id (hex) + eventHash aad', async () => {
  let captured: any;
  const stub = { encrypt: async (a: any) => { captured = a; return { encryptedObject: new Uint8Array([9]), key: new Uint8Array() }; } } as any;
  const s = new SealEncryptorImpl({ sealClient: stub, packageId: PKG, namespaceId: NS, threshold: 2, skipSelfCheck: true });
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

// --- key-server config / threshold (GTM 3-independent ⇄ demo committee+independent) ---

test('parseSealServerConfigs rejects <2 servers (no single-server decrypt)', () => {
  // The whole point of threshold encryption: one compromised/colluding key
  // server must not be able to decrypt. 1 server violates that invariant.
  assert.throws(() => parseSealServerConfigs('0xaaa'), /at least 2/);
  assert.throws(() => parseSealServerConfigs(''), /at least 2/);
  assert.throws(() => parseSealServerConfigs(undefined), /at least 2/);
});

test('parseSealServerConfigs parses objectId@aggregatorUrl for committee mode', () => {
  const cfgs = parseSealServerConfigs('0xcommittee@https://agg.example,0xindep');
  assert.deepEqual(cfgs, [
    { objectId: '0xcommittee', weight: 1, aggregatorUrl: 'https://agg.example' },
    { objectId: '0xindep', weight: 1 }, // no aggregatorUrl key when independent
  ]);
});

test('parseSealServerConfigs splits on the FIRST @ (aggregatorUrl may contain @)', () => {
  const cfgs = parseSealServerConfigs('0xc@https://user:pw@agg.example/v1,0xindep');
  assert.deepEqual(cfgs[0], { objectId: '0xc', weight: 1, aggregatorUrl: 'https://user:pw@agg.example/v1' });
  assert.throws(() => parseSealServerConfigs('0xc@,0xindep'), /empty aggregatorUrl/);
});

test('resolveSealThreshold defaults to 2-of-N for ≥3 (GTM) and n for fewer (demo)', () => {
  assert.equal(resolveSealThreshold(3, undefined), 2); // GTM 2-of-3
  assert.equal(resolveSealThreshold(5, undefined), 2);
  assert.equal(resolveSealThreshold(2, undefined), 2); // demo committee+independent = require both
});

test('resolveSealThreshold honors SEAL_THRESHOLD but fails loud outside [2,n]', () => {
  assert.equal(resolveSealThreshold(3, '3'), 3);
  assert.throws(() => resolveSealThreshold(2, '3'), /\[2, 2\]/); // > server count
  assert.throws(() => resolveSealThreshold(3, '0'), /\[2, 3\]/);
  assert.throws(() => resolveSealThreshold(3, '1.5'), /integer/);
});

test('resolveSealThreshold rejects SEAL_THRESHOLD=1 (no single-server decrypt)', () => {
  // A threshold of 1 lets any one key server decrypt alone — defeats the
  // whole point of threshold encryption. Must fail loud even though 1 ≤ n.
  assert.throws(() => resolveSealThreshold(3, '1'), /\[2, 3\]/);
  assert.throws(() => resolveSealThreshold(2, '1'), /\[2, 2\]/);
});

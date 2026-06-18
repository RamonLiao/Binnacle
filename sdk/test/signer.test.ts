import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { signerFromEnv } from '../src/client/signer.ts';

const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
const VALID_KEY = kp.getSecretKey();          // 'suiprivkey1...'
const EXPECTED_ADDR = kp.toSuiAddress();

test('decodes a valid suiprivkey to the correct address', () => {
  const signer = signerFromEnv({ SUI_PRIVATE_KEY: VALID_KEY } as NodeJS.ProcessEnv);
  assert.equal(signer.toSuiAddress(), EXPECTED_ADDR);
});

test('throws when SUI_PRIVATE_KEY is missing', () => {
  assert.throws(() => signerFromEnv({} as NodeJS.ProcessEnv), /SUI_PRIVATE_KEY/);
});

test('throws on a non-bech32 / malformed key', () => {
  assert.throws(() => signerFromEnv({ SUI_PRIVATE_KEY: 'not-a-key' } as NodeJS.ProcessEnv));
});

test('error never echoes the raw key value (no partial-key leak)', () => {
  const secret = 'suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz';
  try {
    signerFromEnv({ SUI_PRIVATE_KEY: secret } as NodeJS.ProcessEnv);
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(!(e as Error).message.includes(secret), 'message must not contain the key');
  }
});

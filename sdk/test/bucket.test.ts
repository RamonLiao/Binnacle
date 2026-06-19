import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketId } from '../src/seal/bucket.ts';

const NS = '0x' + '11'.repeat(32);
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

// Golden vectors emitted by `move/tests/golden_vectors.move::emit_bucket_vectors`
// (sui move test, commit 7c7f675). Conformance lock — Move is authoritative.
const EXPECTED_A = 'b81a2c81b95616581098af087749bac0dab6d81a31a76d4a39be64c54e230b58'; // ts=1_700_000_000_000, "login"
const EXPECTED_C = '2260261550b2ce5fab0f2ce0de125d6550843f1bc1b3a8c1aa71a1834d9735cc'; // NUL-prefixed "\x00login"
const EXPECTED_D = '7bc43247aecb64f946ee82d9b4407b991a280a3cf96c6c0b9eaa1f848bf2d322'; // empty type
const EXPECTED_E = '3b53dd7a609c45f35e15fb18abfb9db15f5d68ad298bd53839169278e27c845a'; // "登入"

test('bucketId matches Move golden vector — login', () => {
  assert.equal(hex(bucketId(NS, 1_700_000_000_000, 'login')), EXPECTED_A);
});
test('bucketId matches Move — NUL-prefixed type', () => {
  assert.equal(hex(bucketId(NS, 1_700_000_000_000, '\x00login')), EXPECTED_C);
});
test('bucketId matches Move — empty type', () => {
  assert.equal(hex(bucketId(NS, 1_700_000_000_000, '')), EXPECTED_D);
});
test('bucketId matches Move — multibyte UTF-8', () => {
  assert.equal(hex(bucketId(NS, 1_700_000_000_000, '登入')), EXPECTED_E);
});
test('bucketId rejects non-32-byte namespaceId', () => {
  assert.throws(() => bucketId('0x1234', 1_700_000_000_000, 'login'), /32 bytes/);
});
test('bucketId rejects non-integer tsMs', () => {
  assert.throws(() => bucketId(NS, 1.5, 'login'), /integer/);
});

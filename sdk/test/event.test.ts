import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeEvent, eventHash } from '../src/core/event.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const ev = (over: Partial<ComplianceEvent> = {}): ComplianceEvent => ({
  v: 1, ns: '0xabc', run_id: '0x' + '12'.repeat(32), seq: 0, ts_ms: 1_748_000_000_000,
  type: 'tool_call',
  agent: { model: 'm', version: '1', prompt_hash: '0x00' },
  input_hash: '0x01', output_hash: '0x02', payload: { a: 1 },
  prev_event_hash: '0x' + '00'.repeat(32), ...over,
});

test('encodeEvent is deterministic regardless of key insertion order', () => {
  const a = encodeEvent(ev());
  const reordered = JSON.parse(JSON.stringify(ev()));
  const b = encodeEvent(reordered as ComplianceEvent);
  assert.deepEqual(a, b);
});

test('eventHash = sha256(encodeEvent)', () => {
  const e = ev();
  const expected = new Uint8Array(createHash('sha256').update(encodeEvent(e)).digest());
  assert.deepEqual(eventHash(e), expected);
});

test('eventHash is 32 bytes', () => {
  assert.equal(eventHash(ev()).length, 32);
});

test('changing any field changes the hash', () => {
  assert.notDeepEqual(eventHash(ev()), eventHash(ev({ seq: 1 })));
});

test('rejects non-integer seq (would encode as CBOR float, diverging from u64)', () => {
  assert.throws(() => encodeEvent(ev({ seq: 5.5 })), /integer/i);
});

test('rejects seq beyond u64', () => {
  assert.throws(() => encodeEvent(ev({ seq: 2n ** 64n })), /u64/i);
});

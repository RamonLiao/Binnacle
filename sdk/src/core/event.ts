import cbor from 'cbor';
import { createHash } from 'node:crypto';
import type { ComplianceEvent } from './types.ts';

/** Deterministic CBOR (sorted keys, shortest ints) of the event object. */
export function encodeEvent(e: ComplianceEvent): Uint8Array {
  // normalize seq to a CBOR-safe integer that the on-chain u64 domain can reproduce.
  // A non-integer would encode as a CBOR float and silently diverge from the contract.
  let seq: bigint;
  if (typeof e.seq === 'bigint') seq = e.seq;
  else if (Number.isInteger(e.seq)) seq = BigInt(e.seq);
  else throw new Error(`encodeEvent: seq must be an integer, got ${e.seq}`);
  if (seq < 0n) throw new Error('encodeEvent: seq must be >= 0');
  if (seq > 0xffff_ffff_ffff_ffffn) throw new Error(`encodeEvent: seq exceeds u64, got ${seq}`);
  const normalized = { ...e, seq: seq <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(seq) : seq };
  return new Uint8Array(cbor.encodeCanonical(normalized));
}

export function eventHash(e: ComplianceEvent): Uint8Array {
  return new Uint8Array(createHash('sha256').update(encodeEvent(e)).digest());
}

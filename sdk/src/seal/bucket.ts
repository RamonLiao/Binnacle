import { createHash } from 'node:crypto';
import { fromHex } from '@mysten/sui/utils';

const DOMAIN = new TextEncoder().encode('compliance_vault::seal_bucket::v1');
const MS_PER_DAY = 86_400_000n;

/** little-endian u64 (mirrors Move bcs::to_bytes(&u64)). */
function leU64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/**
 * Per-(namespace, epoch_day, event_type) Seal IBE bucket id. Byte-for-byte
 * mirror of `seal_policy.move::bucket_id` (conformance-locked — do not change
 * the encoding without re-emitting the Move golden vectors).
 */
export function bucketId(namespaceId: string, tsMs: number | bigint, eventType: string): Uint8Array {
  const ns = fromHex(namespaceId);
  if (ns.length !== 32) throw new Error(`namespaceId must be 32 bytes, got ${ns.length}`);
  if (typeof tsMs === 'number' && !Number.isInteger(tsMs)) throw new Error(`tsMs must be an integer, got ${tsMs}`);
  const ts = BigInt(tsMs);
  if (ts < 0n) throw new Error('tsMs must be >= 0');
  const day = ts / MS_PER_DAY;
  const type = new TextEncoder().encode(eventType);
  const h = createHash('sha256');
  h.update(leU64(BigInt(DOMAIN.length)));
  h.update(DOMAIN);
  h.update(ns);
  h.update(leU64(day));
  h.update(leU64(BigInt(type.length)));
  h.update(type);
  return new Uint8Array(h.digest());
}

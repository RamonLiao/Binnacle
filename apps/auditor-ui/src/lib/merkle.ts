import { bcs } from '@mysten/sui/bcs';

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // @ts-expect-error BufferSource type mismatch in standard lib
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer);
}

export async function leafHash(seq: number | string, eventHash: Uint8Array): Promise<Uint8Array> {
  const seqBytes = bcs.u64().serialize(seq).toBytes();
  const data = new Uint8Array(1 + seqBytes.length + eventHash.length);
  data[0] = 0x00;
  data.set(seqBytes, 1);
  data.set(eventHash, 1 + seqBytes.length);
  return sha256(data);
}

function minMax(a: Uint8Array, b: Uint8Array): [Uint8Array, Uint8Array] {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return [a, b];
    if (a[i] > b[i]) return [b, a];
  }
  return [a, b];
}

export async function internalHash(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const [min, max] = minMax(a, b);
  const data = new Uint8Array(1 + min.length + max.length);
  data[0] = 0x01;
  data.set(min, 1);
  data.set(max, 1 + min.length);
  return sha256(data);
}

export async function verifyMerkleProof(
  root: Uint8Array,
  seq: number | string,
  eventHash: Uint8Array,
  proof: Uint8Array[]
): Promise<boolean> {
  let current = await leafHash(seq, eventHash);
  for (const sibling of proof) {
    current = await internalHash(current, sibling);
  }
  if (current.length !== root.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== root[i]) return false;
  }
  return true;
}

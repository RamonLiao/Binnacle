import { bcs } from '@mysten/sui/bcs';
import { createHash } from 'node:crypto';
import type { MerkleLeaf, MerkleTree } from './types.ts';

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());

function toU64(seq: number | bigint): bigint {
  let v: bigint;
  if (typeof seq === 'bigint') v = seq;
  else if (Number.isInteger(seq)) v = BigInt(seq);
  else throw new Error(`seq must be an integer, got ${seq}`);
  if (v < 0n) throw new Error(`seq must be >= 0, got ${v}`);
  if (v > 0xffff_ffff_ffff_ffffn) throw new Error(`seq exceeds u64, got ${v}`);
  return v;
}

const u64le = (seq: number | bigint): Uint8Array => bcs.u64().serialize(toU64(seq)).toBytes();

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

/** bytewise lexicographic compare; assumes equal-length 32B inputs. */
function lte(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!, bv = b[i]!;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return true;
}

export function leafHash(seq: number | bigint, eventHash: Uint8Array): Uint8Array {
  return sha256(concat(new Uint8Array([0x00]), u64le(seq), eventHash));
}

export function internalHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = lte(a, b) ? [a, b] : [b, a];
  return sha256(concat(new Uint8Array([0x01]), lo, hi));
}

export function batchHash(parent: Uint8Array, root: Uint8Array, seqStart: bigint, seqEnd: bigint): Uint8Array {
  return sha256(concat(parent, root, u64le(seqStart), u64le(seqEnd)));
}

export function buildTree(leaves: MerkleLeaf[]): MerkleTree {
  if (leaves.length === 0) throw new Error('buildTree: at least one leaf required');

  const level0 = leaves.map((l) => leafHash(l.seq, l.eventHash));
  const seqIndex = new Map<string, number>();
  leaves.forEach((l, i) => seqIndex.set(toU64(l.seq).toString(), i));

  // levels[0] = leaves, levels[top] = [root].
  const levels: Uint8Array[][] = [level0];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) next.push(internalHash(prev[i]!, prev[i + 1]!));
      else next.push(prev[i]!); // promote unpaired tail unchanged
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1]![0]!;

  const proof = (seq: number | bigint): Uint8Array[] => {
    const key = toU64(seq).toString();
    const start = seqIndex.get(key);
    if (start === undefined) throw new Error(`proof: seq ${key} not in tree`);
    const out: Uint8Array[] = [];
    let idx = start;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const nodes = levels[lvl]!;
      const isRight = idx % 2 === 1;
      const sibIdx = isRight ? idx - 1 : idx + 1;
      if (sibIdx < nodes.length) out.push(nodes[sibIdx]!.slice()); // copy: caller can't mutate tree state; else promoted, no sibling
      idx = Math.floor(idx / 2);
    }
    return out;
  };

  return { root, proof };
}

export function verifyProof(
  root: Uint8Array, seq: number | bigint, eventHash: Uint8Array, proof: Uint8Array[],
): boolean {
  let cur = leafHash(seq, eventHash);
  for (const sib of proof) cur = internalHash(cur, sib);
  if (cur.length !== root.length) return false;
  for (let i = 0; i < cur.length; i++) if (cur[i] !== root[i]) return false;
  return true;
}

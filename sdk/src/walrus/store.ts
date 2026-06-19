import type { Signer } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { RetryableWalrusClientError } from '@mysten/walrus';
import { createHash } from 'node:crypto';

export interface WalrusStore {
  /** Upload one blob; returns the raw 32-byte blobId for on-chain anchoring. */
  upload(blob: Uint8Array): Promise<Uint8Array>;
}

const REAL: unique symbol = Symbol('compliance-vault/walrus-real');

export function isRealStore(x: unknown): boolean {
  return !!x && (x as Record<symbol, unknown>)[REAL] === REAL;
}

/** Minimal shape of a `walrus()`-extended client (avoids a hard type dep here). */
export interface WalrusWriteClient {
  walrus: {
    writeBlob(args: { blob: Uint8Array; deletable: boolean; epochs: number; signer: Signer }): Promise<{ blobId: string }>;
  };
}

/** Decode a Walrus base64url blobId to raw 32 bytes. */
export function decodeBlobId(blobId: string): Uint8Array {
  const b64 = blobId.replace(/-/g, '+').replace(/_/g, '/');
  const raw = fromBase64(b64);
  if (raw.length !== 32) {
    throw new Error(`Walrus blobId did not decode to 32 bytes (got ${raw.length}; value="${blobId}")`);
  }
  return raw;
}

export class RealWalrusStore implements WalrusStore {
  readonly [REAL] = REAL;
  constructor(
    private readonly client: WalrusWriteClient,
    private readonly signer: Signer,
    private readonly epochs: number,
  ) {}

  async upload(blob: Uint8Array): Promise<Uint8Array> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { blobId } = await this.client.walrus.writeBlob({ blob, deletable: false, epochs: this.epochs, signer: this.signer });
        return decodeBlobId(blobId);
      } catch (e) {
        lastErr = e;
        // RetryableWalrusClientError has many subclasses → use instanceof, not name.
        if (e instanceof RetryableWalrusClientError) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1) * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Walrus upload failed after 3 attempts: ${String(lastErr)}`);
  }
}

export class MockWalrusStore implements WalrusStore {
  async upload(blob: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHash('sha256').update(blob).digest()).slice(0, 32);
  }
}

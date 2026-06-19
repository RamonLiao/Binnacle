import type { SealClient } from '@mysten/seal';
import { toHex } from '@mysten/sui/utils';
import { bucketId } from './bucket.ts';
import { eventHash } from '../core/index.ts';
import type { ComplianceEvent } from '../core/types.ts';

export interface SealEncryptor {
  /** Seal-encrypt one event's CBOR; id derived from the event's (ts, type) scope bucket. */
  encrypt(plaintext: Uint8Array, ev: ComplianceEvent): Promise<Uint8Array>;
}

const REAL: unique symbol = Symbol('compliance-vault/seal-real');

/** Positive brand check — only real impls set REAL (red-team v0.2 F4). */
export function isReal(x: unknown): boolean {
  return !!x && (x as Record<symbol, unknown>)[REAL] === REAL;
}

export interface SealEncryptorOpts {
  sealClient: SealClient;
  /** ORIGINAL published compliance_vault package id (IBE domain). */
  packageId: string;
  /** 32-byte hex namespace id. */
  namespaceId: string;
  skipSelfCheck?: boolean;
}

export class SealEncryptorImpl implements SealEncryptor {
  readonly [REAL] = REAL;
  private readonly sealClient: SealClient;
  private readonly packageId: string;
  private readonly namespaceId: string;

  constructor(opts: SealEncryptorOpts) {
    if (!opts.packageId) throw new Error('SEAL_PACKAGE_ID (original package id) is required');
    if (!opts.namespaceId) throw new Error('namespaceId is required');
    this.sealClient = opts.sealClient;
    this.packageId = opts.packageId;
    this.namespaceId = opts.namespaceId;
    // The live constructor self-roundtrip (V3) needs key servers + an
    // EngagementObject, so it runs in scripts/prove-e2e.ts (§5). Offline unit
    // tests pass skipSelfCheck; this flag is accepted for that path.
    void opts.skipSelfCheck;
  }

  async encrypt(plaintext: Uint8Array, ev: ComplianceEvent): Promise<Uint8Array> {
    const bucket = bucketId(this.namespaceId, ev.ts_ms, ev.type);
    if (bucket.length !== 32) throw new Error(`bucket id must be 32 bytes, got ${bucket.length}`);
    const { encryptedObject } = await this.sealClient.encrypt({
      threshold: 2,
      packageId: this.packageId,
      id: toHex(bucket),
      aad: eventHash(ev),
      data: plaintext,
    });
    return encryptedObject;
  }
}

const MAGIC = 0x5a;

export class MockSealEncryptor implements SealEncryptor {
  async encrypt(plaintext: Uint8Array, _ev: ComplianceEvent): Promise<Uint8Array> {
    const out = new Uint8Array(plaintext.length + 1);
    out[0] = MAGIC;
    out.set(plaintext, 1);
    return out;
  }
}

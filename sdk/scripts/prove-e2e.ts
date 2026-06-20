/**
 * Stage C testnet e2e: real Seal encrypt + real Walrus upload + anchor.
 *
 * Prereq (.env): SEAL_PACKAGE_ID, SEAL_KEY_SERVER_IDS (3), NAMESPACE_ID,
 * WRITER_CAP_ID, ENGAGEMENT_ID, SUI_PRIVATE_KEY, WALRUS_EPOCHS.
 * The signer address MUST hold WAL (storage) + SUI (gas).
 *
 * Run: cd sdk && pnpm dlx tsx --env-file=.env scripts/prove-e2e.ts
 */
import { walrus } from '@mysten/walrus';
import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { toHex } from '@mysten/sui/utils';
import { signerFromEnv } from '../src/client/signer.ts';
import { AnchorClient } from '../src/client/anchorClient.ts';
import { BatchProver } from '../src/client/prover.ts';
import { sealEncryptorFromEnv, parseSealServerConfigs, resolveSealThreshold } from '../src/seal/encryptor.ts';
import { RealWalrusStore } from '../src/walrus/store.ts';
import { bucketId } from '../src/seal/bucket.ts';
import { encodeEvent, eventHash } from '../src/core/index.ts';
import { grpcClient, requireEnv, suiscan, PACKAGE_ID } from './_grpc.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const GENESIS = '0x' + '00'.repeat(32);
const hexOf = (u: Uint8Array) => '0x' + Buffer.from(u).toString('hex');

async function main() {
  const baseClient = grpcClient();
  // Route uploads through the testnet upload relay — direct client→storage-node
  // fan-out is unreliable on testnet ("Too many failures writing blob to nodes").
  // The relay charges a small WAL/SUI tip (const ~105 MIST); cap it via sendTip.max.
  const uploadRelayHost = process.env.WALRUS_UPLOAD_RELAY ?? 'https://upload-relay.testnet.walrus.space';
  const tipMax = Number(process.env.WALRUS_TIP_MAX ?? '1000000');
  if (!Number.isSafeInteger(tipMax) || tipMax < 0) {
    throw new Error(`WALRUS_TIP_MAX must be a non-negative safe integer (MIST), got "${process.env.WALRUS_TIP_MAX}"`);
  }
  const walrusClient = baseClient.$extend(
    walrus({ uploadRelay: { host: uploadRelayHost, sendTip: { max: tipMax } } }),
  );
  const signer = signerFromEnv();

  const namespaceId = requireEnv('NAMESPACE_ID');
  const writerCapId = requireEnv('WRITER_CAP_ID');
  const sealPackageId = requireEnv('SEAL_PACKAGE_ID');
  const engagementId = requireEnv('ENGAGEMENT_ID');
  const epochs = Number(process.env.WALRUS_EPOCHS ?? '3');

  // 2 chained synthetic events (seq 0,1; genesis parent).
  const now = Date.now();
  const mk = (seq: number, prev: string): ComplianceEvent => ({
    v: 1, ns: namespaceId, run_id: 'e2e', seq, ts_ms: now + seq, type: 'login',
    agent: { model: 'demo', version: '1', prompt_hash: '0x00' },
    input_hash: '0x00', output_hash: '0x00', payload: { seq }, prev_event_hash: prev,
  });
  const e0 = mk(0, GENESIS);
  const e1 = mk(1, hexOf(eventHash(e0)));
  const events = [e0, e1];

  // ── MANDATORY id-binding self-check BEFORE anchoring real blobs (red-team V3) ──
  const serverConfigs = parseSealServerConfigs(requireEnv('SEAL_KEY_SERVER_IDS'));
  const threshold = resolveSealThreshold(serverConfigs.length, process.env.SEAL_THRESHOLD);
  const sealClient = new SealClient({ suiClient: baseClient, serverConfigs, verifyKeyServers: true });
  const probeBucket = bucketId(namespaceId, e0.ts_ms, e0.type);
  const { encryptedObject } = await sealClient.encrypt({
    threshold, packageId: sealPackageId, id: toHex(probeBucket), aad: eventHash(e0), data: encodeEvent(e0),
  });
  const sessionKey = await SessionKey.create({ address: signer.toSuiAddress(), packageId: sealPackageId, ttlMin: 10, signer, suiClient: baseClient });
  // Encrypt under the ORIGINAL package id (Seal IBE domain — requires first
  // version), but call seal_approve at the LATEST package id so the upgraded
  // (per-(day,type) bucket) policy code runs. After an upgrade these differ.
  const policyPackageId = process.env.SEAL_POLICY_PACKAGE_ID ?? PACKAGE_ID;
  const approveTx = new Transaction();
  approveTx.moveCall({
    target: `${policyPackageId}::seal_policy::seal_approve`,
    arguments: [
      approveTx.pure.vector('u8', Array.from(probeBucket)),
      approveTx.object(engagementId),
      approveTx.pure.string(e0.type),
      approveTx.pure.u64(BigInt(e0.ts_ms)),
      approveTx.object('0x6'),
    ],
  });
  const txBytes = await approveTx.build({ client: baseClient, onlyTransactionKind: true });
  const plaintext = await sealClient.decrypt({ data: encryptedObject, sessionKey, txBytes });
  const okPlaintext = Buffer.compare(Buffer.from(plaintext), Buffer.from(encodeEvent(e0))) === 0;
  if (!okPlaintext) throw new Error('id-binding self-check FAILED — decrypted plaintext != event CBOR; aborting before anchoring');
  console.log('✅ id-binding self-check passed (bucket id decrypts; eventHash leaf reproducible)');

  // ── real prove ──
  const seal = sealEncryptorFromEnv({ suiClient: baseClient, namespaceId });
  const store = new RealWalrusStore(walrusClient as never, signer, epochs);
  const anchor = new AnchorClient(baseClient, signer);
  const prover = new BatchProver(seal, store, anchor);

  const res = await prover.proveBatch(
    {
      events, runId: new Uint8Array(32).fill(0xe2), parentBatchHash: new Uint8Array(0),
      packageId: PACKAGE_ID, namespaceId, writerCapId,
    },
    process.env.MAX_EVENT_BYTES ? { maxEventBytes: Number(process.env.MAX_EVENT_BYTES) } : undefined,
  );
  console.log('blobIds:', res.blobIds.map((b) => toHex(b)));
  console.log('anchor digest:', res.digest);
  console.log('suiscan:', suiscan(res.digest));
}

main().catch((e) => { console.error(e); process.exit(1); });

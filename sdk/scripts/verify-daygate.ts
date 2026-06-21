/**
 * Targeted testnet proof that the v3 seal_approve DAY-COVERAGE gate is LIVE.
 *
 * Discriminating pair (one run, same ts/type/auditor — only scope width differs):
 *   - SUB-DAY grant [day_start+6h, day_start+18h], probe ts = noon (INSIDE window).
 *     Old per-request gate (requested_ts in [start,end]) would ALLOW.
 *     v3 day-coverage gate (day_start..day_end must be inside grant) DENIES.
 *     → decrypt MUST be DENIED. Uniquely attributable to the day-gate: id matches,
 *       not revoked/expired, sender matches, empty type-filter ⇒ only the
 *       day-coverage assert can fire.
 *   - FULL-DAY grant [day_start, day_end], same probe ts/type.
 *     → decrypt MUST SUCCEED (positive control: keyservers/network healthy, so
 *       the sub-day throw above is genuinely the policy, not a transport error).
 *
 * Mints 2 fresh engagements (gas only; no Walrus/anchor). Needs (.env):
 *   SUI_PRIVATE_KEY (owns ADMIN_CAP for NAMESPACE_ID), NAMESPACE_ID, ADMIN_CAP_ID,
 *   SEAL_PACKAGE_ID (encrypt domain = original), SEAL_KEY_SERVER_IDS, SEAL_THRESHOLD,
 *   PACKAGE_ID (v3, seal_approve target), optional SEAL_POLICY_PACKAGE_ID.
 *
 * Run: cd sdk && pnpm dlx tsx --env-file=.env scripts/verify-daygate.ts
 */
import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { toHex } from '@mysten/sui/utils';
import { signerFromEnv } from '../src/client/signer.ts';
import { parseSealServerConfigs, resolveSealThreshold } from '../src/seal/encryptor.ts';
import { bucketId } from '../src/seal/bucket.ts';
import { encodeEvent, eventHash } from '../src/core/index.ts';
import { grpcClient, requireEnv, suiscan, PACKAGE_ID } from './_grpc.ts';
import type { ComplianceEvent } from '../src/core/types.ts';

const MS_PER_DAY = 86_400_000;
const FAR_FUTURE = 4102444800000n; // 2100-01-01

async function mintEngagement(
  client: ReturnType<typeof grpcClient>,
  signer: ReturnType<typeof signerFromEnv>,
  namespaceId: string,
  adminCapId: string,
  scopeStart: bigint,
  scopeEnd: bigint,
): Promise<string> {
  const sender = signer.toSuiAddress();
  // Both mints reuse the same owned AdminCap; tx N bumps its lamport version, but
  // the fullnode's gRPC read path lags (lesson 2026-06-19) → tx N+1 builds against
  // a stale version and aborts pre-exec. Rebuild a FRESH tx each attempt (a built
  // Transaction caches resolved object versions) until the new version is indexed.
  let result;
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::engagement::mint_engagement`,
      arguments: [
        tx.object(namespaceId),
        tx.object(adminCapId),
        tx.pure.address(sender),
        tx.pure.vector('u8', []),
        tx.pure.u64(scopeStart),
        tx.pure.u64(scopeEnd),
        tx.pure.vector('string', []), // empty filter = all types
        tx.pure.u64(FAR_FUTURE),      // expiry far future
        tx.object('0x6'),
      ],
    });
    tx.setSender(sender);
    try {
      result = await signer.signAndExecuteTransaction({ transaction: tx, client });
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 6 && /unavailable for consumption|needs to be rebuilt/i.test(decodeURIComponent(msg))) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw e;
    }
  }
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`mint failed pre-exec: ${JSON.stringify(result.FailedTransaction)}`);
  }
  const { digest, effects } = result.Transaction;
  if (!effects.status.success) throw new Error(`mint aborted: ${JSON.stringify(effects.status.error)}`);
  const shared = effects.changedObjects
    .filter((c) => c.inputState === 'DoesNotExist')
    .find((c) => c.outputOwner?.$kind === 'Shared');
  if (!shared) throw new Error(`no shared EngagementObject in effects of ${digest}`);
  return shared.objectId;
}

/** Try to decrypt the probe event under `engagementId`. Resolves true if the
 *  key share was released (allowed), false if seal_approve denied it. */
async function tryDecrypt(
  baseClient: ReturnType<typeof grpcClient>,
  sealClient: SealClient,
  sessionKey: SessionKey,
  policyPackageId: string,
  engagementId: string,
  probeBucket: Uint8Array,
  event: ComplianceEvent,
  encryptedObject: Uint8Array,
): Promise<boolean> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${policyPackageId}::seal_policy::seal_approve`,
    arguments: [
      tx.pure.vector('u8', Array.from(probeBucket)),
      tx.object(engagementId),
      tx.pure.string(event.type),
      tx.pure.u64(BigInt(event.ts_ms)),
      tx.object('0x6'),
    ],
  });
  const txBytes = await tx.build({ client: baseClient, onlyTransactionKind: true });
  try {
    const plaintext = await sealClient.decrypt({ data: encryptedObject, sessionKey, txBytes });
    const ok = Buffer.compare(Buffer.from(plaintext), Buffer.from(encodeEvent(event))) === 0;
    if (!ok) throw new Error('decrypt returned but plaintext != event CBOR (unexpected)');
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Seal raises a no-access / dry-run-abort error when seal_approve aborts.
    console.log(`   (denied — ${msg})`);
    return false;
  }
}

async function main() {
  const baseClient = grpcClient();
  const signer = signerFromEnv();
  const namespaceId = requireEnv('NAMESPACE_ID');
  const adminCapId = requireEnv('ADMIN_CAP_ID');
  const sealPackageId = requireEnv('SEAL_PACKAGE_ID');     // encrypt domain (original)
  const policyPackageId = process.env.SEAL_POLICY_PACKAGE_ID ?? PACKAGE_ID; // v3 target

  // Probe ts = noon of today's epoch_day; sub-day window straddles it but does
  // NOT cover the full day → discriminates v3 (deny) from v2 (allow).
  const dayStart = BigInt(Math.floor(Date.now() / MS_PER_DAY)) * BigInt(MS_PER_DAY);
  const dayEnd = dayStart + BigInt(MS_PER_DAY) - 1n;
  const probeTs = dayStart + BigInt(MS_PER_DAY) / 2n; // noon, inside sub-day window
  const subStart = dayStart + 6n * 3_600_000n;
  const subEnd = dayStart + 18n * 3_600_000n;

  const event: ComplianceEvent = {
    v: 1, ns: namespaceId, run_id: 'daygate-verify', seq: 0, ts_ms: Number(probeTs),
    type: 'login', agent: { model: 'demo', version: '1', prompt_hash: '0x00' },
    input_hash: '0x00', output_hash: '0x00', payload: {}, prev_event_hash: '0x' + '00'.repeat(32),
  };

  // Encrypt once under the day-grained bucket for (ns, probeTs, type).
  const serverConfigs = parseSealServerConfigs(requireEnv('SEAL_KEY_SERVER_IDS'));
  const threshold = resolveSealThreshold(serverConfigs.length, process.env.SEAL_THRESHOLD);
  const sealClient = new SealClient({ suiClient: baseClient, serverConfigs, verifyKeyServers: true });
  const probeBucket = bucketId(namespaceId, event.ts_ms, event.type);
  const { encryptedObject } = await sealClient.encrypt({
    threshold, packageId: sealPackageId, id: toHex(probeBucket), aad: eventHash(event), data: encodeEvent(event),
  });
  const sessionKey = await SessionKey.create({
    address: signer.toSuiAddress(), packageId: sealPackageId, ttlMin: 10, signer, suiClient: baseClient,
  });

  console.log(`probe ts=${probeTs} (day ${dayStart}..${dayEnd})`);
  console.log('minting sub-day grant', `[${subStart}, ${subEnd}]`, '…');
  const subEng = await mintEngagement(baseClient, signer, namespaceId, adminCapId, subStart, subEnd);
  console.log('  →', suiscan(subEng), `\n  ENG_SUB=${subEng}`);
  console.log('minting full-day grant', `[${dayStart}, ${dayEnd}]`, '…');
  const fullEng = await mintEngagement(baseClient, signer, namespaceId, adminCapId, dayStart, dayEnd);
  console.log('  →', suiscan(fullEng), `\n  ENG_FULL=${fullEng}`);

  console.log('\n[1/2] sub-day grant decrypt (expect DENIED) …');
  const subAllowed = await tryDecrypt(baseClient, sealClient, sessionKey, policyPackageId, subEng, probeBucket, event, encryptedObject);
  console.log('\n[2/2] full-day grant decrypt (expect ALLOWED) …');
  const fullAllowed = await tryDecrypt(baseClient, sealClient, sessionKey, policyPackageId, fullEng, probeBucket, event, encryptedObject);

  console.log('\n──────── RESULT ────────');
  console.log(`sub-day  → ${subAllowed ? 'ALLOWED' : 'DENIED'} (want DENIED)`);
  console.log(`full-day → ${fullAllowed ? 'ALLOWED' : 'DENIED'} (want ALLOWED)`);
  if (subAllowed) {
    throw new Error('FAIL: sub-day grant decrypted — day-gate NOT live (running stale v2 bytecode?)');
  }
  if (!fullAllowed) {
    throw new Error('INCONCLUSIVE: full-day control was denied too — transport/keyserver issue, not the gate');
  }
  console.log('✅ v3 day-coverage gate CONFIRMED LIVE on testnet: sub-day denied, full-day allowed.');
}

main().catch((e) => { console.error('❌', e instanceof Error ? e.message : e); process.exit(1); });

/**
 * One-shot: mint a wide-scope EngagementObject for the Stage C prove-e2e
 * id-binding self-check. Prints ENGAGEMENT_ID to paste into sdk/.env.
 *
 * Scope is deliberately permissive (start=0, end/expiry=year 2100, empty
 * event_type_filter=all types, auditor_addr=signer) so the self-check's
 * Date.now()/'login' probe always falls inside scope and the id is reusable.
 *
 * Needs (.env): SUI_PRIVATE_KEY, NAMESPACE_ID. Signer must own the AdminCap
 * minted by bootstrap-namespace.ts.
 *
 * Run: cd sdk && pnpm dlx tsx --env-file=.env scripts/mint-engagement.ts
 */
import { Transaction } from '@mysten/sui/transactions';
import { signerFromEnv } from '../src/client/signer.ts';
import { PACKAGE_ID, grpcClient, requireEnv, suiscan } from './_grpc.ts';

const FAR_FUTURE = 4102444800000n; // 2100-01-01, well past any Date.now() probe

async function main() {
  const signer = signerFromEnv();
  const client = grpcClient();
  const sender = signer.toSuiAddress();
  const namespaceId = requireEnv('NAMESPACE_ID');

  // Prefer an explicit ADMIN_CAP_ID (printed by bootstrap) — the signer may own
  // several AdminCaps across namespaces and mint_engagement::assert_admin only
  // accepts the one whose namespace_id matches NAMESPACE_ID.
  let adminCapObjectId = process.env.ADMIN_CAP_ID;
  if (!adminCapObjectId) {
    const { objects } = await client.core.listOwnedObjects({
      owner: sender,
      type: `${PACKAGE_ID}::namespace::AdminCap`,
    });
    if (objects.length === 0) {
      throw new Error(`signer ${sender} owns no ${PACKAGE_ID}::namespace::AdminCap — run bootstrap-namespace.ts first`);
    }
    if (objects.length > 1) {
      throw new Error(
        `signer owns ${objects.length} AdminCaps — set ADMIN_CAP_ID in .env to the one for NAMESPACE_ID (bootstrap prints it)`,
      );
    }
    adminCapObjectId = objects[0]!.objectId;
  }
  const adminCap = { objectId: adminCapObjectId };

  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::engagement::mint_engagement`,
    arguments: [
      tx.object(namespaceId),            // &AgentNamespace (shared, gRPC auto-resolves)
      tx.object(adminCap.objectId),      // &AdminCap
      tx.pure.address(sender),           // auditor_addr = signer (B3 field auth)
      tx.pure.vector('u8', []),          // auditor_pubkey (unused by seal_approve)
      tx.pure.u64(0n),                   // scope_start_ms
      tx.pure.u64(FAR_FUTURE),           // scope_end_ms
      tx.pure.vector('string', []),      // event_type_filter = all types
      tx.pure.u64(FAR_FUTURE),           // expires_at_ms
      tx.object('0x6'),                  // Clock
    ],
  });
  tx.setSender(sender);

  const result = await signer.signAndExecuteTransaction({ transaction: tx, client });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`mint tx failed pre-execution: ${JSON.stringify(result.FailedTransaction)}`);
  }
  const { digest, effects } = result.Transaction;
  if (!effects.status.success) {
    throw new Error(`mint aborted on-chain: ${JSON.stringify(effects.status.error)}`);
  }

  // mint_engagement shares the EngagementObject → the only newly-created Shared object.
  const created = effects.changedObjects.filter((c) => c.inputState === 'DoesNotExist');
  const shared = created.find((c) => c.outputOwner?.$kind === 'Shared');
  if (!shared) {
    throw new Error(`no shared EngagementObject in effects: ${JSON.stringify(created)}`);
  }

  console.log(`✅ engagement minted: ${suiscan(digest)}`);
  console.log('\nPaste into sdk/.env:');
  console.log(`ENGAGEMENT_ID=${shared.objectId}`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});

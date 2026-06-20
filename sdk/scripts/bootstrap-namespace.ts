import { Transaction } from '@mysten/sui/transactions';
import { signerFromEnv } from '../src/client/signer.ts';
import { PACKAGE_ID, grpcClient, suiscan } from './_grpc.ts';

async function main() {
  const signer = signerFromEnv();
  const client = grpcClient();
  const sender = signer.toSuiAddress();

  const tx = new Transaction();
  // policy::new_policy(retention_epochs, encryption_mode, seal_threshold: Option<SealConfig>, auditor_allowlist)
  const seal = tx.moveCall({
    target: '0x1::option::none',
    typeArguments: [`${PACKAGE_ID}::policy::SealConfig`],
  });
  const allowlist = tx.makeMoveVec({ type: 'address', elements: [] });
  const policy = tx.moveCall({
    target: `${PACKAGE_ID}::policy::new_policy`,
    arguments: [tx.pure.u64(0n), tx.pure.u8(0), seal, allowlist], // enc_none() == 0
  });
  // namespace::create_namespace(agent_id, policy) -> (AdminCap, WriterCap); shares ns internally
  const caps = tx.moveCall({
    target: `${PACKAGE_ID}::namespace::create_namespace`,
    arguments: [tx.pure.string('e2e-agent'), policy],
  });
  tx.transferObjects([caps[0]!, caps[1]!], sender);
  tx.setSender(sender);

  const result = await signer.signAndExecuteTransaction({ transaction: tx, client });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`bootstrap tx failed pre-execution: ${JSON.stringify(result.FailedTransaction)}`);
  }
  const { digest, effects } = result.Transaction;
  if (!effects.status.success) {
    throw new Error(`bootstrap aborted on-chain: ${JSON.stringify(effects.status.error)}`);
  }

  // created = inputState 'DoesNotExist'. AgentNamespace is the only Shared one; caps are AddressOwner.
  const created = effects.changedObjects.filter((c) => c.inputState === 'DoesNotExist');
  const sharedObj = created.find((c) => c.outputOwner?.$kind === 'Shared');
  if (!sharedObj || sharedObj.outputOwner?.$kind !== 'Shared') {
    throw new Error(`no shared AgentNamespace in effects: ${JSON.stringify(created)}`);
  }
  const namespaceId = sharedObj.objectId;
  const initVersion = sharedObj.outputOwner.Shared.initialSharedVersion;

  // distinguish WriterCap from AdminCap (both AddressOwner) by Move type
  const ownedIds = created
    .filter((c) => c.outputOwner?.$kind === 'AddressOwner')
    .map((c) => c.objectId);
  let writerCapId: string | undefined;
  let adminCapId: string | undefined;
  for (const id of ownedIds) {
    const { object } = await client.core.getObject({ objectId: id, include: {} });
    if (object.type.endsWith('::namespace::WriterCap')) writerCapId = id;
    if (object.type.endsWith('::namespace::AdminCap')) adminCapId = id;
  }
  if (!writerCapId) {
    throw new Error(`no WriterCap among created owned objects: ${JSON.stringify(ownedIds)}`);
  }
  if (!adminCapId) {
    throw new Error(`no AdminCap among created owned objects: ${JSON.stringify(ownedIds)}`);
  }

  console.log(`✅ bootstrap finalized: ${suiscan(digest)}`);
  console.log('\nPaste into sdk/.env:');
  console.log(`NAMESPACE_ID=${namespaceId}`);
  console.log(`WRITER_CAP_ID=${writerCapId}`);
  console.log(`ADMIN_CAP_ID=${adminCapId}`);
  console.log(`NAMESPACE_INIT_VERSION=${initVersion}`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});

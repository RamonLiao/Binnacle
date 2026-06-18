import { SealClient } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { suiClient } from './sui';
import { PACKAGE_ID } from './contract';

const KEY_SERVERS = (process.env.NEXT_PUBLIC_SEAL_KEY_SERVERS || '').split(',').filter(Boolean);

export const sealClient = new SealClient({
  suiClient,
  serverConfigs: KEY_SERVERS.map(id => ({ objectId: id, weight: 1 })),
});

export function createGatePTB(
  namespaceIdBytes: Uint8Array,
  engagementId: string,
  eventType: string,
  tsMs: number,
) {
  const tx = new Transaction();
  
  tx.moveCall({
    target: `${PACKAGE_ID}::seal_policy::seal_approve`,
    arguments: [
      tx.pure.vector('u8', Array.from(namespaceIdBytes)),
      tx.object(engagementId),
      tx.pure.string(eventType),
      tx.pure.u64(tsMs),
      tx.object('0x6'),
    ]
  });

  return tx;
}

export function parseSealAbort(error: unknown): string {
  const msg = (error as Error)?.message || String(error);
  if (msg.includes('8')) return "Outside your scope/type filter or wrong identity";
  if (msg.includes('6')) return "Engagement expired";
  if (msg.includes('7')) return "Engagement revoked";
  return "Access denied: " + msg;
}

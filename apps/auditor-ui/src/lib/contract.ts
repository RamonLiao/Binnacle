import { suiClient } from './sui';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID as string;

// Assuming simple generic object fetcher for the UI
export async function getObject(objectId: string) {
  return suiClient.getObject({
    id: objectId,
    options: { showContent: true, showOwner: true },
  });
}

// DevInspect verification of event inclusion
export async function verifyEventInclusion(
  receiptId: string,
  seq: number,
  eventHash: Uint8Array,
  merkleProof: Uint8Array[]
) {
  const tx = new Transaction();
  
  tx.moveCall({
    target: `${PACKAGE_ID}::receipt::verify_event_inclusion`,
    arguments: [
      tx.object(receiptId),
      tx.pure.u64(seq),
      tx.pure(bcs.vector(bcs.u8()).serialize(eventHash)),
      tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(merkleProof)),
    ],
  });

  const res = await suiClient.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
  });

  // Extract the boolean return value from devInspect results
  const returnValues = res.results?.[0]?.returnValues;
  if (!returnValues || returnValues.length === 0) return false;
  
  const [data] = returnValues[0];
  return data[0] === 1; // bcs bool
}

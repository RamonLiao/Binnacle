const WALRUS_AGGREGATOR = process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR;

export async function fetchBlobBytes(blobId: string): Promise<Uint8Array> {
  const res = await fetch(`${WALRUS_AGGREGATOR}/v1/${blobId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch blob ${blobId} from Walrus`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL;

export interface Engagement {
  engagementId: string;
  namespaceId: string;
  agentId: string;
  auditorAddr: string;
  auditorPubkey: string;
  scopeStartMs: number;
  scopeEndMs: number;
  eventTypeFilter: string[];
  expiresAtMs: number;
  revoked: boolean;
  mintedAtMs: number;
}

export interface Namespace {
  namespaceId: string;
  agentId: string;
  owner: string;
  seqNext: number;
  batchIndex: number;
  lastBatchHash: string;
  sealed: boolean;
  batchCount: number;
  lastAnchorMs: number;
}

export interface Batch {
  batchId: string;
  namespaceId: string;
  runId: string;
  seqStart: number;
  seqEnd: number;
  merkleRoot: string;
  batchHash: string;
  parentBatchHash: string;
  blobIds: string[];
  anchoredAtMs: number;
}

export async function getEngagements(auditor: string): Promise<Engagement[]> {
  try {
    const res = await fetch(`${INDEXER_URL}/engagements?auditor=${auditor}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function getNamespace(namespaceId: string): Promise<Namespace | null> {
  try {
    const res = await fetch(`${INDEXER_URL}/namespaces/${namespaceId}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getBatches(namespaceId: string): Promise<{ items: Batch[], nextCursor?: string } | null> {
  try {
    const res = await fetch(`${INDEXER_URL}/namespaces/${namespaceId}/batches`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getBatch(batchId: string): Promise<Batch | null> {
  try {
    const res = await fetch(`${INDEXER_URL}/batches/${batchId}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getCoverage(namespaceId: string) {
  try {
    const res = await fetch(`${INDEXER_URL}/namespaces/${namespaceId}/coverage`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getAttestations(engagementId: string) {
  try {
    const res = await fetch(`${INDEXER_URL}/attestations?engagementId=${engagementId}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

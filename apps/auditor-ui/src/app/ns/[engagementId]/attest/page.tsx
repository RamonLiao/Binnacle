"use client";

import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { grpcClient } from '@/lib/sui';
import { getEngagements, getBatches } from '@/lib/indexer';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, FileSignature, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { PACKAGE_ID } from '@/lib/contract';

export default function AttestPage() {
  const account = useCurrentAccount();
  const address = account?.address;
  // gRPC execute override: dapp-kit hands us base64 `bytes` + `signature`; the gRPC
  // core API wants raw bytes + a signatures array and returns a tagged TransactionResult.
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) => {
      const result = await grpcClient.core.executeTransaction({
        transaction: fromBase64(bytes),
        signatures: [signature],
      });
      if (result.$kind === 'FailedTransaction') {
        throw new Error(`Transaction failed: ${result.FailedTransaction.digest}`);
      }
      return { digest: result.Transaction.digest };
    },
  });
  const { engagementId } = useParams();
  const router = useRouter();

  const { data: engagements } = useQuery({
    queryKey: ['engagements', address],
    queryFn: () => getEngagements(address as string),
    enabled: !!address,
  });

  const engagement = engagements?.find(e => e.engagementId === engagementId);
  const namespaceId = engagement?.namespaceId;

  const { data: batchesRes } = useQuery({
    queryKey: ['batches', namespaceId],
    queryFn: () => getBatches(namespaceId as string),
    enabled: !!namespaceId,
  });

  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set());
  const [reportText, setReportText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successId, setSuccessId] = useState<string | null>(null);

  if (!engagement) return <div className="p-4">Access denied.</div>;

  const batches = batchesRes?.items || [];
  const isRevokedOrExpired = engagement.revoked || engagement.expiresAtMs < Date.now();

  const toggleBatch = (id: string) => {
    const next = new Set(selectedBatches);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedBatches(next);
  };

  const handleAttest = async () => {
    if (!address) {
      alert('Please sign in first.');
      return;
    }
    // Walrus upload is still mocked, so blobId/hash below are fabricated. The
    // file_attestation tx is REAL and PERMANENT — refuse to anchor garbage
    // commitments unless explicitly opted in for a demo. Fail loud otherwise.
    if (process.env.NEXT_PUBLIC_ALLOW_MOCK_ATTEST !== 'true') {
      alert(
        'Attestation blocked: report blobId/hash are still mocked (Walrus upload not wired). ' +
        'Filing now would anchor fake commitments on-chain permanently. ' +
        'Set NEXT_PUBLIC_ALLOW_MOCK_ATTEST=true to allow a demo submission.'
      );
      return;
    }
    setIsSubmitting(true);
    try {
      // DEMO: Walrus upload is mocked, so these commitments are fabricated.
      const reportBlobIdBytes = Array(32).fill(1); // fake blob ID
      const reportHashBytes = Array(32).fill(2); // fake hash

      const tx = new Transaction();
      tx.setSender(address);
      tx.moveCall({
        target: `${PACKAGE_ID}::attestation::file_attestation`,
        arguments: [
          tx.object(engagement.engagementId),
          tx.pure.vector('u8', reportBlobIdBytes),
          tx.pure.vector('u8', reportHashBytes),
          tx.makeMoveVec({ type: 'ID', elements: Array.from(selectedBatches).map(id => tx.pure.id(id)) }),
          tx.object('0x6'), // clock
        ],
      });

      const { digest } = await signAndExecute({ transaction: tx });
      setSuccessId(digest);
    } catch (e) {
      console.error(e);
      alert('Failed to file attestation: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isRevokedOrExpired) {
    return (
      <div className="space-y-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Action Disabled</AlertTitle>
          <AlertDescription>
            This engagement is {engagement.revoked ? 'revoked' : 'expired'}. You cannot file attestations.
          </AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => router.back()}>Go Back</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <FileSignature className="w-8 h-8 text-primary" />
        <h2 className="text-2xl font-bold">File Attestation</h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Report Findings</CardTitle>
          <CardDescription>Enter your findings or upload a document to anchor on Walrus.</CardDescription>
        </CardHeader>
        <CardContent>
          <textarea 
            className="w-full h-32 p-3 bg-muted rounded-md text-sm border focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="No tampering detected. All events within scope were verified against the on-chain Merkle root."
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cite Batches</CardTitle>
          <CardDescription>Select the batches that support your findings.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {batches.map(b => (
              <label key={b.batchId} className="flex items-center gap-3 p-3 border rounded-md hover:bg-muted/50 cursor-pointer">
                <input 
                  type="checkbox" 
                  className="w-4 h-4"
                  checked={selectedBatches.has(b.batchId)}
                  onChange={() => toggleBatch(b.batchId)}
                />
                <div className="text-sm">
                  <div className="font-medium">Batch {b.batchId.slice(0,8)}...</div>
                  <div className="text-muted-foreground font-mono text-xs">Seq: {b.seqStart} - {b.seqEnd}</div>
                </div>
              </label>
            ))}
            {batches.length === 0 && <div className="text-muted-foreground text-sm">No batches available to cite.</div>}
          </div>
        </CardContent>
      </Card>

      {successId ? (
        <Alert className="bg-green-600/10 border-green-600/50">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertTitle className="text-green-600 font-bold">Attestation Filed Successfully</AlertTitle>
          <AlertDescription className="text-green-600/90 font-mono text-xs mt-2">
            Tx digest: {successId}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex gap-4">
          <Button variant="outline" onClick={() => router.back()}>Cancel</Button>
          <Button onClick={handleAttest} disabled={isSubmitting || !reportText || selectedBatches.size === 0}>
            {isSubmitting ? 'Signing & Filing...' : 'Sign and File Attestation'}
          </Button>
        </div>
      )}
    </div>
  );
}

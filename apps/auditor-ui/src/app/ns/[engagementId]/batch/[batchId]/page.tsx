"use client";

import { useCurrentAccount } from '@mysten/dapp-kit';
import { getBatch, getEngagements } from '@/lib/indexer';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LockOpen, Lock } from 'lucide-react';
import { useState } from 'react';
import { createGatePTB, parseSealAbort } from '@/lib/seal';
import { verifyEventInclusion } from '@/lib/contract';
import { fromHex } from '@mysten/sui/utils';

export default function BatchDetailPage() {
  const address = useCurrentAccount()?.address;
  const { engagementId, batchId } = useParams();

  const { data: engagements } = useQuery({
    queryKey: ['engagements', address],
    queryFn: () => getEngagements(address as string),
    enabled: !!address,
  });

  const engagement = engagements?.find(e => e.engagementId === engagementId);

  const { data: batch, isLoading } = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => getBatch(batchId as string),
    enabled: !!batchId,
  });

  const [verificationStatus, setVerificationStatus] = useState<Record<number, string>>({});
  const [decryptionStatus, setDecryptionStatus] = useState<Record<number, string>>({});

  const handleVerify = async (seq: number, blobId: string) => {
    if (!batch) return;
    setVerificationStatus(prev => ({ ...prev, [seq]: 'verifying...' }));
    try {
      // DEMO ONLY: the event hash is fabricated from the blobId string and the
      // merkle proof is empty — this is NOT a real inclusion proof. Real
      // verification requires rebuilding the tree to obtain the proof path.
      // Labelled explicitly so the badge never claims a real on-chain proof.
      const eventHash = fromHex(blobId.padEnd(64, '0').slice(0, 64));

      const proof: Uint8Array[] = [];
      const onChainOk = await verifyEventInclusion(batch.batchId, seq, eventHash, proof);

      setVerificationStatus(prev => ({
        ...prev,
        [seq]: onChainOk ? 'Demo: call OK (no real proof)' : 'Failed'
      }));
    } catch {
      setVerificationStatus(prev => ({ ...prev, [seq]: 'Error' }));
    }
  };

  const handleDecrypt = async (seq: number) => {
    if (!engagement || !batch) return;
    setDecryptionStatus(prev => ({ ...prev, [seq]: 'requesting share...' }));
    try {
      const namespaceIdBytes = fromHex(engagement.namespaceId.replace('0x', ''));
      const gatePtb = createGatePTB(namespaceIdBytes, engagement.engagementId, "tool_call", Date.now());
      console.log("Gate PTB for decryption:", gatePtb);
      
      // Simulating network delay and response
      await new Promise(r => setTimeout(r, 1500));
      
      const isRevokedOrExpired = engagement.revoked || engagement.expiresAtMs < Date.now();
      if (isRevokedOrExpired) {
        throw new Error("AbortCode: 6"); // Simulate expiry abort
      }

      setDecryptionStatus(prev => ({ ...prev, [seq]: 'Decrypted (Demo)' }));
    } catch (e: unknown) {
      setDecryptionStatus(prev => ({ ...prev, [seq]: parseSealAbort(e) }));
    }
  };

  if (!engagement) return <div className="p-4">Access denied.</div>;
  if (isLoading) return <div className="p-4">Loading batch...</div>;
  if (!batch) return <div className="p-4">Batch not found.</div>;

  const isRevokedOrExpired = engagement.revoked || engagement.expiresAtMs < Date.now();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Batch Details</h2>
      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Receipt Information</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm font-mono">
          <div><span className="text-muted-foreground">Batch ID:</span><br/>{batch.batchId}</div>
          <div><span className="text-muted-foreground">Run ID:</span><br/>{batch.runId || 'N/A'}</div>
          <div><span className="text-muted-foreground">Sequence Range:</span><br/>{batch.seqStart} - {batch.seqEnd}</div>
          <div><span className="text-muted-foreground">Anchored:</span><br/>{new Date(batch.anchoredAtMs).toLocaleString()}</div>
          <div className="col-span-2"><span className="text-muted-foreground">Merkle Root:</span><br/>{batch.merkleRoot}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Events ({batch.blobIds.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Seq</TableHead>
                <TableHead>Blob ID</TableHead>
                <TableHead>Verify Inclusion</TableHead>
                <TableHead>Decryption</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.blobIds.map((blobId, i) => {
                const seq = batch.seqStart + i;
                const vStatus = verificationStatus[seq];
                const dStatus = decryptionStatus[seq];

                return (
                  <TableRow key={seq}>
                    <TableCell className="font-mono">{seq}</TableCell>
                    <TableCell className="font-mono text-xs truncate max-w-[200px]" title={blobId}>{blobId}</TableCell>
                    <TableCell>
                      {vStatus ? (
                        <Badge
                          variant={vStatus.startsWith('Demo') ? 'secondary' : vStatus === 'verifying...' ? 'secondary' : 'destructive'}
                        >
                          {vStatus}
                        </Badge>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => handleVerify(seq, blobId)}>
                          Verify
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      {dStatus ? (
                        <Badge variant={dStatus.includes('Decrypted') ? 'default' : dStatus.includes('requesting') ? 'secondary' : 'destructive'}>
                          {dStatus.includes('Decrypted') ? <LockOpen className="w-3 h-3 mr-1"/> : <Lock className="w-3 h-3 mr-1"/>}
                          {dStatus}
                        </Badge>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => handleDecrypt(seq)} disabled={isRevokedOrExpired}>
                          <Lock className="w-3 h-3 mr-2" />
                          Decrypt
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

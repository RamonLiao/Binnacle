"use client";

import { useCurrentAccount } from '@mysten/dapp-kit';
import { getEngagements, getNamespace, getBatches, getCoverage } from '@/lib/indexer';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, ShieldCheck, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NamespaceDashboard() {
  const address = useCurrentAccount()?.address;
  const { engagementId } = useParams();

  const { data: engagements } = useQuery({
    queryKey: ['engagements', address],
    queryFn: () => getEngagements(address as string),
    enabled: !!address,
  });

  const engagement = engagements?.find(e => e.engagementId === engagementId);
  const namespaceId = engagement?.namespaceId;

  const { data: namespace, isLoading: nsLoading } = useQuery({
    queryKey: ['namespace', namespaceId],
    queryFn: () => getNamespace(namespaceId as string),
    enabled: !!namespaceId,
  });

  const { data: batchesRes, isLoading: batchesLoading } = useQuery({
    queryKey: ['batches', namespaceId],
    queryFn: () => getBatches(namespaceId as string),
    enabled: !!namespaceId,
  });

  const { data: coverage } = useQuery({
    queryKey: ['coverage', namespaceId],
    queryFn: () => getCoverage(namespaceId as string),
    enabled: !!namespaceId,
  });

  if (!address) return <div className="p-4">Please sign in.</div>;
  if (!engagement) return <div className="p-4">Engagement not found or access denied.</div>;

  const batches = batchesRes?.items || [];
  const isRevokedOrExpired = engagement.revoked || engagement.expiresAtMs < Date.now();

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold mb-2">Namespace Dashboard</h2>
          <div className="flex gap-2 items-center text-sm text-muted-foreground">
            <span>Agent: <span className="font-medium text-foreground">{engagement.agentId}</span></span>
            <span>•</span>
            <span className="font-mono">NS: {namespaceId?.slice(0,8)}...</span>
          </div>
        </div>
        <Link href={`/ns/${engagementId}/attest`}>
          <Button disabled={isRevokedOrExpired}>File Attestation</Button>
        </Link>
      </div>

      {isRevokedOrExpired && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Read-Only Access</AlertTitle>
          <AlertDescription>
            This engagement is {engagement.revoked ? 'revoked' : 'expired'}. Decryption and attestation filing are disabled.
          </AlertDescription>
        </Alert>
      )}

      {coverage && !coverage.healthy && (
        <Alert variant="destructive" className="bg-destructive/10">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <AlertTitle className="text-destructive font-bold">Coverage Gap Detected</AlertTitle>
          <AlertDescription className="text-destructive/90">
            The indexer reports missing event sequences. Tampering or agent failure may have occurred.
            <ul className="mt-2 list-disc list-inside pl-4">
              {coverage.gaps?.map((g: { expected: number; observed: number; atMs: number }, i: number) => (
                <li key={i}>Expected seq {g.expected}, but observed {g.observed} at {new Date(g.atMs).toLocaleString()}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Status</CardTitle></CardHeader>
          <CardContent>
            {nsLoading ? "..." : namespace?.sealed ? 
              <Badge variant="default" className="bg-green-600"><ShieldCheck className="w-3 h-3 mr-1"/> Sealed</Badge> : 
              <Badge variant="secondary">Active</Badge>
            }
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Next Seq</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold font-mono">{namespace?.seqNext || 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Batches</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold font-mono">{namespace?.batchIndex || 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Head Hash</CardTitle></CardHeader>
          <CardContent className="font-mono text-xs truncate" title={namespace?.lastBatchHash}>
            {namespace?.lastBatchHash || 'None'}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Anchored Batches</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch ID</TableHead>
                <TableHead>Seq Range</TableHead>
                <TableHead>Anchored</TableHead>
                <TableHead>Batch Hash</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batchesLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Loading...</TableCell></TableRow>
              ) : batches.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No batches found.</TableCell></TableRow>
              ) : (
                batches.map((b: { batchId: string, seqStart: number, seqEnd: number, anchoredAtMs: number, batchHash: string }) => (
                  <TableRow key={b.batchId}>
                    <TableCell className="font-mono">{b.batchId.slice(0,6)}...</TableCell>
                    <TableCell className="font-mono">{b.seqStart} - {b.seqEnd}</TableCell>
                    <TableCell>{new Date(b.anchoredAtMs).toLocaleString()}</TableCell>
                    <TableCell className="font-mono text-xs truncate max-w-[150px]" title={b.batchHash}>{b.batchHash}</TableCell>
                    <TableCell className="text-right">
                      <Link href={`/ns/${engagementId}/batch/${b.batchId}`}>
                        <Button variant="ghost" size="sm">Inspect <ArrowRight className="w-4 h-4 ml-2"/></Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { useCurrentAccount } from '@mysten/dapp-kit';
import { getEngagements, Engagement } from '@/lib/indexer';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';

export default function EngagementsPage() {
  const address = useCurrentAccount()?.address;

  const { data: engagements, isLoading, isError } = useQuery({
    queryKey: ['engagements', address],
    queryFn: () => getEngagements(address as string),
    enabled: !!address,
  });

  if (!address) {
    return <div className="p-4">Please sign in to view engagements.</div>;
  }

  if (isLoading) return <div className="p-4 text-muted-foreground">Loading engagements...</div>;

  if (isError) return (
    <Alert variant="destructive" className="max-w-2xl mt-4">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>Failed to fetch engagements. The indexer might be offline.</AlertDescription>
    </Alert>
  );

  if (!engagements || engagements.length === 0) {
    return (
      <div className="p-4">
        <h2 className="text-2xl font-bold mb-4">My Engagements</h2>
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            No engagements found for this address.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">My Engagements</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {engagements.map((eng: Engagement) => {
          const isExpired = eng.expiresAtMs < Date.now();
          const status = eng.revoked ? "Revoked" : isExpired ? "Expired" : "Active";
          const statusVariant = status === "Active" ? "default" : "destructive";

          return (
            <Link key={eng.engagementId} href={`/ns/${eng.engagementId}`}>
              <Card className="hover:border-primary/50 transition-colors h-full flex flex-col">
                <CardHeader>
                  <div className="flex justify-between items-start gap-4">
                    <CardTitle className="truncate" title={eng.agentId}>{eng.agentId}</CardTitle>
                    <Badge variant={statusVariant}>{status}</Badge>
                  </div>
                  <CardDescription className="font-mono text-xs truncate">
                    NS: {eng.namespaceId.slice(0, 10)}...
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Scope Window:</span><br/>
                    {new Date(eng.scopeStartMs).toLocaleDateString()} - {new Date(eng.scopeEndMs).toLocaleDateString()}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Expires:</span><br/>
                    {new Date(eng.expiresAtMs).toLocaleDateString()}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Types:</span><br/>
                    {eng.eventTypeFilter.length === 0 ? (
                      <Badge variant="outline" className="mt-1">All Events</Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {eng.eventTypeFilter.map(t => <Badge key={t} variant="secondary">{t}</Badge>)}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

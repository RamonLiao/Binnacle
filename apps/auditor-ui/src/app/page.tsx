"use client";

import { useConnectWallet, useCurrentAccount, useWallets } from '@mysten/dapp-kit';
import { isEnokiWallet, type EnokiWallet, type AuthProvider } from '@mysten/enoki';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  const account = useCurrentAccount();
  const { mutate: connect } = useConnectWallet();
  const router = useRouter();

  useEffect(() => {
    if (account) {
      router.push('/engagements');
    }
  }, [account, router]);

  const wallets = useWallets().filter(isEnokiWallet);
  const walletsByProvider = wallets.reduce(
    (map, wallet) => map.set(wallet.provider, wallet),
    new Map<AuthProvider, EnokiWallet>(),
  );
  const googleWallet = walletsByProvider.get('google');

  return (
    <div className="flex items-center justify-center min-h-[80vh]">
      <Card className="w-[400px]">
        <CardHeader>
          <CardTitle>Auditor Sign In</CardTitle>
          <CardDescription>Sign in with zkLogin to access your engagements.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button
            className="w-full"
            disabled={!googleWallet}
            onClick={() => {
              if (googleWallet) connect({ wallet: googleWallet });
            }}
          >
            {googleWallet ? 'Sign in with Google' : 'Loading Enoki…'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

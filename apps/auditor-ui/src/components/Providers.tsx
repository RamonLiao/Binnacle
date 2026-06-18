"use client";

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  SuiClientProvider,
  WalletProvider,
  useSuiClientContext,
} from '@mysten/dapp-kit';
import { isEnokiNetwork, registerEnokiWallets } from '@mysten/enoki';
import { useEffect } from 'react';
import { suiClient } from '@/lib/sui';
import '@mysten/dapp-kit/dist/index.css';

const queryClient = new QueryClient();
const networks = {
  testnet: suiClient,
};

function RegisterEnokiWallets() {
  const { client, network } = useSuiClientContext();

  useEffect(() => {
    if (!isEnokiNetwork(network)) return;

    // Fail loud: a missing/placeholder key otherwise leaves the sign-in button
    // stuck on "Loading Enoki…" forever with no diagnostic.
    const apiKey = process.env.NEXT_PUBLIC_ENOKI_API_KEY;
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!apiKey || apiKey.includes('REPLACE_ME')) {
      console.error('[Enoki] NEXT_PUBLIC_ENOKI_API_KEY missing or placeholder — Google sign-in disabled.');
      return;
    }
    if (!clientId || clientId === 'mock_client_id') {
      console.error('[Enoki] NEXT_PUBLIC_GOOGLE_CLIENT_ID missing or placeholder — Google sign-in disabled.');
      return;
    }

    const { unregister } = registerEnokiWallets({
      apiKey,
      providers: {
        google: { clientId },
      },
      client,
      network,
    });

    return unregister;
  }, [client, network]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networks} defaultNetwork="testnet">
        <RegisterEnokiWallets />
        <WalletProvider autoConnect>
          {children}
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}

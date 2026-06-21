"use client";

import { useConnectWallet, useCurrentAccount, useWallets } from '@mysten/dapp-kit';
import { isEnokiWallet, type EnokiWallet, type AuthProvider } from '@mysten/enoki';
import { Button } from '@/components/ui/button';
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
    <div className="flex items-center justify-center min-h-[80vh] px-4">
      <div className="flex flex-col md:flex-row w-full max-w-[850px] overflow-hidden rounded-2xl border border-border/80 bg-card/40 backdrop-blur-md shadow-2xl">
        {/* Left Side: Gorgeous Hero Illustration */}
        <div className="relative hidden md:block md:w-1/2 min-h-[450px] bg-muted/20 border-r border-border overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img 
            src="/hero_illustration.png" 
            alt="Binnacle submarine cabin illustration" 
            className="absolute inset-0 w-full h-full object-cover opacity-90 transition-transform duration-700 hover:scale-105" 
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-transparent to-transparent flex flex-col justify-end p-6">
            <h3 className="text-lg font-bold text-white mb-1">AI Agent Verifiable Audits</h3>
            <p className="text-xs text-slate-300">Secured on Walrus storage & sealed with Sui cryptographic enforcement.</p>
          </div>
        </div>

        {/* Right Side: Sign In Card Contents */}
        <div className="w-full md:w-1/2 flex flex-col justify-center p-8 md:p-10 bg-gradient-to-b from-[#111C38] to-[#0A1128]">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-full overflow-hidden border border-primary/20 bg-background flex-shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo_mascot_box.png" alt="Binnacle Mascot" className="w-full h-full object-cover" />
            </div>
            <span className="font-mono text-xs text-primary font-bold tracking-wider uppercase">Binnacle Protocol</span>
          </div>

          <h2 className="text-2xl font-bold tracking-tight text-foreground mb-2">Auditor Sign In</h2>
          <p className="text-sm text-muted-foreground mb-8">
            Sign in with zkLogin to securely view and verify tamper-proof agent audit memory.
          </p>

          <Button
            className="w-full py-6 font-semibold text-sm transition-all duration-300 border border-primary/30 bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
            disabled={!googleWallet}
            onClick={() => {
              if (googleWallet) connect({ wallet: googleWallet });
            }}
          >
            {googleWallet ? (
              <div className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                <span>Sign in with Google</span>
              </div>
            ) : (
              <span className="animate-pulse">Loading Enoki…</span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCurrentAccount, useDisconnectWallet } from '@mysten/dapp-kit';
import { Button } from './ui/button';

export function Header() {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
  const address = account?.address;

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-md px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative w-8 h-8 rounded-full overflow-hidden border border-primary/30 bg-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo_mascot_box.png" alt="Binnacle Mascot" className="object-cover w-full h-full" />
        </div>
        <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-foreground via-foreground to-primary/80 bg-clip-text text-transparent">
          Binnacle Auditor
        </h1>
      </div>
      {address ? (
        <div className="flex items-center gap-4">
          <span className="text-sm font-mono bg-muted/50 border border-border px-3 py-1 rounded-md text-muted-foreground">
            {address.slice(0, 6)}...{address.slice(-4)}
          </span>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => disconnect()}
            className="border-primary/50 text-foreground hover:bg-primary hover:text-primary-foreground transition-all duration-200"
          >
            Sign Out
          </Button>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground bg-muted/30 px-3 py-1 rounded-md border border-border/50">
          Not signed in
        </span>
      )}
    </header>
  );
}

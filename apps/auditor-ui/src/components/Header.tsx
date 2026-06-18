"use client";

import { useCurrentAccount, useDisconnectWallet } from '@mysten/dapp-kit';
import { Button } from './ui/button';

export function Header() {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
  const address = account?.address;

  return (
    <header className="border-b p-4 flex items-center justify-between">
      <h1 className="text-xl font-bold">ComplianceVault Auditor</h1>
      {address ? (
        <div className="flex items-center gap-4">
          <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
            {address.slice(0, 6)}...{address.slice(-4)}
          </span>
          <Button variant="outline" size="sm" onClick={() => disconnect()}>Sign Out</Button>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">Not signed in</span>
      )}
    </header>
  );
}

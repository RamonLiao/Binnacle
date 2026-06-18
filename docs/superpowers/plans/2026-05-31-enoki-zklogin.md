# Enoki zkLogin Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace auditor-ui's mock zkLogin (fake JWT + mock attest) with real Enoki-managed Google zkLogin, signing+submitting real attestation transactions to testnet over gRPC.

**Architecture:** Enoki injects a wallet-standard Google wallet that dapp-kit hooks consume (connect/account/sign). The custom `AuthProvider`/`lib/zklogin.ts` mock is deleted; address comes from `useCurrentAccount()`. dapp-kit's JSON-RPC provider is kept ONLY for wallet connect (v1.0.6 networks type rejects gRPC); transaction **execution** is routed off JSON-RPC through a separate `SuiGrpcClient` via the `useSignAndExecuteTransaction({ execute })` override.

**Tech Stack:** Next.js 15, React 19, `@mysten/dapp-kit ^1.0.6`, `@mysten/enoki` (new), `@mysten/sui ^2.16` (`/grpc`, `/zklogin`), pnpm.

**Project note:** This directory is NOT a git repo — there are no commit steps. Each task's gate is `pnpm typecheck` / `pnpm build`. Run all commands from `apps/auditor-ui/`.

**Pre-req owned by user:** `NEXT_PUBLIC_GOOGLE_CLIENT_ID` already set; Enoki Portal has the Google provider + client ID + whitelisted redirect origin. User will provide `NEXT_PUBLIC_ENOKI_API_KEY`.

---

## File Structure

- `package.json` — add `@mysten/enoki`.
- `.env.example`, `.env.local` — add `NEXT_PUBLIC_ENOKI_API_KEY`.
- `src/lib/sui.ts` — keep JSON-RPC `suiClient`; add `grpcClient` (execution transport).
- `src/components/Providers.tsx` — register Enoki wallets; `autoConnect`.
- `src/components/AuthProvider.tsx` — **delete**.
- `src/lib/zklogin.ts` — **delete**.
- `src/app/layout.tsx` — drop `<AuthProvider>`.
- `src/app/page.tsx` — Enoki Google connect button.
- `src/components/Header.tsx` — `useCurrentAccount` + `useDisconnectWallet`.
- `src/app/engagements/page.tsx`, `src/app/ns/[engagementId]/page.tsx`, `src/app/ns/[engagementId]/batch/[batchId]/page.tsx` — address from `useCurrentAccount`.
- `src/app/ns/[engagementId]/attest/page.tsx` — real sign (Enoki) + gRPC execute.

---

## Task 1: Install Enoki + add env var

**Files:**
- Modify: `package.json`
- Modify: `.env.example`, `.env.local`

- [ ] **Step 1: Install the Enoki SDK**

Run: `pnpm add @mysten/enoki`
Expected: `package.json` dependencies now include `@mysten/enoki`; lockfile updated, no peer-dep errors against `@mysten/sui ^2.16` / `@mysten/dapp-kit ^1.0.6`.

- [ ] **Step 2: Add the Enoki API key var to `.env.example`**

Append this line to `.env.example`:

```
NEXT_PUBLIC_ENOKI_API_KEY=enoki_public_xxxxxxxx
```

- [ ] **Step 3: Add the real key to `.env.local`**

Add to `.env.local` (value provided by the user — do NOT invent one; if absent, stop and ask):

```
NEXT_PUBLIC_ENOKI_API_KEY=<user-provided enoki public key>
```

- [ ] **Step 4: Verify install**

Run: `pnpm ls @mysten/enoki`
Expected: prints an installed version, no "missing".

---

## Task 2: Add gRPC execution client to `lib/sui.ts`

**Files:**
- Modify: `src/lib/sui.ts`

- [ ] **Step 1: Replace `lib/sui.ts` with both clients**

Current file exports only a JSON-RPC client. Replace its full contents with:

```typescript
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SuiGrpcClient } from '@mysten/sui/grpc';

// JSON-RPC client — used ONLY by dapp-kit's SuiClientProvider for wallet connect.
// dapp-kit v1.0.6 `networks` does not accept a gRPC client, so this stays JSON-RPC.
export const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

// gRPC client — used to EXECUTE transactions off the deprecated JSON-RPC transport
// (Quorum Driver disabled / JSON-RPC removal April 2026). Wired into the attest flow
// via useSignAndExecuteTransaction({ execute }).
export const grpcClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors referencing `lib/sui.ts` (other pre-existing errors, if any, are addressed by later tasks — note them, don't fix unrelated ones).

---

## Task 3: Register Enoki wallets in `Providers.tsx`

**Files:**
- Modify: `src/components/Providers.tsx`

- [ ] **Step 1: Replace `Providers.tsx` with Enoki registration**

Replace the full file contents with:

```tsx
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

    const { unregister } = registerEnokiWallets({
      apiKey: process.env.NEXT_PUBLIC_ENOKI_API_KEY!,
      providers: {
        google: { clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID! },
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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors in `Providers.tsx`. (`isEnokiNetwork`/`registerEnokiWallets` resolve from `@mysten/enoki`; `useSuiClientContext` from dapp-kit.)

---

## Task 4: Rewrite the login page (`page.tsx`)

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Replace `page.tsx` with the Enoki Google login**

Replace the full file contents with:

```tsx
"use client";

import { useConnectWallet, useCurrentAccount, useWallets } from '@mysten/dapp-kit';
import { isEnokiWallet, type EnokiWallet, type AuthProvider } from '@mysten/enoki';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  const account = useCurrentAccount();
  const { connect } = useConnectWallet();
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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors in `page.tsx`.

---

## Task 5: Rewrite `Header.tsx`

**Files:**
- Modify: `src/components/Header.tsx`

- [ ] **Step 1: Replace `Header.tsx`**

Replace the full file contents with:

```tsx
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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors in `Header.tsx`.

---

## Task 6: Delete the mock auth, drop the provider wrapper

**Files:**
- Delete: `src/components/AuthProvider.tsx`
- Delete: `src/lib/zklogin.ts`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Delete the mock files**

Run: `rm src/components/AuthProvider.tsx src/lib/zklogin.ts`
Expected: both files gone.

- [ ] **Step 2: Remove `<AuthProvider>` from `layout.tsx`**

In `src/app/layout.tsx`, remove the import line:

```tsx
import { AuthProvider } from '@/components/AuthProvider';
```

and unwrap the children — change:

```tsx
        <Providers>
          <AuthProvider>
            <div className="min-h-screen bg-background text-foreground flex flex-col">
              <Header />
              <main className="flex-1 p-6">
                {children}
              </main>
            </div>
          </AuthProvider>
        </Providers>
```

to:

```tsx
        <Providers>
          <div className="min-h-screen bg-background text-foreground flex flex-col">
            <Header />
            <main className="flex-1 p-6">
              {children}
            </main>
          </div>
        </Providers>
```

- [ ] **Step 3: Typecheck — expect remaining `useAuth` consumers to break**

Run: `pnpm exec tsc --noEmit`
Expected: errors ONLY in the 3 read pages + attest page still importing `@/components/AuthProvider` (fixed in Tasks 7–8). No error about `layout.tsx`.

---

## Task 7: Swap read pages to `useCurrentAccount`

**Files:**
- Modify: `src/app/engagements/page.tsx`
- Modify: `src/app/ns/[engagementId]/page.tsx`
- Modify: `src/app/ns/[engagementId]/batch/[batchId]/page.tsx`

- [ ] **Step 1: `engagements/page.tsx` — replace import + address source**

Remove line 3 `import { useAuth } from '@/components/AuthProvider';` and add the dapp-kit import at the top of the existing imports:

```tsx
import { useCurrentAccount } from '@mysten/dapp-kit';
```

Replace line 13 `const { address } = useAuth();` with:

```tsx
const address = useCurrentAccount()?.address;
```

(Leave the rest — `queryKey`/`enabled: !!address`/`if (!address)` — unchanged; `address` is now `string | undefined`, which all existing checks already handle.)

- [ ] **Step 2: `ns/[engagementId]/page.tsx` — same swap**

Remove line 3 `import { useAuth } from '@/components/AuthProvider';`, add:

```tsx
import { useCurrentAccount } from '@mysten/dapp-kit';
```

Replace line 16 `const { address } = useAuth();` with:

```tsx
const address = useCurrentAccount()?.address;
```

- [ ] **Step 3: `ns/[engagementId]/batch/[batchId]/page.tsx` — same swap**

Remove line 3 `import { useAuth } from '@/components/AuthProvider';`, add:

```tsx
import { useCurrentAccount } from '@mysten/dapp-kit';
```

Replace line 18 `const { address } = useAuth();` with:

```tsx
const address = useCurrentAccount()?.address;
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: errors now ONLY in `attest/page.tsx` (Task 8).

---

## Task 8: Real attest — Enoki sign + gRPC execute

**Files:**
- Modify: `src/app/ns/[engagementId]/attest/page.tsx`

- [ ] **Step 1: Fix imports**

Remove `import { useAuth } from '@/components/AuthProvider';`. Add to the imports:

```tsx
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { grpcClient } from '@/lib/sui';
```

Move the stray bottom import `import { CheckCircle2 } from 'lucide-react';` up into the top `lucide-react` import group (it currently sits at the end of the file):

```tsx
import { AlertTriangle, FileSignature, CheckCircle2 } from 'lucide-react';
```

and delete the trailing line:

```tsx
// Added this since the icon check was throwing error on import implicitly before creating it.
import { CheckCircle2 } from 'lucide-react';
```

- [ ] **Step 2: Replace the address source + add the hook**

Replace `const { address } = useAuth();` with:

```tsx
  const account = useCurrentAccount();
  const address = account?.address;
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) =>
      grpcClient.core.executeTransaction({ transaction: bytes, signature }),
  });
```

- [ ] **Step 3: Replace the mock `handleAttest` body with real submission**

Replace the entire existing `handleAttest` function with:

```tsx
  const handleAttest = async () => {
    if (!address) {
      alert('Please sign in first.');
      return;
    }
    setIsSubmitting(true);
    try {
      // NOTE: Walrus upload is still mocked (separate task). Only the on-chain
      // attestation transaction is real here.
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
```

- [ ] **Step 4: Update the success card to show a real digest**

In the success `<Alert>` block, change the label `ID: {successId}` to make it clear it is a testnet digest:

```tsx
          <AlertDescription className="text-green-600/90 font-mono text-xs mt-2">
            Tx digest: {successId}
          </AlertDescription>
```

- [ ] **Step 5: Typecheck — should be clean now**

Run: `pnpm exec tsc --noEmit`
Expected: PASS, zero errors.

---

## Task 9: Build + manual e2e + monkey tests

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run: `pnpm build`
Expected: build succeeds, no type/lint errors.

- [ ] **Step 2: gRPC reachability sanity (do FIRST — highest-risk unknown)**

Run: `pnpm dev`, open the app, and in the browser devtools console confirm a gRPC-web call to `https://fullnode.testnet.sui.io:443` is not CORS-blocked when you attempt an attest. If blocked, switch `grpcClient` `baseUrl` in `lib/sui.ts` to a gRPC-web-enabled testnet endpoint and re-test. Record the working endpoint in `move-notes.md`.

- [ ] **Step 3: Real login**

In `pnpm dev`: click "Sign in with Google" → complete Google OAuth → confirm redirect to `/engagements` and the Header shows a real `0x…` zkLogin address (NOT the old mock address).

- [ ] **Step 4: Real attestation**

Open an active engagement → attest page → enter findings, cite ≥1 batch → "Sign and File Attestation" → confirm a real tx digest appears and resolves on a testnet explorer (suiscan/suivision).

- [ ] **Step 5: Monkey tests (try to break it)**

  - Click attest while signed out → blocked with "Please sign in first." (no crash).
  - Open attest on a revoked/expired engagement → "Action Disabled" guard shows; submit not possible.
  - Submit with no batches selected / empty report → button stays disabled.
  - Let the Enoki session sit until the ephemeral key/maxEpoch expires, then attest → expect a clear failure + ability to re-login (Sign Out → Sign in with Google) and succeed.
  - Browser popup blocked on login → confirm Enoki falls back / surfaces a usable error (note behavior in `move-notes.md`).

- [ ] **Step 6: Record results**

Update `tasks/progress.md` (mark zkLogin blocker resolved) and `move-notes.md` (working gRPC endpoint, any Enoki quirks, remaining mocks: Walrus upload).

---

## Notes / Out of scope (do not do here)

- Walrus upload stays mocked (`reportBlobId`/`reportHash` fake) — separate task.
- `NEXT_PUBLIC_ZKLOGIN_PROVER` is now dead (Enoki hosts the prover) — leave it, flag for a later cleanup task.
- Full GraphQL migration of read queries is NOT pursued; only execution moved to gRPC.

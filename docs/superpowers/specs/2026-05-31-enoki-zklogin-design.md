# Enoki zkLogin Integration — Design

> Date: 2026-05-31 · Scope: `apps/auditor-ui` · Replaces mock zkLogin with real Enoki-managed zkLogin

## Goal

Replace the auditor-ui mock auth flow (fake JWT + `jwtToAddress` + mock attest execution)
with real Google zkLogin via **Enoki** (Mysten managed: OAuth + salt service + prover +
ephemeral key all hosted). Attestation transactions get really signed and submitted to
testnet.

## Decision Log

- **Approach: Enoki managed** (vs manual full zkLogin vs read-only). Chosen for least
  custom code + most robust demo. User already holds Enoki API key + Google OAuth client ID.
- **Full replacement** of custom `AuthProvider` with dapp-kit wallet hooks (vs adapter
  wrapper). Enoki injects a wallet-standard wallet; all dapp-kit hooks become Enoki-compatible.
- **Execution transport: gRPC via `execute` override** (sui-architect review finding,
  CRITICAL; refined after dapp-kit API check). JSON-RPC is deprecated, Quorum Driver
  disabled, removal scheduled April 2026 — past as of 2026-05-31. The task's core goal is
  *really submitting* attest transactions. **Constraint discovered:** dapp-kit v1.0.6
  `SuiClientProvider.networks` is typed `Record<string, NetworkConfig | SuiJsonRpcClient>`
  — it does **not** accept a `SuiGrpcClient`. So the wallet provider stays JSON-RPC (used
  only for wallet connect + Enoki registration), and transaction **execution** is routed
  through a separate `SuiGrpcClient` via `useSignAndExecuteTransaction({ execute })` — the
  hook exposes an `execute?: ({ bytes, signature }) => ...` override. The Enoki wallet
  signs (zkLogin signature assembled by Enoki); our `execute` calls
  `grpcClient.core.executeTransaction({ transaction: bytes, signature })`. This keeps the
  on-chain submission off JSON-RPC. Reads (engagements/batches) go through indexer REST and
  are unaffected.
- **Out of scope** (separate tasks, kept surgical):
  - Walrus upload stays mocked — `reportBlobId`/`reportHash` remain fake; only the
    **transaction signing/execution** is made real.
  - Full GraphQL migration for *queries* is NOT pursued; we only move the execution/client
    transport off JSON-RPC onto gRPC. Any remaining JSON-RPC read paths in the UI are
    flagged but not rewritten here.

## Architecture

Enoki registers a Google wallet via wallet-standard. dapp-kit reads it:
- `useWallets().filter(isEnokiWallet)` → pick google wallet
- `useConnectWallet().connect({ wallet })` → triggers Enoki OAuth (redirect/popup, salt,
  prover handled by Enoki)
- `useCurrentAccount()?.address` → the real zkLogin address (allowlist comparison source)
- `useSignAndExecuteTransaction()` → signs+executes attest PTB; Enoki assembles the
  zkLogin signature behind the scenes; returns real testnet digest

## Change List (9 sites)

| File | Action |
|------|--------|
| `package.json` | add `@mysten/enoki` |
| `.env.local` + `.env.example` | add `NEXT_PUBLIC_ENOKI_API_KEY`; mark `NEXT_PUBLIC_ZKLOGIN_PROVER` dead (Enoki hosts prover) — leave for separate cleanup |
| `src/lib/sui.ts` | keep `SuiJsonRpcClient` export `suiClient` (dapp-kit provider needs it); **add** `grpcClient = new SuiGrpcClient({ network: 'testnet', baseUrl })` export for execution |
| `src/components/Providers.tsx` | keep `networks={{ testnet: suiClient }}` (JSON-RPC) + `defaultNetwork="testnet"`; add `<RegisterEnokiWallets/>` inside `SuiClientProvider`, before `WalletProvider` (reads `useSuiClientContext()` → `registerEnokiWallets({ apiKey, providers: { google: { clientId } }, client, network })`, guarded by `isEnokiNetwork(network)`, returns `unregister`); `WalletProvider autoConnect` |
| `src/components/AuthProvider.tsx` | **delete** |
| `src/lib/zklogin.ts` | **delete** |
| `src/app/layout.tsx` | remove `<AuthProvider>` wrapper |
| `src/app/page.tsx` | replace mock-JWT button with Enoki google `connect({ wallet })`; redirect to `/engagements` when `useCurrentAccount()` set |
| `src/components/Header.tsx` | `useCurrentAccount()` + `useDisconnectWallet()` instead of `useAuth` |
| `src/app/engagements/page.tsx`, `src/app/ns/[engagementId]/page.tsx`, `src/app/ns/[engagementId]/batch/[batchId]/page.tsx` | `useAuth().address` → `useCurrentAccount()?.address` |
| `src/app/ns/[engagementId]/attest/page.tsx` | address from `useCurrentAccount()`; replace mock `setTimeout` execution with `useSignAndExecuteTransaction({ execute: async ({ bytes, signature }) => grpcClient.core.executeTransaction({ transaction: bytes, signature }) })` — Enoki signs, gRPC submits; surface real digest |

## External Prerequisites (user-side, manual)

- Enoki Portal: register google provider, enter Google OAuth client ID, whitelist redirect
  URL(s) (`http://localhost:3000` + any deployed origin).
- Set `NEXT_PUBLIC_ENOKI_API_KEY` in `.env.local`.

## Verification / Success Criteria

- `pnpm build` green.
- `pnpm dev`: real Google login → `useCurrentAccount()` shows a real zkLogin address.
- Attest a valid engagement → real testnet tx digest returned (verifiable on explorer).
- Monkey tests: attest while signed out (blocked); attest on revoked/expired engagement
  (already guarded); behavior when ephemeral key/maxEpoch expired (re-login path).

## Known Risks

- gRPC-web transport: `SuiGrpcClient` uses `@protobuf-ts/grpcweb-transport`; confirm the
  testnet gRPC-web `baseUrl` (`https://fullnode.testnet.sui.io:443`) is reachable from the
  browser (CORS). If the public fullnode rejects browser gRPC-web, fall back to a known
  gRPC-web-enabled endpoint. This is the main execution-path risk to verify first.
- `useSignAndExecuteTransaction`'s `execute` override receives `{ bytes, signature }`;
  confirm Enoki wallet's signature is a complete zkLogin signature acceptable by
  `executeTransaction` (it is — Enoki assembles it during sign).
- Enoki redirect requires correct origin whitelisting; localhost vs deployed mismatch is
  the most likely demo-day failure. Popup-blocked → fallback to redirect mode.

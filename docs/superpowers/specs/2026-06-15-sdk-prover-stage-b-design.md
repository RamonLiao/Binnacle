# ComplianceVault SDK — Design Spec (Stage B: Signer + Submit)

> Date: 2026-06-15
> Status: approved (brainstorming) → ready for writing-plans
> Builds on Stage A (`docs/superpowers/specs/2026-06-13-sdk-prover-design.md`).
> Implements the `client` layer staged at Stage A §0: keypair load + sign & submit
> to testnet (real anchor digest) over gRPC. Core 金流/auth path → Red Team required.

## 0. Goal & Boundary

Stage A returns an **unsigned** `Transaction` from `buildAnchorTx`. Stage B adds the thin
`client` layer that injects a `Signer`, resolves the shared `AgentNamespace`, signs, and
submits — producing a real on-chain anchor digest on testnet. Zero rework to Stage A:
`client` only consumes `buildAnchorTx`'s output.

| In scope | Out of scope |
|----------|--------------|
| `signerFromEnv()` (suiprivkey bech32 → Signer) | Sui CLI keystore / hardware wallet |
| `AnchorClient` (gRPC build + sign + submit) | Real Walrus blob upload (Stage C) |
| Mock-anchor fail-loud guard | Seal encryption |
| Red Team on the submit/auth path | Event ingestion / batching policy (`[A:4]`) |
| Unit + monkey tests (stubbed client, no network) | Automated live testnet integration test |

**Decisions locked in brainstorming (2026-06-15):**
- Signer: `Signer` injection into core API + `signerFromEnv()` convenience. Not env-only,
  not keystore — injectable for testability, single env helper for ergonomics.
- Transport: gRPC (`SuiGrpcClient`), matching auditor-ui's execute-override and the
  project no-JSON-RPC rule (JSON-RPC removed testnet-side Apr 2026).
- Submit: full sign & submit, but gated behind a mock-anchor guard (default deny),
  mirroring auditor-ui's `NEXT_PUBLIC_ALLOW_MOCK_ATTEST` — blobIds/Walrus are still
  mocked, so anchoring them on-chain must be an explicit opt-in.

## 1. Package Layout (additive)

```
sdk/src/
  client/
    signer.ts        signerFromEnv(env?) → Signer
    anchorClient.ts  class AnchorClient { constructor(grpcClient, signer); anchorBatch(input, opts) }
    index.ts         re-export client surface
  index.ts           + export * from client (existing core + tx unchanged)
sdk/test/
  signer.test.ts
  anchorClient.test.ts   (stub gRPC client; build+sign verified offline)
```

`tx`/`core` untouched (Rule-3 surgical).

## 2. `signer.ts`

```typescript
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import type { Signer } from '@mysten/sui/cryptography';

export function signerFromEnv(env: NodeJS.ProcessEnv = process.env): Signer
```

- Read `env.SUI_PRIVATE_KEY`. Missing/empty → throw (no fallback). **Error message MUST NOT
  echo the key value** (attack vector 4 — no partial-key leak).
- `decodeSuiPrivateKey(raw)` → `{ schema, secretKey }`. Non-bech32 / truncated / wrong HRP →
  `decodeSuiPrivateKey` throws; wrap with a clean message that still does not echo the key.
- Switch on `schema`: `ED25519` → `Ed25519Keypair.fromSecretKey(secretKey)`;
  `Secp256k1` → `Secp256k1Keypair.fromSecretKey`; `Secp256r1` → `Secp256r1Keypair.fromSecretKey`;
  default → throw `unknown key scheme`.
- **Impl-time grep** (`node_modules/@mysten/sui/dist/**/*.d.ts`): confirm `decodeSuiPrivateKey`
  return field names (`schema` vs `scheme`) and the `fromSecretKey` signature (Uint8Array vs
  base64). Lessons 2026-06-03: plan snippets are sketches, verify the real type surface.

## 3. `anchorClient.ts`

```typescript
export interface AnchorOpts { allowMockAnchor?: boolean }

export class AnchorClient {
  constructor(private grpcClient: SuiGrpcClient, private signer: Signer) {}
  async anchorBatch(input: AnchorBatchInput, opts?: AnchorOpts): Promise<{ digest: string }>
}
```

`anchorBatch` sequence (uses the SDK's own `Signer.signAndExecuteTransaction`, which builds —
resolving the shared `AgentNamespace`, owned `WriterCap`, and gas via the injected client —
signs, submits, and returns effects in one call; verified against `@mysten/sui` 2.17.0
`cryptography/keypair.d.mts`):

1. **Mock-anchor guard (Rule-12, 金流核心):** `const allow = opts?.allowMockAnchor ?? (process.env.ALLOW_MOCK_ANCHOR === 'true')`.
   `!allow` → throw `mock anchor blocked: pass allowMockAnchor or set ALLOW_MOCK_ANCHOR=true`
   (Walrus still mocked; refuse to anchor fake commitments by default).
2. `const tx = buildAnchorTx(input)` — reuses every Stage A fail-loud guard (seq range, count
   ≤ 4096, blobIds length, 32-byte root/runId, etc.). No duplication here.
3. `tx.setSender(this.signer.toSuiAddress())` — required so the client can resolve gas + owned
   refs at build time.
4. `const result = await this.signer.signAndExecuteTransaction({ transaction: tx, client: this.grpcClient })`.
   Verified types: `signAndExecuteTransaction({ transaction: Transaction; client: ClientWithCoreApi })`
   returns `Promise<TransactionResult<{ transaction: true; effects: true }>>` — effects are
   included automatically (no manual field mask). `SuiGrpcClient extends BaseClient` with
   `core: GrpcCoreClient` satisfies `ClientWithCoreApi` (tsc-verified at impl time).
5. **Parse the tagged union (lessons 2026-06-03):** `result.$kind === 'FailedTransaction'` →
   throw with `result.FailedTransaction` details (submission/validation failure).
6. **Assert success on effects, not just the union** (sui-architect 2026-06-15): on the
   `Transaction` branch, check `result.Transaction.effects.status` —
   `ExecutionStatus = { success: true; error: null } | { success: false; error }`. A Move abort
   (e.g. wrong WriterCap, vector 3) surfaces here as `success: false`, NOT in `$kind`.
   `!status.success` → throw with `status.error`. Only `success: true` returns
   `{ digest: result.Transaction.digest }`.

The client holds **no merkle logic** — it consumes `AnchorBatchInput` (caller builds the tree
via Stage A `buildTree`). One responsibility: sign & submit a pre-built anchor.

## 4. Red Team (核心金流/auth — run `sui-red-team` skill after code)

| # | Vector | Defense |
|---|--------|---------|
| 1 | Mock data anchored on-chain (fake blobId/root pollutes the audit chain) | Mock guard default-deny; explicit `allowMockAnchor` required. Test asserts default throws. |
| 2 | seq range / count mismatch (blobIds ≠ seqEnd−seqStart+1, count > 4096, u64 overflow) | Reuse `buildAnchorTx` Stage A guards; tests cover boundaries. |
| 3 | Sender ≠ WriterCap owner (wrong cap → on-chain abort, wasted gas, vague error) | `setSender` from signer's own address; wrong cap → on-chain abort surfaced via `effects.status.success === false` and thrown with `status.error`, not swallowed. |
| 4 | Malicious/malformed `SUI_PRIVATE_KEY` (empty, non-bech32, truncated, injection) | `signerFromEnv` fail-loud; tests feed malformed values; error message never echoes the key. |
| 5 | Silent submit failure treated as success (union mis-parse, OR Move abort hidden in effects while digest looks valid) | Strict `$kind` check **and** `effects.status` success assertion (gRPC needs effects explicitly requested — §3 step 6/7); stub client returns FailedTransaction **and** a success-digest-but-aborted-effects case → both test-asserted to throw. |

## 5. Tests (`tsx --test`, offline)

- **signer.test.ts:** valid suiprivkey → correct address; missing env / non-bech32 / truncated /
  unknown scheme → throw; assert thrown message does not contain the raw key (vector 4).
- **anchorClient.test.ts:** inject a **stub Signer** (`toSuiAddress()` returns a fixed address;
  `signAndExecuteTransaction({transaction, client})` records the passed `Transaction` + client
  and returns a canned `TransactionResult` on demand) and a dummy client (the stub signer never
  touches the network, so the client is a pass-through marker):
  - no `allowMockAnchor` → throw before the signer is ever called (vector 1).
  - `allowMockAnchor: true`, stub returns success → returns the digest; assert the recorded
    `transaction.getData().sender == signer address` and that the client was forwarded.
  - stub returns `{$kind:'FailedTransaction', ...}` → throw (vector 5a).
  - stub returns `{$kind:'Transaction', Transaction:{effects:{status:{success:false,error}}}}`
    (digest present but Move-aborted) → throw (vector 5b — the effects-status path).
  - seq/blobIds mismatch in `input` → throw via the reused anchor guard, before signing (vector 2).
- **Monkey (rules/test.md mandatory):** random malformed env strings, random union shapes,
  oversized batch boundaries (count = 4097, seqEnd = 2^64−1).
- **No automated live testnet test** (needs gas + real key). Manual e2e steps in §7 instead,
  mirroring the Enoki Task 9 pattern.
- `pnpm typecheck` MUST be run separately — `tsx --test` does not typecheck (lessons 2026-06-14).

## 6. Risks / fallback

- **gRPC build-time resolution (shared + owned + gas) — delegated to the official path.**
  Using `Signer.signAndExecuteTransaction({ transaction, client })` means object/gas resolution
  is the `@mysten/sui` client's job, not ours; this is the supported route and removes the
  hand-rolled `tx.build` risk from Stage A §3.1. The only residual unknown is **runtime**
  behaviour over gRPC (does `GrpcCoreClient` actually resolve a shared object + select gas at
  execute time on testnet) — verified by the manual e2e in §7, not by unit tests. If it fails
  at runtime: (a) pre-read `initial_shared_version` via the gRPC client and pass an explicit
  `SharedObjectRef`; (b) flag to user for a transport decision. Do NOT hand-fabricate the ref.
  Record outcome in move-notes.
- **gas budget / reference gas price (runtime).** `signAndExecuteTransaction` lets the client
  auto-estimate gas, but testnet occasionally fails reference-gas-price fetch or budget
  estimation. If e2e surfaces a gas error, set an explicit `tx.setGasBudget(...)` (and
  `setGasPrice` if needed) before signing. Same "runtime-only, verify in §7" class as above.
- **finality vs execution.** `effects.status.success` confirms the tx *executed*, not that it
  is *checkpoint-finalized/indexed*. For audit anchors that third parties must later query,
  treat success as "executed"; finality is confirmed in §7 by observing the digest indexed on
  suiscan. Not a code concern for Stage B — an acceptance-semantics note.
- gRPC CORS is a browser concern (auditor-ui); not applicable to the node SDK.

## 7. Manual e2e (user-driven, post-merge)

1. Export a funded testnet key: `export SUI_PRIVATE_KEY=suiprivkey1...` (faucet the address first).
2. Build a real tree from fixture events; call `new AnchorClient(grpc, signerFromEnv()).anchorBatch(input, { allowMockAnchor: true })`.
3. Confirm a real digest; verify the batch object on suiscan testnet **and that the digest is
   indexed/finalized** (not merely executed — §6 finality note).
4. Record the gRPC endpoint, gas-budget quirks (§6), and shared-object resolution outcome in `move-notes.md`.

## 8. Success Criteria

- `pnpm typecheck` green.
- `signerFromEnv` round-trips a known suiprivkey to the expected address; rejects malformed
  input without leaking the key.
- `AnchorClient.anchorBatch` default-refuses mock anchors; with opt-in, produces correctly
  structured signed bytes (sender, signatures array, bytes payload) verified against a stub.
- FailedTransaction surfaced as a throw, never as a success digest.
- Red Team (`sui-red-team`) run on the submit/auth path with the 5 vectors addressed.
- Monkey tests pass.

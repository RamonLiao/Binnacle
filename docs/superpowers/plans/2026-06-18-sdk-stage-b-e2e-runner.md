# SDK Stage B e2e Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two runnable scripts that bootstrap a testnet `AgentNamespace`/`WriterCap` and anchor a real batch over gRPC, verifying Stage B spec §6 residual risk.

**Architecture:** Add `sdk/scripts/` (new, surgical — no `src/` changes). A shared `_grpc.ts` factory builds the `SuiGrpcClient` + reads/validates env. `bootstrap-namespace.ts` creates the namespace and prints the 3 IDs/version to paste into `.env`. `anchor-e2e.ts` reads the live namespace state and anchors via the existing `AnchorClient`.

**Tech Stack:** TypeScript (ESM, NodeNext), `@mysten/sui` 2.16.2 (`SuiGrpcClient`, `Transaction`), `tsx --env-file`. Spec: `docs/superpowers/specs/2026-06-18-sdk-stage-b-e2e-runner-design.md`.

> **Testing note (deliberate TDD deviation):** these are manual integration runners against live testnet — the network is the source of truth and the runner needs a funded key only the user has. So per-task verification is `pnpm typecheck` (types green) + self-review, NOT red-green unit tests. The real behavioral verification is the user's manual testnet run (TODO #11), captured in Task 5. Confirmed API shapes (from `node_modules/@mysten/sui/dist/**/*.d.mts`) are inlined below so no step guesses a shape.

**Confirmed API shapes (do not re-guess):**
- `signer.signAndExecuteTransaction({ transaction, client })` → `TransactionResult<{transaction,effects}>`: union with `$kind`; on success `.Transaction.{ digest, effects }`, on failure `.$kind==='FailedTransaction'` + `.FailedTransaction`.
- `effects.status` = `{ success: boolean, error?: ... }`. `effects.changedObjects: ChangedObject[]`, each `{ objectId: string, inputState: 'DoesNotExist'|'Exists'|'Unknown', outputOwner: ObjectOwner|null, ... }`. **Created** = `inputState==='DoesNotExist'`.
- `ObjectOwner` is a tagged union: `{$kind:'Shared', Shared:{initialSharedVersion:string}}` | `{$kind:'AddressOwner', AddressOwner:string}` | others.
- `client.core.getObject({ objectId, include:{ json:true } })` → `{ object: { objectId, version, owner: ObjectOwner, type: string, json: Record<string,unknown>|null } }`. Move struct fields read off `object.json` (e.g. `json.seq_next`, `json.last_batch_hash`). gRPC `json` field shape may vary — fail-loud if a field is missing.
- PTB helpers (all exist): `tx.moveCall({target,arguments,typeArguments})` → `TransactionResult` (destructure multi-return: `const [a,b] = tx.moveCall(...)`), `tx.makeMoveVec({type,elements})`, `tx.sharedObjectRef({objectId,mutable,initialSharedVersion})`, `tx.pure.{string,u8,u64,vector}`, `tx.transferObjects`, `tx.setGasBudget`, `tx.setSender`, `tx.object(id)`.
- SDK exports: `signerFromEnv` (`src/client/signer.ts`), `AnchorClient` (`src/client/anchorClient.ts`), `eventHash`/`buildTree` + `ComplianceEvent`/`MerkleLeaf`/`AnchorBatchInput` types (`src/core`). Verify exact export surface in `src/index.ts` before importing.

---

### Task 1: Shared gRPC + env helper

**Files:**
- Create: `sdk/scripts/_grpc.ts`

- [ ] **Step 1: Write `_grpc.ts`**

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc';

export const PACKAGE_ID =
  process.env.PACKAGE_ID ??
  '0xcb5cc62066b4bbc2e66961b48d5141f9cf3ec119e33a7f6d6ec235a1d413b14c';

export const GRPC_BASE_URL =
  process.env.GRPC_BASE_URL ?? 'https://fullnode.testnet.sui.io:443';

export function grpcClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_BASE_URL });
}

/** Fail-loud required-env reader. Never echoes the value. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (paste it into sdk/.env)`);
  return v;
}

export function suiscan(digest: string): string {
  return `https://suiscan.xyz/testnet/tx/${digest}`;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: PASS (no errors). If `SuiGrpcClient` import path errors, confirm `@mysten/sui/grpc` export against `node_modules/@mysten/sui/package.json`.

- [ ] **Step 3: Commit** — skip (not a git repo). Instead note completion in checklist.

---

### Task 2: `bootstrap-namespace.ts`

**Files:**
- Create: `sdk/scripts/bootstrap-namespace.ts`

- [ ] **Step 1: Write the script**

```ts
import { Transaction } from '@mysten/sui/transactions';
import { signerFromEnv } from '../src/client/signer.ts';
import { PACKAGE_ID, grpcClient, suiscan } from './_grpc.ts';

async function main() {
  const signer = signerFromEnv();
  const client = grpcClient();
  const sender = signer.toSuiAddress();

  const tx = new Transaction();
  // policy::new_policy(retention_epochs, encryption_mode, seal_threshold, auditor_allowlist)
  const seal = tx.moveCall({
    target: '0x1::option::none',
    typeArguments: [`${PACKAGE_ID}::policy::SealConfig`],
  });
  const allowlist = tx.makeMoveVec({ type: 'address', elements: [] });
  const policy = tx.moveCall({
    target: `${PACKAGE_ID}::policy::new_policy`,
    arguments: [tx.pure.u64(0n), tx.pure.u8(0), seal, allowlist], // enc_none() == 0
  });
  // namespace::create_namespace(agent_id, policy) -> (AdminCap, WriterCap); shares ns internally
  const [admin, writer] = tx.moveCall({
    target: `${PACKAGE_ID}::namespace::create_namespace`,
    arguments: [tx.pure.string('e2e-agent'), policy],
  });
  tx.transferObjects([admin, writer], sender);
  tx.setSender(sender);

  const result = await signer.signAndExecuteTransaction({ transaction: tx, client });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`bootstrap tx failed pre-execution: ${JSON.stringify(result.FailedTransaction)}`);
  }
  const { digest, effects } = result.Transaction;
  if (!effects.status.success) {
    throw new Error(`bootstrap aborted on-chain: ${JSON.stringify(effects.status.error)}`);
  }

  // created = inputState 'DoesNotExist'. AgentNamespace is the only Shared one; caps are AddressOwner.
  const created = effects.changedObjects.filter((c) => c.inputState === 'DoesNotExist');
  const sharedObj = created.find((c) => c.outputOwner?.$kind === 'Shared');
  if (!sharedObj || sharedObj.outputOwner?.$kind !== 'Shared') {
    throw new Error(`no shared AgentNamespace in effects: ${JSON.stringify(created)}`);
  }
  const namespaceId = sharedObj.objectId;
  const initVersion = sharedObj.outputOwner.Shared.initialSharedVersion;

  // distinguish WriterCap from AdminCap (both AddressOwner) by Move type
  const ownedIds = created
    .filter((c) => c.outputOwner?.$kind === 'AddressOwner')
    .map((c) => c.objectId);
  let writerCapId: string | undefined;
  for (const id of ownedIds) {
    const { object } = await client.core.getObject({ objectId: id, include: {} });
    if (object.type.endsWith('::namespace::WriterCap')) writerCapId = id;
  }
  if (!writerCapId) throw new Error(`no WriterCap among created owned objects: ${JSON.stringify(ownedIds)}`);

  console.log(`✅ bootstrap finalized: ${suiscan(digest)}`);
  console.log('\nPaste into sdk/.env:');
  console.log(`NAMESPACE_ID=${namespaceId}`);
  console.log(`WRITER_CAP_ID=${writerCapId}`);
  console.log(`NAMESPACE_INIT_VERSION=${initVersion}`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: PASS. Likely fixups (verify against `.d.mts`, do not guess): `effects.changedObjects`/`outputOwner` access; `getObject` `include:{}` generic; `0x1::option::none` typeArg form. Fix inline using the confirmed shapes in the header.

- [ ] **Step 3: Commit** — skip (not a git repo); mark checklist done.

---

### Task 3: `anchor-e2e.ts`

**Files:**
- Create: `sdk/scripts/anchor-e2e.ts`

- [ ] **Step 1: Write the script**

```ts
import { sha256 } from '@noble/hashes/sha256';
import { signerFromEnv } from '../src/client/signer.ts';
import { AnchorClient } from '../src/client/anchorClient.ts';
import { eventHash, buildTree } from '../src/core/index.ts';
import type { ComplianceEvent } from '../src/core/types.ts';
import { PACKAGE_ID, grpcClient, requireEnv, suiscan } from './_grpc.ts';

const GENESIS_EVENT_HASH = '0x' + '00'.repeat(32);

async function main() {
  const signer = signerFromEnv();
  const client = grpcClient();
  const namespaceId = requireEnv('NAMESPACE_ID');
  const writerCapId = requireEnv('WRITER_CAP_ID');

  // ⭐ §6 check: gRPC must resolve the shared AgentNamespace and expose its fields.
  const { object } = await client.core.getObject({ objectId: namespaceId, include: { json: true } });
  if (!object.json) throw new Error('AgentNamespace has no json content over gRPC');
  const seqNextRaw = object.json.seq_next;
  const lastHashRaw = object.json.last_batch_hash;
  if (seqNextRaw === undefined || lastHashRaw === undefined) {
    throw new Error(`unexpected namespace json shape: ${JSON.stringify(object.json)}`);
  }
  const seqNext = BigInt(seqNextRaw as string | number);
  // last_batch_hash: gRPC may render vector<u8> as number[] or 0x-hex. Normalize to Uint8Array.
  const parentBatchHash = toBytes(lastHashRaw);

  // synthetic single-leaf batch at seq = seqNext
  const event: ComplianceEvent = {
    v: 1,
    ns: namespaceId,
    run_id: '0x' + '11'.repeat(32),
    seq: seqNext,
    ts_ms: 0,
    type: 'e2e.test',
    agent: { model: 'e2e', version: '0', prompt_hash: '0x' + '00'.repeat(32) },
    input_hash: '0x' + '00'.repeat(32),
    output_hash: '0x' + '00'.repeat(32),
    payload: { note: 'stage-b e2e' },
    prev_event_hash: GENESIS_EVENT_HASH,
  };
  const eh = eventHash(event);
  const tree = buildTree([{ seq: seqNext, eventHash: eh }]);

  const runId = sha256(new TextEncoder().encode('e2e-run')); // fixed 32-byte
  const mockBlobId = sha256(new TextEncoder().encode('mock-blob')); // non-empty 32-byte

  const result = await new AnchorClient(client, signer).anchorBatch({
    packageId: PACKAGE_ID,
    namespaceId,
    writerCapId,
    runId,
    seqStart: seqNext,
    seqEnd: seqNext,
    merkleRoot: tree.root,
    blobIds: [mockBlobId],
    parentBatchHash,
  });

  console.log(`✅ anchor finalized at seq ${seqNext}: ${suiscan(result.digest)}`);
}

/** vector<u8> from gRPC json: number[] | 0x-hex string | empty. */
function toBytes(v: unknown): Uint8Array {
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (typeof v === 'string') {
    const hex = v.startsWith('0x') ? v.slice(2) : v;
    if (hex.length === 0) return new Uint8Array(0);
    return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  }
  throw new Error(`cannot decode vector<u8> from ${JSON.stringify(v)}`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 2: Verify imports resolve**

Confirm `eventHash`/`buildTree` are re-exported from `src/core/index.ts` and `@noble/hashes` is an installed (transitive) dep — `ls sdk/node_modules/@noble/hashes`. If absent, replace `sha256(...)` runId/blobId with two fixed 32-byte literals (`Uint8Array.from({length:32},(_,i)=>i+1)` etc.) and drop the import.

- [ ] **Step 3: Typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: PASS. Fix `object.json` indexing / `BigInt` coercion inline if strict mode complains.

- [ ] **Step 4: Commit** — skip (not a git repo); mark checklist done.

---

### Task 4: Docs — `.env.example` + run instructions

**Files:**
- Modify: `sdk/.env.example`
- Create: `sdk/scripts/README.md`

- [ ] **Step 1: Add the new vars to `sdk/.env.example`**

Append after `ALLOW_MOCK_ANCHOR`:

```
# Filled by bootstrap-namespace.ts output (anchor-e2e reads these):
NAMESPACE_ID=0x...
WRITER_CAP_ID=0x...
NAMESPACE_INIT_VERSION=        # only needed for §6 explicit-shared-ref fallback
# Optional overrides:
# PACKAGE_ID=0xcb5cc6...
# GRPC_BASE_URL=https://fullnode.testnet.sui.io:443
```

- [ ] **Step 2: Write `sdk/scripts/README.md`**

```markdown
# Stage B testnet e2e runners

Prereq: `sdk/.env` has a funded testnet `SUI_PRIVATE_KEY` + `ALLOW_MOCK_ANCHOR=true`.
Fund at https://faucet.sui.io/ ; export key via `sui keytool export --key-identity <addr>`.

1. Bootstrap (once):
   `cd sdk && pnpm dlx tsx --env-file=.env scripts/bootstrap-namespace.ts`
   Paste the printed `NAMESPACE_ID` / `WRITER_CAP_ID` / `NAMESPACE_INIT_VERSION` into `.env`.

2. Anchor (repeatable):
   `cd sdk && pnpm dlx tsx --env-file=.env scripts/anchor-e2e.ts`
   Each run advances seq + batch-hash chain (reads live namespace state).

§6 fallbacks (if a run fails): see
`docs/superpowers/specs/2026-06-18-sdk-stage-b-e2e-runner-design.md` §7 —
shared-object-ref (`tx.sharedObjectRef({objectId,initialSharedVersion,mutable:true})`)
and explicit `tx.setGasBudget(...)`.
```

- [ ] **Step 3: Typecheck whole package**

Run: `cd sdk && pnpm typecheck`
Expected: PASS. Confirms scripts/ compiles with the rest.

- [ ] **Step 4: Commit** — skip (not a git repo); mark checklist done.

---

### Task 5: Update progress + hand off to user e2e

**Files:**
- Modify: `tasks/progress.md` (TODO #11 — add "runner DONE, ready for user run")
- Modify: `move-notes.md` (note: leave a placeholder section for user to record gRPC endpoint/gas quirks/outcome after their run)

- [ ] **Step 1: Mark runner complete** in `tasks/progress.md` TODO #11 (code side done; user manual run + §6 verification still open).

- [ ] **Step 2: Add a "Stage B e2e run log (TBD by user)" stub** in `move-notes.md` for the user to fill: endpoint used, gas budget/ref price, whether gRPC auto-resolved shared+owned (or which §6 fallback was needed), final digests.

- [ ] **Step 3: Hand off** — tell the user the exact two commands (from `scripts/README.md`) to run after pasting their funded key into `sdk/.env`.

---

## Self-Review

- **Spec coverage:** §3 env → Task 4; §4 bootstrap (incl. initialSharedVersion print) → Task 2; §5 anchor (read shared ns, real merkle, mock blob) → Task 3; §6 fail-loud + fallbacks → covered in code + README/Task 5 + spec §7; §7 risks → header "confirmed shapes" + inline fixup notes; §8 out-of-scope → respected (no Walrus/AdminCap/multi-leaf). ✓
- **Placeholder scan:** all code blocks complete; the only "TBD" is the user-filled run log in Task 5 (correct — it's the user's observed data, not implementer's). ✓
- **Type consistency:** `AnchorBatchInput` fields match `src/core/types.ts`; `signAndExecuteTransaction`/`getObject`/`changedObjects`/`SharedOwner.Shared.initialSharedVersion` match confirmed `.d.mts` shapes; `eventHash`/`buildTree`/`ComplianceEvent` match `src/core`. ✓
```

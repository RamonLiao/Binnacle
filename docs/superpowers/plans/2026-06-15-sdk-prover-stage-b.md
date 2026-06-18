# SDK Stage B (Signer + Submit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `client` layer to `sdk/` so a caller can load a keypair from env, sign a Stage-A anchor `Transaction`, and submit it to testnet over gRPC — producing a real on-chain anchor digest, gated behind a mock-anchor guard.

**Architecture:** Two new files under `sdk/src/client/`. `signer.ts` decodes a `suiprivkey` bech32 from `SUI_PRIVATE_KEY` into a `@mysten/sui` `Signer`. `anchorClient.ts` wraps a `SuiGrpcClient` + `Signer`; `anchorBatch()` reuses Stage A `buildAnchorTx`, sets sender, then calls the SDK's own `Signer.signAndExecuteTransaction({transaction, client})` (which builds/resolves/signs/submits and returns effects), and fail-louds on `$kind==='FailedTransaction'` or `effects.status.success===false`. `core`/`tx` untouched.

**Tech Stack:** TypeScript (NodeNext, strict), `@mysten/sui` 2.17.0 (`keypairs/ed25519|secp256k1|secp256r1`, `cryptography`, `grpc`), `tsx --test` runner.

**Spec:** `docs/superpowers/specs/2026-06-15-sdk-prover-stage-b-design.md`

---

## File Structure

- Create: `sdk/src/client/signer.ts` — `signerFromEnv(env?)` → `Signer`. Sole responsibility: env → keypair, fail-loud.
- Create: `sdk/src/client/anchorClient.ts` — `AnchorClient` class + `AnchorOpts`. Sole responsibility: gate + sign + submit + verify effects.
- Create: `sdk/src/client/index.ts` — re-export `signer` + `anchorClient`.
- Modify: `sdk/src/index.ts` — add `export * from './client/index.ts'`.
- Create: `sdk/test/signer.test.ts`
- Create: `sdk/test/anchorClient.test.ts`

Verified type facts (grepped from `sdk/node_modules/@mysten/sui/dist`, 2.17.0 — do not re-derive):
- `decodeSuiPrivateKey(value: string): { scheme: SignatureScheme; secretKey: Uint8Array }` — field is **`scheme`**, not `schema`.
- `SignatureScheme = 'ED25519' | 'Secp256k1' | 'Secp256r1' | 'MultiSig' | 'ZkLogin' | 'Passkey'`.
- `Ed25519Keypair.fromSecretKey(secretKey: Uint8Array | string, options?)` (same for Secp256k1/Secp256r1).
- `Signer.toSuiAddress(): string`.
- `Signer.signAndExecuteTransaction({ transaction: Transaction; client: ClientWithCoreApi }): Promise<TransactionResult<{transaction:true;effects:true}>>`.
- `TransactionResult = {$kind:'Transaction', Transaction:T} | {$kind:'FailedTransaction', FailedTransaction:T}` where `T` has `digest: string` and `effects: { status: ExecutionStatus }`.
- `ExecutionStatus = {success:true; error:null} | {success:false; error: ExecutionError}`.
- `SuiGrpcClient` (from `@mysten/sui/grpc`) `extends BaseClient`, has `core: GrpcCoreClient` → assignable to `ClientWithCoreApi`.

Import paths (NodeNext, `.ts` extensions per existing sdk style — see `anchor.ts` importing `'../core/types.ts'`):
- `import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';`
- `import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';`
- `import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';`
- `import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';`
- `import type { Signer } from '@mysten/sui/cryptography';`
- `import type { ClientWithCoreApi } from '@mysten/sui/client';`
- `import { buildAnchorTx } from '../tx/anchor.ts';`
- `import type { AnchorBatchInput } from '../core/types.ts';`

---

## Task 1: `signerFromEnv`

**Files:**
- Create: `sdk/src/client/signer.ts`
- Test: `sdk/test/signer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// sdk/test/signer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { signerFromEnv } from '../src/client/signer.ts';

// A deterministic Ed25519 keypair → its suiprivkey + address, generated once for the test.
const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
const VALID_KEY = kp.getSecretKey();          // 'suiprivkey1...'
const EXPECTED_ADDR = kp.toSuiAddress();

test('decodes a valid suiprivkey to the correct address', () => {
  const signer = signerFromEnv({ SUI_PRIVATE_KEY: VALID_KEY } as NodeJS.ProcessEnv);
  assert.equal(signer.toSuiAddress(), EXPECTED_ADDR);
});

test('throws when SUI_PRIVATE_KEY is missing', () => {
  assert.throws(() => signerFromEnv({} as NodeJS.ProcessEnv), /SUI_PRIVATE_KEY/);
});

test('throws on a non-bech32 / malformed key', () => {
  assert.throws(() => signerFromEnv({ SUI_PRIVATE_KEY: 'not-a-key' } as NodeJS.ProcessEnv));
});

test('error never echoes the raw key value (no partial-key leak)', () => {
  const secret = 'suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz';
  try {
    signerFromEnv({ SUI_PRIVATE_KEY: secret } as NodeJS.ProcessEnv);
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(!(e as Error).message.includes(secret), 'message must not contain the key');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && pnpm tsx --test test/signer.test.ts`
Expected: FAIL — cannot find module `../src/client/signer.ts` (not created yet).

- [ ] **Step 3: Write minimal implementation**

```typescript
// sdk/src/client/signer.ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import type { Signer } from '@mysten/sui/cryptography';

/**
 * Build a Signer from `SUI_PRIVATE_KEY` (a `suiprivkey1...` bech32 string).
 * Fail-loud on missing / malformed / unsupported-scheme. Never echoes the key value.
 */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env): Signer {
  const raw = env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('SUI_PRIVATE_KEY is not set');

  let parsed: { scheme: string; secretKey: Uint8Array };
  try {
    parsed = decodeSuiPrivateKey(raw);
  } catch {
    // Swallow the original error: it can include the decoded bytes. Re-throw a clean message.
    throw new Error('SUI_PRIVATE_KEY is not a valid suiprivkey bech32 string');
  }

  switch (parsed.scheme) {
    case 'ED25519':
      return Ed25519Keypair.fromSecretKey(parsed.secretKey);
    case 'Secp256k1':
      return Secp256k1Keypair.fromSecretKey(parsed.secretKey);
    case 'Secp256r1':
      return Secp256r1Keypair.fromSecretKey(parsed.secretKey);
    default:
      throw new Error(`unsupported key scheme: ${parsed.scheme}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && pnpm tsx --test test/signer.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: no errors. (`tsx --test` does not typecheck — lessons 2026-06-14. If `parsed`'s type from `decodeSuiPrivateKey` is wider/narrower than annotated, fix the annotation to match the real return type rather than casting.)

---

## Task 2: `AnchorClient.anchorBatch` — mock guard + happy path

**Files:**
- Create: `sdk/src/client/anchorClient.ts`
- Test: `sdk/test/anchorClient.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// sdk/test/anchorClient.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';
import { AnchorClient } from '../src/client/anchorClient.ts';
import type { AnchorBatchInput } from '../src/core/types.ts';

const ADDR = '0x' + 'ab'.repeat(32);

// Minimal stub Signer: records the tx it was asked to execute, returns a canned result.
function stubSigner(result: unknown) {
  const calls: { transaction: Transaction; client: unknown }[] = [];
  const signer = {
    toSuiAddress: () => ADDR,
    signAndExecuteTransaction: async (opts: { transaction: Transaction; client: unknown }) => {
      calls.push(opts);
      return result;
    },
  } as unknown as Signer;
  return { signer, calls };
}

const DUMMY_CLIENT = {} as never; // never touched by the stub signer

function validInput(): AnchorBatchInput {
  return {
    packageId: '0x' + '1'.repeat(64),
    namespaceId: '0x' + '2'.repeat(64),
    writerCapId: '0x' + '3'.repeat(64),
    runId: new Uint8Array(32).fill(9),
    seqStart: 0n,
    seqEnd: 1n,
    merkleRoot: new Uint8Array(32).fill(1),
    blobIds: [new Uint8Array([1]), new Uint8Array([2])],
    parentBatchHash: new Uint8Array(0),
  };
}

const okResult = {
  $kind: 'Transaction' as const,
  Transaction: { digest: 'DIGEST123', effects: { status: { success: true, error: null } } },
};

test('refuses to anchor mock data by default (no allowMockAnchor)', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  await assert.rejects(() => client.anchorBatch(validInput()), /mock anchor blocked/);
  assert.equal(calls.length, 0, 'signer must not be called when blocked');
});

test('with allowMockAnchor:true, returns the digest and sets sender to signer address', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const { digest } = await client.anchorBatch(validInput(), { allowMockAnchor: true });
  assert.equal(digest, 'DIGEST123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.transaction.getData().sender, ADDR);
  assert.equal(calls[0]!.client, DUMMY_CLIENT, 'client forwarded to signer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && pnpm tsx --test test/anchorClient.test.ts`
Expected: FAIL — cannot find module `../src/client/anchorClient.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// sdk/src/client/anchorClient.ts
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { buildAnchorTx } from '../tx/anchor.ts';
import type { AnchorBatchInput } from '../core/types.ts';

export interface AnchorOpts {
  /** Allow anchoring while Walrus blobIds are still mocked. Default: ALLOW_MOCK_ANCHOR env. */
  allowMockAnchor?: boolean;
}

export class AnchorClient {
  constructor(
    private readonly client: ClientWithCoreApi,
    private readonly signer: Signer,
  ) {}

  async anchorBatch(input: AnchorBatchInput, opts?: AnchorOpts): Promise<{ digest: string }> {
    // ── mock-anchor guard (Rule-12; refuse to anchor fake commitments by default) ──
    const allow = opts?.allowMockAnchor ?? (process.env.ALLOW_MOCK_ANCHOR === 'true');
    if (!allow) {
      throw new Error(
        'mock anchor blocked: pass allowMockAnchor or set ALLOW_MOCK_ANCHOR=true',
      );
    }

    const tx = buildAnchorTx(input); // reuses all Stage A fail-loud guards
    tx.setSender(this.signer.toSuiAddress());

    const result = await this.signer.signAndExecuteTransaction({
      transaction: tx,
      client: this.client,
    });

    if (result.$kind === 'FailedTransaction') {
      throw new Error(`anchor tx failed before execution: ${JSON.stringify(result.FailedTransaction)}`);
    }
    const status = result.Transaction.effects.status;
    if (!status.success) {
      throw new Error(`anchor tx aborted on-chain: ${JSON.stringify(status.error)}`);
    }
    return { digest: result.Transaction.digest };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && pnpm tsx --test test/anchorClient.test.ts`
Expected: PASS (2/2 so far).

- [ ] **Step 5: Typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: no errors. If `result` union access complains, confirm against `client/types.d.mts` `TransactionResult` that `effects` is present (the signer overload pins `{transaction:true; effects:true}`). Do not add `any` — narrow on `$kind`.

- [ ] **Step 6: Commit**

```bash
git add sdk/src/client/signer.ts sdk/src/client/anchorClient.ts sdk/test/signer.test.ts sdk/test/anchorClient.test.ts
git commit -m "feat(sdk): Stage B client — signerFromEnv + AnchorClient guard/happy path"
```

(If the working tree is not a git repo, skip the commit step and note it.)

---

## Task 3: Fail-loud on FailedTransaction + on-chain abort (vectors 5a/5b/3)

**Files:**
- Modify: `sdk/test/anchorClient.test.ts` (append tests; implementation already handles these in Task 2)

- [ ] **Step 1: Write the failing tests (append)**

```typescript
// append to sdk/test/anchorClient.test.ts

test('throws when execution returns FailedTransaction (vector 5a)', async () => {
  const failed = { $kind: 'FailedTransaction' as const, FailedTransaction: { digest: 'X' } };
  const { signer } = stubSigner(failed);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  await assert.rejects(
    () => client.anchorBatch(validInput(), { allowMockAnchor: true }),
    /failed before execution/,
  );
});

test('throws when effects.status.success is false — Move abort with a digest (vector 5b)', async () => {
  const aborted = {
    $kind: 'Transaction' as const,
    Transaction: {
      digest: 'ABORTED_DIGEST',
      effects: { status: { success: false, error: { kind: 'MoveAbort', code: 7 } } },
    },
  };
  const { signer } = stubSigner(aborted);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  await assert.rejects(
    () => client.anchorBatch(validInput(), { allowMockAnchor: true }),
    /aborted on-chain/,
  );
});

test('seq/blobIds mismatch throws via the reused anchor guard, before signing (vector 2)', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const bad = validInput();
  bad.blobIds = [new Uint8Array([1])]; // length 1 != count 2
  await assert.rejects(
    () => client.anchorBatch(bad, { allowMockAnchor: true }),
    /blobIds length/,
  );
  assert.equal(calls.length, 0, 'must fail before reaching the signer');
});
```

- [ ] **Step 2: Run tests**

Run: `cd sdk && pnpm tsx --test test/anchorClient.test.ts`
Expected: PASS (5/5) — Task 2's implementation already covers these branches; this task locks them with tests.

- [ ] **Step 3: Commit**

```bash
git add sdk/test/anchorClient.test.ts
git commit -m "test(sdk): Stage B fail-loud — FailedTransaction, on-chain abort, guard pre-empt"
```

---

## Task 4: Monkey tests (rules/test.md mandatory)

**Files:**
- Modify: `sdk/test/anchorClient.test.ts` and `sdk/test/signer.test.ts` (append)

- [ ] **Step 1: Write monkey tests (append)**

```typescript
// append to sdk/test/signer.test.ts
test('monkey: random malformed env strings never crash uncaught and never leak input', () => {
  const garbage = ['', '   ', 'suiprivkey1', '0xdeadbeef', 'suiprivkey1' + 'z'.repeat(200), '  '];
  for (const g of garbage) {
    try {
      signerFromEnv({ SUI_PRIVATE_KEY: g } as NodeJS.ProcessEnv);
    } catch (e) {
      assert.ok(e instanceof Error);
      if (g.length > 0) assert.ok(!(e as Error).message.includes(g), `leaked: ${g}`);
    }
  }
});
```

```typescript
// append to sdk/test/anchorClient.test.ts
test('monkey: oversized batch (count 4097) rejected before signing', async () => {
  const { signer, calls } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const bad = validInput();
  bad.seqStart = 0n;
  bad.seqEnd = 4096n; // count = 4097 > BATCH_MAX_EVENTS
  bad.blobIds = Array.from({ length: 4097 }, () => new Uint8Array([1]));
  await assert.rejects(() => client.anchorBatch(bad, { allowMockAnchor: true }), /exceeds BATCH_MAX_EVENTS/);
  assert.equal(calls.length, 0);
});

test('monkey: seqEnd = 2^64-1 boundary rejected before signing', async () => {
  const { signer } = stubSigner(okResult);
  const client = new AnchorClient(DUMMY_CLIENT, signer);
  const bad = validInput();
  bad.seqEnd = 0xffff_ffff_ffff_ffffn;
  await assert.rejects(() => client.anchorBatch(bad, { allowMockAnchor: true }), /2\^64-1|exceeds/);
});
```

- [ ] **Step 2: Run all tests**

Run: `cd sdk && pnpm test`
Expected: PASS — all prior tests (38 from Stage A) + new Stage B tests green.

- [ ] **Step 3: Typecheck**

Run: `cd sdk && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add sdk/test/signer.test.ts sdk/test/anchorClient.test.ts
git commit -m "test(sdk): Stage B monkey tests — malformed env, batch boundaries"
```

---

## Task 5: Wire up public exports

**Files:**
- Create: `sdk/src/client/index.ts`
- Modify: `sdk/src/index.ts`

- [ ] **Step 1: Write the client barrel**

```typescript
// sdk/src/client/index.ts
export { signerFromEnv } from './signer.ts';
export { AnchorClient } from './anchorClient.ts';
export type { AnchorOpts } from './anchorClient.ts';
```

- [ ] **Step 2: Read the existing root index, then add the client export**

Run: `cat sdk/src/index.ts`
Then add the line `export * from './client/index.ts';` alongside the existing core/tx exports (match the file's existing export style — do not reorder or restyle existing lines).

- [ ] **Step 3: Verify the public surface imports cleanly**

```typescript
// (temporary smoke — delete after) sdk/test/exports.smoke.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signerFromEnv, AnchorClient } from '../src/index.ts';
test('public surface exports client', () => {
  assert.equal(typeof signerFromEnv, 'function');
  assert.equal(typeof AnchorClient, 'function');
});
```

Run: `cd sdk && pnpm tsx --test test/exports.smoke.test.ts && rm sdk/test/exports.smoke.test.ts`
Expected: PASS, then file removed.

- [ ] **Step 4: Full typecheck + test**

Run: `cd sdk && pnpm typecheck && pnpm test`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/client/index.ts sdk/src/index.ts
git commit -m "feat(sdk): export Stage B client surface"
```

---

## Task 6: Red Team (sui-red-team skill — core 金流/auth path)

**Not a code task — a review gate.** Per `.claude/rules/skill-routing.md`, the submit/auth path is core 金流, so run the `sui-red-team` skill against `signer.ts` + `anchorClient.ts` with the 5 spec vectors:

1. Mock data anchored on-chain → guard default-deny.
2. seq/count mismatch / overflow → reused Stage A guards.
3. Sender ≠ WriterCap owner → `effects.status.success===false` surfaced.
4. Malformed `SUI_PRIVATE_KEY` → fail-loud, no key leak.
5. Silent submit failure → `$kind` + `effects.status` double-check.

- [ ] **Step 1:** Invoke `sui-red-team` skill on the two source files; address any new vector it surfaces with a test + fix (loop until clean).
- [ ] **Step 2:** Two-round code review per `~/.claude/rules/general/dev-rules.md`: round-1 `review.sh` (or general-purpose subagent on fallback), round-2 project skills. Integrate findings, re-run `pnpm typecheck && pnpm test`.
- [ ] **Step 3:** Update `tasks/progress.md` (Stage B done), `move-notes.md` (any chain quirks), and `tasks/lessons.md` (any new gotcha).

---

## Manual e2e (user-driven, deferred — §7 of spec)

Not in this plan's automated scope. After merge, the user runs:
1. `export SUI_PRIVATE_KEY=suiprivkey1...` (faucet the address first).
2. Build a real tree (Stage A `buildTree`) → `new AnchorClient(grpcClient, signerFromEnv()).anchorBatch(input, { allowMockAnchor: true })`.
3. Confirm a real digest on suiscan testnet.
4. **Verify the §6 residual risk**: did the gRPC client resolve the shared `AgentNamespace` + owned `WriterCap` + gas at execute time? Record the gRPC endpoint + outcome in `move-notes.md`. If it failed, apply the §6 fallback (explicit `SharedObjectRef`).

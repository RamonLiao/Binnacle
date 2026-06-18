# SDK Stage B — Manual Testnet e2e Runner (Design)

> Date: 2026-06-18
> Spec for: closing TODO #11 (SDK Stage B manual e2e) and verifying spec
> `2026-06-15-sdk-prover-stage-b-design.md` §6 residual risk.

## 1. Goal

Provide runnable scripts that exercise the Stage B `AnchorClient` /
`signerFromEnv` path against **live testnet over gRPC**, proving the §6
residual risk is resolved: does `SuiGrpcClient` resolve a **shared**
`AgentNamespace` + **owned** `WriterCap` + gas at execute time, and does a real
`anchor_batch` finalize.

Success criteria:
1. `bootstrap-namespace.ts` creates a namespace on testnet and prints a real
   `NAMESPACE_ID` (shared) + `WRITER_CAP_ID` (owned), confirmed on suiscan.
2. `anchor-e2e.ts` anchors a real batch, prints a finalized digest, and a
   repeat run advances the seq/hash chain without abort.
3. Both run via `tsx --env-file=.env scripts/<x>.ts`.

Non-goals: real Walrus (blobIds stay mock, gated by `ALLOW_MOCK_ANCHOR`);
no changes to `src/` (surgical — new `scripts/` only); no UI.

## 2. Context (verified)

- Package: `0xcb5cc62066b4bbc2e66961b48d5141f9cf3ec119e33a7f6d6ec235a1d413b14c`
  (testnet). No `AgentNamespace`/`WriterCap` exist on-chain yet.
- `namespace::create_namespace(agent_id: String, policy: PolicyObject, ctx)`
  → shares the `AgentNamespace` internally, returns `(AdminCap, WriterCap)`
  for the PTB to route to the chosen addresses (`namespace.move:44-68`).
- `policy::new_policy(retention_epochs: u64, encryption_mode: u8,
  seal_threshold: Option<SealConfig>, auditor_allowlist: vector<address>)`
  → `PolicyObject` (`policy.move:37`). `enc_none()` = 0.
- `receipt::anchor_batch(ns: &mut AgentNamespace, cap: &WriterCap, run_id,
  seq_start, seq_end, merkle_root, blob_ids, parent_batch_hash, clock)` —
  asserts `seq_start == ns.seq_next` and `parent_batch_hash == ns.last_batch_hash`.
- `AnchorClient(client: ClientWithCoreApi, signer: Signer).anchorBatch(input,
  opts)` already does build→setSender→signAndExecute→fail-loud (`anchorClient.ts`).
- `buildAnchorTx(input: AnchorBatchInput)` enforces seq/len/overflow guards
  (`tx/anchor.ts`).
- `core`: `eventHash(e)`, `buildTree(leaves)` → `{root, proof}` (`core/index.ts`).
- gRPC client reference (auditor-ui `lib/sui.ts`):
  `new SuiGrpcClient({ network: 'testnet', baseUrl:
  'https://fullnode.testnet.sui.io:443' })`. `SuiGrpcClient` satisfies
  `ClientWithCoreApi`.

## 3. Env (`sdk/.env`)

| Var | Source | Used by |
|-----|--------|---------|
| `SUI_PRIVATE_KEY` | funded testnet key, `suiprivkey1...` | both (via `signerFromEnv`) |
| `ALLOW_MOCK_ANCHOR=true` | keep until Stage C | `anchor-e2e` |
| `NAMESPACE_ID` | printed by `bootstrap` | `anchor-e2e` |
| `WRITER_CAP_ID` | printed by `bootstrap` | `anchor-e2e` |
| `NAMESPACE_INIT_VERSION` | printed by `bootstrap` (namespace `initialSharedVersion`) | `anchor-e2e` §6 fallback only |
| `PACKAGE_ID` | known testnet pkg (default in script if unset) | both |
| `GRPC_BASE_URL` | optional override (CORS/endpoint fallback) | both |

## 4. Script 1 — `scripts/bootstrap-namespace.ts`

1. `signerFromEnv()`; `grpcClient = new SuiGrpcClient({network, baseUrl})`.
2. Build PTB:
   - `const seal = tx.moveCall({ target: '0x1::option::none', typeArguments:
     [`${PKG}::policy::SealConfig`] })`
   - `const allowlist = tx.makeMoveVec({ type: 'address', elements: [] })`
   - `const policy = tx.moveCall({ target: `${PKG}::policy::new_policy`,
     arguments: [tx.pure.u64(0n), tx.pure.u8(0), seal, allowlist] })`
   - `const [admin, writer] = tx.moveCall({ target:
     `${PKG}::namespace::create_namespace`, arguments:
     [tx.pure.string('e2e-agent'), policy] })`
   - `tx.transferObjects([admin, writer], signer.toSuiAddress())`
3. `setSender`, sign + execute over gRPC (same call shape as `AnchorClient`:
   `signer.signAndExecuteTransaction({ transaction: tx, client: grpcClient })`).
4. Fail-loud on `$kind === 'FailedTransaction'` or `effects.status.success !== true`.
5. From the result's created objects, match by Move type suffix:
   - `::namespace::AgentNamespace` → shared → `NAMESPACE_ID`
   - `::namespace::WriterCap` → owned → `WRITER_CAP_ID`
   Print both + the digest + suiscan link. (AdminCap ignored — not needed for anchor.)
6. Also read + print the `AgentNamespace` `initialSharedVersion` (from the
   created-object info / a follow-up `getObject`) as `NAMESPACE_INIT_VERSION`.
   Needed only for the §6 explicit-shared-ref fallback; the happy path uses
   bare `tx.object(NAMESPACE_ID)`.

⭐ Proves gRPC resolves an owned cap + gas and executes a value-bearing tx.

## 5. Script 2 — `scripts/anchor-e2e.ts`

1. `signerFromEnv()`; gRPC client; read `NAMESPACE_ID`/`WRITER_CAP_ID`
   (fail-loud if unset).
2. **gRPC read the shared `AgentNamespace`** to get `seq_next` (u64) and
   `last_batch_hash` (vector<u8>). ⭐ This is the direct §6 "resolve shared
   object" check. Parse the Move struct fields from the object's contents.
3. Build a synthetic `ComplianceEvent` with `seq = seq_next`, deterministic
   fields (fixed model/version/prompt_hash, `prev_event_hash` = genesis
   `0x`+`00`*32). Compute `eventHash(e)` → `buildTree([{seq, eventHash}])`
   → `root`.
4. `AnchorBatchInput`:
   - `packageId`, `namespaceId`, `writerCapId`, `clockId='0x6'`
   - `runId` = fixed 32-byte (e.g. sha256 of `'e2e-run'`)
   - `seqStart = seqEnd = seq_next`
   - `merkleRoot = root`
   - `blobIds = [mock 32-byte]` (count must equal seq range = 1)
   - `parentBatchHash = last_batch_hash` (empty on genesis)
5. `new AnchorClient(grpcClient, signer).anchorBatch(input)` → print digest +
   suiscan link. (Mock-anchor allowed via `ALLOW_MOCK_ANCHOR` env.)
6. Repeat runs read fresh `seq_next`/`last_batch_hash`, so seq + hash chain
   advance — no replay/gap abort.

## 6. Error handling

Reuse existing fail-loud: `signerFromEnv` (missing/bad key),
`buildAnchorTx` (seq/len/overflow), `anchorBatch` (FailedTransaction /
`effects.status.success === false` → throws with abort error). Scripts add
fail-loud env guards (missing `NAMESPACE_ID` etc.) and print the suiscan URL
only after a confirmed-success effect.

## 7. Implementation risks (grep `.d.mts` before coding — per lessons)

1. **executeTransaction effects shape** — exact field for created objects +
   their Move type string. Verify against
   `node_modules/@mysten/sui/dist/grpc/index.d.mts` and the
   `signAndExecuteTransaction` return union before parsing.
2. **gRPC object read API** — which method (`grpcClient.core.getObject`?) and
   how Move struct fields (`seq_next`, `last_batch_hash`) surface in the
   response. Verify types first; do not trust this design's method names.
3. **PTB helpers** — confirm `tx.makeMoveVec({type:'address', elements:[]})`
   and `0x1::option::none` typeArg form against installed `@mysten/sui`
   transactions types.

### §6 runtime fallbacks (SUI object-model / gRPC quirks)

- **Shared object not auto-resolved** → replace `tx.object(NAMESPACE_ID)` with
  `tx.sharedObjectRef({ objectId: NAMESPACE_ID, initialSharedVersion:
  NAMESPACE_INIT_VERSION, mutable: true })`. `anchor_batch` takes `&mut
  AgentNamespace`, so `mutable: true` is required; `initialSharedVersion` comes
  from bootstrap (hence the extra env var). Verify the exact PTB method name
  (`sharedObjectRef` vs `objectRef`) against installed transactions types.
- **Gas estimation fails over gRPC** (auto dry-run / ref-gas-price quirk, §6) →
  set explicit `tx.setGasBudget(<n>)` before sign. Note the working budget +
  ref gas price in move-notes.
- **read-after-write** (minor) — `anchor-e2e` reads the shared `AgentNamespace`
  created by a prior `bootstrap` tx. Across two manual runs it is already
  finalized; if scripted back-to-back, allow for fullnode sync lag
  (`effects.status.success` = executed, not yet indexed/finalized).

Record outcome + endpoint/gas quirks in `move-notes.md`.

## 8. Out of scope

Real Walrus (Stage C), AdminCap-gated flows (seal/policy update), multi-leaf
batches, the auditor-ui browser e2e (TODO #8).

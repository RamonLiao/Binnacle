# ComplianceVault — Auditor UI Spec (for implementation)

> Target: `apps/auditor-ui/` — Next.js dApp for auditors.
> Status: v1.0 (2026-05-31). Derived from `docs/specs/2026-05-28-compliance-vault-spec.md` v0.2 + `move-notes.md`.
> Audience: implementer (Gemini). This is the contract. Do NOT invent contract ABIs or event shapes — they are fixed below.

---

## 0. Scope / non-goals

**Build:** the auditor-side web app. zkLogin auth → list engagements → browse a namespace's anchored batches → verify event inclusion → Seal-decrypt scoped events → file a signed attestation.

**Do NOT build:** the customer/agent SDK, the Move contracts (done), the indexer (Claude is building it in parallel — you consume its REST API, defined in §6). No write path for agents.

**Network:** Sui **testnet**. JSON-RPC is forbidden (deprecated). Use gRPC/GraphQL via `@mysten/sui` v2.x client for on-chain reads; use the indexer REST API for lists/aggregations.

---

## 1. Stack (pinned — do not deviate)

| Dep | Version | Why |
|---|---|---|
| `next` | ^15 (App Router) | — |
| `react` / `react-dom` | ^18 | — |
| `typescript` | ^5 | strict mode on |
| `@mysten/sui` | **^2.16.2** | v2.x client (NOT 1.x). Used by Seal peer dep. |
| `@mysten/dapp-kit` | latest compatible with sui 2.x | wallet/query provider |
| `@mysten/seal` | **^1.1** | `SealClient` instantiated **directly**, NOT via `$extend()` |
| `@tanstack/react-query` | ^5 | dapp-kit peer |
| zkLogin | via `@mysten/sui/zklogin` | Google OAuth → Sui address |
| Tailwind + shadcn/ui | latest | styling; clean, dense, data-table-heavy auditor aesthetic |

**Hard rule:** never mix `@mysten/sui` 1.x and 2.x. Everything on 2.x.

---

## 2. Contract ABI (fixed — read from env `NEXT_PUBLIC_PACKAGE_ID`)

Package: `compliance_vault`. All type/fn refs are `${PACKAGE_ID}::<module>::<name>`.
Shared/frozen object IDs come from the indexer or env; see §6.

### Objects the UI reads
- `namespace::AgentNamespace` **[shared]** — fields: `agent_id: String`, `seq_next: u64`, `batch_index: u64`, `last_batch_hash: vector<u8>`, `sealed: bool`, `policy: PolicyObject`.
- `engagement::EngagementObject` **[shared]** — `namespace_id: ID`, `auditor_addr: address`, `auditor_pubkey: vector<u8>`, `scope_start_ms: u64`, `scope_end_ms: u64`, `event_type_filter: vector<String>` (empty = all), `expires_at_ms: u64`, `revoked: bool`.
- `receipt::BatchReceipt` **[frozen]** — `namespace_id`, `run_id`, `batch_index`, `seq_start`, `seq_end`, `merkle_root: vector<u8>`, `blob_ids_digest: vector<u8>`, `parent_batch_hash`, `batch_hash`, `created_at_ms`, `created_epoch`.
- `attestation::AuditorAttestation` **[frozen]** — `engagement_id`, `report_blob_id`, `report_hash`, `cited_batch_ids: vector<ID>`, `signed_at_ms`.

### Functions the UI calls (Move call in a PTB)
- **Verify (read, anyone, via `devInspect`):**
  `receipt::verify_event_inclusion(receipt: &BatchReceipt, seq: u64, event_hash: vector<u8>, merkle_proof: vector<vector<u8>>): bool`
  → call with `devInspectTransactionBlock`; parse the returned bool. **Off-chain, no gas.**
- **File attestation (write, auditor signs):**
  `attestation::file_attestation(eng: &EngagementObject, report_blob_id: vector<u8>, report_hash: vector<u8>, cited_batch_ids: vector<ID>, clock: &Clock, ctx)`
  → sender MUST equal `eng.auditor_addr`; aborts if revoked/expired. `clock = 0x6`.
- **Seal gate (dry-run only, never executed):**
  `seal_policy::seal_approve(id: vector<u8>, eng: &EngagementObject, requested_event_type: String, requested_ts_ms: u64, clock: &Clock, ctx)`
  → built into the `onlyTransactionKind` PTB handed to `SealClient.fetchKeys`. See §5.

The UI never calls `anchor_batch`, `mint_engagement`, `create_namespace`, `update_policy`, `revoke_engagement` (admin/writer-only).

---

## 3. Pages / routes

| Route | Purpose |
|---|---|
| `/` | Landing + zkLogin "Sign in with Google" (auditor auth). |
| `/engagements` | List engagements where `auditor_addr == myAddress`. Card per engagement: namespace `agent_id`, scope window, expiry countdown, revoked badge, event-type filter chips. |
| `/ns/[engagementId]` | Namespace dashboard: header (agent_id, seq_next, batch_index, sealed badge, chain-head hash). Receipts timeline table (batch_index, seq range, created_at, batch_hash, parent link). Coverage-gap banner if indexer reports gaps. |
| `/ns/[engagementId]/batch/[batchId]` | Batch detail: receipt fields, full `blob_ids` list (from indexer event), per-event list. Each event row → "Verify inclusion" (devInspect) + "Decrypt" (Seal, only if within scope & type filter & not expired/revoked). |
| `/ns/[engagementId]/attest` | Compose attestation: pick cited batches, upload/sign report → Walrus → `file_attestation` tx. Show resulting frozen attestation ID + explorer link. |

Gate `/ns/*` and `/attest` behind a valid zkLogin session AND a non-revoked, non-expired engagement for that auditor address. If the engagement is revoked/expired, render read-only metadata, disable Decrypt + Attest, show why.

---

## 4. zkLogin flow

- Provider: **Google** (OAuth). Ephemeral keypair + nonce per session, JWT → Sui address per `@mysten/sui/zklogin` (`jwtToAddress`, `genAddressSeed`, `getZkLoginSignature`).
- Salt: use a dev salt service or a fixed local salt for the hackathon (document the choice in README). The derived address is the auditor identity matched against `EngagementObject.auditor_addr`.
- Persist ephemeral key + maxEpoch + randomness in session storage; re-prove on expiry. Prover: Mysten dev prover endpoint (testnet).
- The zkLogin address is the **sender** for `file_attestation` and the **session-key address** Seal injects when dry-running `seal_approve` (so `ctx.sender() == eng.auditor_addr` holds — B3).

---

## 5. Seal decryption flow (k=2, n=3)

This is the core auditor capability. Mirror exactly:

1. **Encrypt-time identity:** blobs were encrypted with IBE `id = <namespace_id> bytes` (each namespace = its own key domain). So decryption requests use the **same** `id` = the engagement's `namespace_id` bytes.
2. **Client:** `new SealClient({ suiClient, serverConfigs })` — **direct instantiation, NOT `$extend()`**. `serverConfigs` = three entries, each `{ objectId: <key server OBJECT id>, weight: 1 }`. Threshold `2`. Key server object IDs come from the namespace's `PolicyObject.seal_threshold.key_server_ids` (read on-chain) or env fallback.
3. **Session key:** create a Seal `SessionKey` for the auditor's zkLogin address; user signs the personal-message challenge once per session.
4. **Build the gate PTB** (`onlyTransactionKind: true`, never executed):
   `seal_policy::seal_approve(id, eng, requested_event_type, requested_ts_ms, clock)` — `id` = namespace_id bytes, `requested_event_type` = the event's `type`, `requested_ts_ms` = the event's `ts_ms`. The key servers dry-run this; **no abort → release shares**.
5. `SealClient.fetchKeys` / `decrypt` with the encrypted blob bytes (fetched from Walrus by `blob_id`).
6. **Deny handling:** a `seal_approve` abort surfaces as a fetch error. Map abort codes → human messages: `E_SCOPE_MISMATCH(8)` = "outside your scope/type filter or wrong identity", `E_ENGAGEMENT_EXPIRED(6)`, `E_ENGAGEMENT_REVOKED(7)`. Never silently show empty — say *why* access was denied (fail loud).

Walrus reads: fetch blob bytes by `blob_id` from a Walrus aggregator (testnet aggregator URL in env `NEXT_PUBLIC_WALRUS_AGGREGATOR`).

---

## 6. Indexer REST API (provided by Claude — this is the integration contract)

Base URL in env `NEXT_PUBLIC_INDEXER_URL` (default `http://localhost:3001`). All responses JSON. Bytes are `0x`-prefixed hex strings. IDs are Sui object-ID hex strings.

```
GET /health → { ok: true, lastCheckpoint: <number> }

GET /engagements?auditor=<address>
  → [{ engagementId, namespaceId, agentId, auditorAddr, auditorPubkey,
       scopeStartMs, scopeEndMs, eventTypeFilter: string[], expiresAtMs,
       revoked, mintedAtMs }]

GET /namespaces/:namespaceId
  → { namespaceId, agentId, owner, seqNext, batchIndex, lastBatchHash,
      sealed, batchCount, lastAnchorMs }

GET /namespaces/:namespaceId/batches?limit=&cursor=
  → { items: [{ batchId, namespaceId, runId, seqStart, seqEnd, merkleRoot,
                batchHash, parentBatchHash, blobIds: string[], anchoredAtMs }],
      nextCursor }

GET /batches/:batchId
  → { batchId, namespaceId, runId, seqStart, seqEnd, merkleRoot, batchHash,
      parentBatchHash, blobIds: string[], anchoredAtMs }
  // blobIds is the authoritative full list (E2 — rides the BatchAnchored event,
  // not stored on-chain). Index i corresponds to event seq = seqStart + i.

GET /namespaces/:namespaceId/coverage
  → { gaps: [{ expected, observed, atMs }], lastObservedSeq, healthy: boolean }

GET /attestations?engagementId=<id>
  → [{ attestationId, engagementId, reportHash, citedBatchIds: string[], signedAtMs }]
```

The indexer is the **authoritative source for `blobIds`** per batch (E2). On-chain only stores `blob_ids_digest`. The UI may optionally re-verify: `sha256(bcs(blobIds)) == receipt.blob_ids_digest`.

---

## 7. Client-side Merkle verification (mirror the hardened on-chain scheme EXACTLY)

`/batch/[batchId]` lets an auditor re-verify any event without trusting the server. The event hash is `event_hash = sha256(canonical_event_bytes)` (the SDK's per-event hash; for the UI, treat the indexer-provided/blob-derived `event_hash` as given). Build proofs and roots to match `receipt.move`:

```
leaf(seq, event_hash)   = sha256( 0x00 || bcs_le_u64(seq) || event_hash )
internal(a, b)          = sha256( 0x01 || min(a,b) || max(a,b) )   // lexicographic, NO direction bits
single-leaf root        = leaf(seq, event_hash)                     // empty proof
```

- `bcs_le_u64` = little-endian 8-byte encoding of `seq` (use `bcs.u64().serialize(seq)`).
- `min`/`max` are byte-lexicographic over the 32-byte hashes.
- Prefer to verify via `devInspect` of `verify_event_inclusion` (source of truth). Implement the JS mirror only for the "verify locally" UX; if the two ever disagree, **trust the on-chain devInspect** and flag it loudly.

This format is a HARD CONSTRAINT (see `move-notes.md` 2026-05-31 "SDK HARD CONSTRAINT"). Do not change it.

---

## 8. Env vars (`.env.local`, all `NEXT_PUBLIC_*` for client reads)

```
NEXT_PUBLIC_SUI_NETWORK=testnet
NEXT_PUBLIC_PACKAGE_ID=0x...            # compliance_vault package (post-deploy; placeholder ok)
NEXT_PUBLIC_INDEXER_URL=http://localhost:3001
NEXT_PUBLIC_WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
NEXT_PUBLIC_SEAL_KEY_SERVERS=0x...,0x...,0x...   # 3 key-server object IDs (fallback if not read from policy)
NEXT_PUBLIC_ZKLOGIN_PROVER=https://prover-dev.mystenlabs.com/v1
NEXT_PUBLIC_GOOGLE_CLIENT_ID=...
```

Provide `.env.example`. App must render (with disabled actions + clear "not configured" notices) even when PACKAGE_ID is a placeholder — so the UI is demoable before contract deploy.

---

## 9. Acceptance criteria

1. `pnpm build` (or `npm run build`) passes with TS strict, no `any` in the contract/seal/merkle layers.
2. zkLogin sign-in with Google yields a stable Sui address shown in the header.
3. `/engagements` lists engagements for the logged-in address from the indexer API (mockable when indexer is down — show a clear offline state, don't crash).
4. Batch detail verifies an event via `devInspect` of `verify_event_inclusion` AND via the JS Merkle mirror, and they agree on a known-good fixture.
5. Seal decrypt path is wired (SealClient direct-instantiated, k=2/n=3, gate PTB with `seal_approve`), with abort→reason mapping. (Live decrypt needs deployed contract + key servers; gate the demo behind env presence.)
6. `file_attestation` PTB is constructed and signed with the zkLogin address; happy path + revoked/expired disabled states handled.
7. No `@mysten/sui` 1.x anywhere. No JSON-RPC. No `SealClient.$extend()`.

---

## 10. Suggested structure

```
apps/auditor-ui/
├── app/                      # Next App Router pages per §3
├── lib/
│   ├── sui.ts                # v2 client (gRPC/GraphQL), network config
│   ├── contract.ts           # typed wrappers for the §2 ABI
│   ├── zklogin.ts            # OAuth + address derivation + session
│   ├── seal.ts               # SealClient, SessionKey, gate-PTB builder
│   ├── merkle.ts             # §7 hardened mirror (leaf/internal/verify)
│   ├── indexer.ts            # §6 REST client (typed)
│   └── walrus.ts             # blob fetch by id
├── components/               # tables, cards, verify badge, decrypt panel
├── .env.example
└── README.md                 # setup, salt choice, demo script
```

Match the existing repo conventions; keep it surgical and typed.

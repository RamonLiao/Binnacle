# ComplianceVault Indexer

Custom event indexer for the `compliance_vault` package. Polls Sui **GraphQL** for
events emitted by `${PACKAGE_ID}::events`, stores them in SQLite, and serves the
auditor-UI REST contract (auditor-ui spec §6).

> JSON-RPC is **not** used (removed April 2026). Event ingestion is GraphQL-only.
> Deviates from the `sui-indexer` skill's Rust `sui-indexer-alt-framework` by design:
> the integration surface is a REST API for the UI, the contract isn't deployed yet,
> and a TS poller matches the rest of the stack and runs immediately. Revisit the Rust
> framework if checkpoint-accurate, high-throughput historical backfill is needed.

## Run

```bash
pnpm install
pnpm rebuild better-sqlite3   # compile native addon (first time)

cp .env.example .env
# edit .env: set PACKAGE_ID after deploy; leave blank to serve seed/stored data only

# Seed fixtures so the UI can integrate before the contract is deployed:
SEED=true pnpm seed          # writes fixtures to DB_PATH and prints the merkle test fixture

pnpm start                   # serves REST on :3001; live-polls if PACKAGE_ID is set
```

`pnpm seed` prints a known-good Merkle fixture (root + proof) that mirrors the
hardened on-chain scheme in `move/sources/receipt.move` — use it for the UI's
local `verify_event_inclusion` test (auditor-ui spec §4/§7).

## Endpoints (spec §6)

`GET /health` · `GET /engagements?auditor=` · `GET /namespaces/:id` ·
`GET /namespaces/:id/batches?limit=&cursor=` · `GET /batches/:id` ·
`GET /namespaces/:id/coverage` · `GET /attestations?engagementId=`

Bytes are `0x`-hex strings; cursor is the last `seqStart` (exclusive).

## Architecture

```
Sui GraphQL ──poll(cursor)──▶ source.ts ──decode.ts──▶ processor.ts ──▶ SQLite
                                                                          │
                                              api.ts (Fastify, read-only) ◀┘ ──▶ auditor UI
```

## Known limitations (event-driven, by design)

- **Engagement scope fields** (`scopeStartMs`, `scopeEndMs`, `eventTypeFilter`,
  `auditorPubkey`) are **not** in `EngagementMinted` — they come back default/empty
  on the live path. The UI reads the full `EngagementObject` on-chain for these
  (auditor-ui spec §2). Seed data includes them for demo.
- **`parentBatchHash`** and attestation `citedBatchIds` are not in their events;
  defaulted. The UI reads the frozen on-chain object when it needs them.
- `lastCheckpoint` in `/health` is best-effort (cursor-based, not checkpoint-exact).
- `seq_observed` for coverage is irreducibly off-chain (move-notes RT3 residual) —
  gaps are advisory.

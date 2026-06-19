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

## Stage C — prove-e2e (real Seal + real Walrus + anchor)

`prove-e2e.ts` runs the full prover pipeline: encode → Seal-encrypt (per-(day,type)
bucket) → Walrus `writeBlob` → anchor.

Prerequisites (in `.env`):
- `SEAL_PACKAGE_ID` = ORIGINAL published `compliance_vault` package id (IBE domain).
- `SEAL_KEY_SERVER_IDS` = 3 testnet Seal key-server OBJECT ids (see https://seal.mystenlabs.com/).
- `NAMESPACE_ID`, `WRITER_CAP_ID`, `SUI_PRIVATE_KEY`, `WALRUS_EPOCHS`, `MAX_EVENT_BYTES`.
- `ENGAGEMENT_ID` = a scoped test EngagementObject for the id-binding self-check.
- **The signer address MUST hold WAL tokens (storage) AND SUI (gas).**

Run: `cd sdk && pnpm dlx tsx --env-file=.env scripts/prove-e2e.ts`

The script performs a MANDATORY encrypt→decrypt id-binding self-check and aborts
before anchoring any real blob if it fails (guards against silently anchoring
permanently-undecryptable blobs). On first run, `console.log` the raw Walrus
`blobId` once to confirm the base64url→32-byte decoder.

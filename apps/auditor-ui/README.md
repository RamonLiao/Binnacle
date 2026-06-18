# ComplianceVault — Auditor UI

Next.js dApp for auditors to review AI agent logs, verify Merkle inclusion, decrypt scoped events, and file attestations.

## Tech Stack
- Next.js 15 (App Router)
- React 19
- Tailwind CSS v4 + shadcn/ui
- `@mysten/sui` v2.16.2
- `@mysten/dapp-kit`
- `@mysten/seal` v1.1
- `@tanstack/react-query`

## Environment Setup
1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
2. Configure the `NEXT_PUBLIC_PACKAGE_ID` to point to your deployed Move package. (Placeholder is provided for UI demo).

## Running the App

```bash
pnpm install
pnpm dev
```

## Demo Script

This app supports a mocked zkLogin flow for demonstration purposes without requiring a full Google OAuth setup or a registered dev prover callback.

1. **Start the Indexer:** Ensure the ComplianceVault indexer is running locally on port 3001 (or configure `NEXT_PUBLIC_INDEXER_URL`).
2. **Start the UI:** Run `pnpm dev`.
3. **Login:** On the landing page, click **Dev Sign In (Mock zkLogin)**. This generates a simulated JWT and derives a deterministic Sui address.
4. **View Engagements:** You will be redirected to `/engagements`. You should see the list of Active/Expired/Revoked engagements assigned to your address.
5. **Namespace Dashboard:** Click on an engagement to view its Namespace Dashboard. It will display the Next Seq, Head Hash, and a timeline of Anchored Batches. If the indexer detects a sequence gap, a red Coverage Gap banner will appear.
6. **Batch Details:** Click **Inspect** on a batch. 
   - **Verify Inclusion:** Click **Verify** to simulate a `devInspect` call to the Move contract's Merkle verification and the JS-side Merkle proof validation.
   - **Decrypt:** Click **Decrypt**. The UI will generate an `onlyTransactionKind` PTB calling `seal_approve` on-chain, and submit it to the Seal key servers. If your engagement is valid and in-scope, it will simulate a successful decryption.
7. **File Attestation:** Go back to the Namespace Dashboard and click **File Attestation**. Select the batches you audited, write your findings, and click **Sign and File Attestation** to simulate the PTB submission.

## Architecture Decisions

- **ZKLogin Salt:** We use a fixed local salt (`compliance_vault_hackathon_salt_2026`) in `src/lib/zklogin.ts` for deterministic address generation during the hackathon.
- **Seal Client:** Instantiated directly via `new SealClient(...)` with `threshold: 2` (k=2, n=3 configuration). The gate PTB accurately targets the `seal_approve` entry function in Move.
- **Merkle Verification:** Implements the exact hard-constrained `0x00`/`0x01` byte prefixing, lexicographic pair sorting, and LE `u64` sequence serialization as defined in the SDK constraints (`move-notes.md`).

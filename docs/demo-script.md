# Binnacle — Demo Script (5 min)

> Sui Overflow 2026 · Track 3 (Walrus) · ComplianceVault / **Binnacle**
> Language: British English. Timings are a guide, not a script to read verbatim.

---

## PART 1 — Slides (1 min)

**[Slide 1 — Title]**
"Hi, we're **Binnacle** — a compliance vault for AI agents, built on Sui, Walrus and Seal."

**[Slide 2 — The Problem]**
"AI agents now take real actions — they call tools, move funds, sign things. But when an auditor or regulator asks *'prove what your agent did, and prove nobody tampered with the log'*, today there's no good answer. Logs sit in a company database that the company itself can edit."

**[Slide 3 — The Solution]**
"Binnacle gives every agent a tamper-evident black box. Three guarantees:
- **Integrity** — every event is Merkle-batched and anchored on Sui, so the log can't be rewritten.
- **Confidentiality** — event payloads are encrypted with Seal threshold encryption and stored on Walrus, so raw data never leaks.
- **Scoped access** — an auditor only decrypts the exact days and event types they've been granted. Nothing more."

**[Slide 4 — Architecture, one line]**
"Agent → off-chain prover → Seal-encrypts to Walrus → anchors a batch hash on Sui. Auditor signs in with Google, and reads through our indexer. No seed phrases, no gas for the auditor."

---

## PART 2 — Live Demo (3 min)

**[0:00 — Sign in]**
"I'm an external auditor. I sign in with Google — that's **Enoki zkLogin**, so I get a real Sui address with no wallet extension and no seed phrase."
*(Click Sign in with Google → land on Engagements.)*

**[0:30 — Engagements]**
"Here are my engagements. Each one is an on-chain grant: which namespace I can audit, which event types, and a validity window. This one's **Active**; you can also see **Revoked** and **Expired** states — those are enforced on-chain, not in the UI."
*(Open an active engagement.)*

**[1:00 — Anchored batches]**
"Inside the namespace, these are the **anchored batches** — each row is a batch of agent events with its sequence range and batch hash, anchored on Sui testnet. This data is served live by our own indexer reading the chain. The batch hashes here are the on-chain commitment; the agent can't quietly drop or reorder an event without breaking the chain."
*(Open a batch.)*

**[1:40 — Verify inclusion]**
"For any receipt I can **verify inclusion** — we recompute the Merkle proof against the anchored root. Green means this event genuinely belongs to the batch the chain committed to."
*(Click Verify Inclusion → success.)*

**[2:10 — Scoped decryption, the key moment]**
"Now the important bit. I click **Decrypt**. This builds a Seal `seal_approve` gate transaction — the key servers only release a decryption share if the chain agrees my engagement covers this event's **day and type**.
Earlier we found and closed a real bug here: a sub-day grant used to leak a whole day's key — roughly a 288-times over-release. We replaced it with a **day-coverage gate**, so the full day must sit inside your grant or it fails closed. That fix is live on testnet — verified with a discriminating pair: a sub-day grant is **denied**, a full-day grant on the same event is **allowed**."
*(Show the gate; show denied-vs-allowed.)*

**[2:40 — File attestation]**
"Finally, as the auditor I file my findings. I write the report, cite the batches that back it, and sign. That attestation is anchored on-chain — the auditor's own sign-off is now tamper-evident too. Note the demo guard: we refuse to anchor mocked data unless an explicit flag is set, so we never put fake commitments on a real chain."

---

## PART 3 — Future Vision (1 min)

"Today Binnacle proves *what an agent did* — verifiably, privately, and with scoped access. Where we're heading:
- **Real-time compliance** — stream agent events into batches with second-level flushing, so audit is continuous, not after-the-fact.
- **Programmable policies** — express regulatory rules as Move policies, so a grant could say 'EU auditors, financial events, this quarter only' and the chain enforces it.
- **From audit to insurance** — once an agent's behaviour is provable, it becomes underwritable. A verifiable black box is the foundation for insuring, certifying and ultimately *trusting* autonomous agents.
- And it's a general primitive: any AI agent, any framework, can anchor to Binnacle.

Binnacle — because every autonomous system needs a black box. Thank you."

---

## Pre-demo checklist

- [ ] Indexer running at `localhost:3001` (live testnet data, not seed fixtures)
- [ ] `apps/auditor-ui/.env.local` → `NEXT_PUBLIC_PACKAGE_ID` = v3 `0x45fccc90…`
- [ ] Real `NEXT_PUBLIC_ENOKI_API_KEY` + `NEXT_PUBLIC_GOOGLE_CLIENT_ID` set; Google login tested once in advance
- [ ] `NEXT_PUBLIC_ALLOW_MOCK_ATTEST=true` (so the demo attestation is allowed)
- [ ] `pnpm dev` up; browser already past first OAuth consent (avoid live consent friction)
- [ ] Have the denied-vs-allowed day-gate pair ready (engagements ENG_SUB / ENG_FULL) to show the fix
- [ ] gRPC CORS sanity-checked on the demo machine/network

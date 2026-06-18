# ComplianceVault — Business Specification

> Track: Walrus (Sui Overflow 2026)
> Status: Hackathon draft v1
> **Research caveat:** Regulatory citations (EU AI Act, SEC/FINRA, HIPAA NPRM, MAS/HKMA) and Walrus pricing re-verified via gemini May 2026 with sources inline. Internal market projections (SOM, revenue share) remain unverified and are flagged as such. Specific ACV figures and pipeline numbers should be re-validated before any pitch.

---

## 1. Executive Summary

ComplianceVault is a **verifiable audit-memory vault for AI agents and on-chain financial workflows**, built on Walrus (blob storage) + Seal (threshold access control) + Sui Move (policy objects) + MemWal (long-term agent memory).

Every consequential action an agent takes — prompt, tool call, model version, retrieved context, output, human override — is written as a Walrus blob, sealed against an auditor-defined policy, and indexed into MemWal so an audit-agent can answer natural-language regulator questions ("show every customer-impacting decision your agent made in Q3 where it overrode the risk model") with **citations back to tamper-proof evidence**.

The thesis: as regulators (EU AI Act, NIST AI RMF, SEC/FINRA, MAS, HIPAA) move from "publish a policy" to "produce the logs", centralised observability SaaS (LangSmith, Helicone, Arize) becomes a **single point of failure and a single point of tampering**. Compliance teams need logs that the vendor itself cannot rewrite. Walrus + Seal is the only stack that delivers cheap hot-data immutability with cryptographic selective disclosure today.

MVP target buyers: **regulated fintech AI teams, healthcare AI startups, and crypto-native funds running autonomous trading agents**.

---

## 2. Problem Statement

**Concrete regulatory drivers (2024–2026):**

- **EU AI Act** (Regulation 2024/1689, in force 1 Aug 2024; high-risk obligations apply 2 Aug 2026). Article 12 requires "automatic recording of events ('logs')" over the lifetime of high-risk AI systems; Article 19 mandates providers keep automatically-generated logs for a period appropriate to intended purpose, **at least six months** unless otherwise required. General-purpose AI model obligations (Art. 53, Chapter V) applied from 2 Aug 2025 per Art. 113 [source: eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689, 2024].
- **NIST AI Risk Management Framework 1.0** (Jan 2023) + Generative AI Profile (NIST-AI-600-1, Jul 2024). "Measure" and "Manage" functions explicitly require traceable artifacts. https://www.nist.gov/itl/ai-risk-management-framework
- **SEC / FINRA**: SEC's proposed Predictive Data Analytics rule (July 2023) was **withdrawn 17 Jun 2025** [source: sec.gov, 2025]; enforcement now flows via Reg BI / fiduciary duty. **FINRA Regulatory Notice 24-09** (27 Jun 2024) on Gen-AI applies existing Rules 2210 (communications) and 3110 (supervision) to AI-influenced customer interactions [source: finra.org/rules-guidance/notices/24-09, 2024].
- **HIPAA Security Rule 45 CFR §164.312(b)** — audit controls (Required). HHS NPRM (90 FR 800, 6 Jan 2025) proposes stricter audit-log + MFA + encryption requirements; comment period closed 7 Mar 2025; final rule still pending as of May 2026 [source: federalregister.gov/d/2024-30983, 2025].
- **SOC 2 (Trust Services Criteria CC7.2, CC7.3)** — already requires immutable security event logging; auditors increasingly extend this to AI agent activity.
- **MAS FEAT Principles** (Singapore, Nov 2018 monograph — no circular number) and **HKMA High-level Principles on AI** (Circular B1/15C, 1 Nov 2019; GenAI update 19 Aug 2024) require explainability + traceability for AI used in financial decisioning [source: mas.gov.sg FEAT Principles 2018; hkma.gov.hk circular B1/15C, 2019/2024].

**Named buyer pain (typical narratives):**

- **Head of Compliance, Series B fintech**: "Our LLM credit-decision agent runs on AWS + LangSmith. When the regulator subpoenas the reasoning for a denial from 14 months ago, we have to trust LangSmith's retention policy and trust that no engineer pruned a trace. We have no cryptographic proof."
- **CISO, hospital network**: "We can't put PHI in a SaaS logger. We need encryption with key custody we control, and we need the auditor to verify our agent's behaviour without us decrypting everything for them."
- **GC at a $400M crypto fund**: "Our market-making agent makes 50k decisions/day. The SEC came knocking and we shipped them 4TB of unsigned JSON. They didn't believe it."

The gap: existing observability tools are **mutable, vendor-custodied, and not selectively-discloseable to third parties**.

---

## 3. Target Users & Personas

**P1 — Priya, Head of AI Governance (regulated fintech, 200–2000 staff)**
- Owns EU AI Act / NYDFS Part 500 / SOC 2 readiness. Reports to CRO.
- KPI: zero material findings; days-to-respond on regulator RFI.
- Tooling today: GRC platform (OneTrust/Vanta) + ad-hoc LangSmith exports.
- Buys ComplianceVault as the **evidence backbone** her GRC tool links to.

**P2 — Marco, Staff AI Engineer (healthcare AI startup, 30 staff)**
- Owns agent reliability + HIPAA technical safeguards.
- Pain: every quarter writes a custom audit-export script; loses a week.
- Buys ComplianceVault for the **SDK** — `vault.log(event)` instead of building it.

**P3 — Dana, Big-4 External Auditor (SOC 2 / ISO 42001)**
- Hired by P1 and P2's customers. Wants read-only, time-bounded access to verifiable logs without VPN/screen-share theatre.
- Uses the **auditor UI** — connects with zkLogin, presents an attestation, gets a scoped Seal decryption key for the engagement window.

**P4 — Hiro, GC of a crypto fund running an autonomous trading agent**
- Faces dual pressure: LP due-diligence + regulator inquiries.
- Buys ComplianceVault as the **trust layer** he hands to LPs and prime brokers.

---

## 4. Use Cases

**UC1 — Fintech credit-decisioning agent**
A consumer-lending agent uses an LLM to summarise applicant profiles and recommend approve/deny. ComplianceVault logs: model+prompt hash, retrieved bureau data hash, agent output, human reviewer override, final decision. When CFPB requests reasoning for case #88412 from 13 months ago, P1 generates a regulator report in 10 minutes with cryptographic chain-of-custody from Walrus blob → Sui object → Seal decryption attestation.

**UC2 — Healthcare clinical-decision support agent**
A radiology triage agent ranks scan urgency. PHI cannot leave the customer's KMS. ComplianceVault stores **encrypted** blobs on Walrus; only hashes + metadata are public. Seal policy: decryption requires (a) a HIPAA-credentialed auditor key AND (b) a time-bounded engagement object minted by the customer's compliance officer. Auditor's MemWal-backed agent runs queries against decrypted memory inside an attested enclave (design-stage, v1 vs v2 TBD pending Nautilus TEE maturity).

**UC3 — Autonomous trading / market-making agent**
A DeFi vault runs a 24/7 agent that rebalances LP positions on DeepBook + Cetus. Every order, every model signal, every parameter change is logged. LPs query a public ComplianceVault dashboard ("show drawdown decisions in the March vol spike") with full evidence. Regulator (MAS) gets scoped Seal access for an inspection window. The vault uses this evidence backbone as its primary LP-due-diligence artifact, replacing PDF reports.

**UC4 (stretch) — AI-agent marketplaces**
Agent-as-a-service platforms (think Virtuals, Olas) where each agent ships with its own ComplianceVault namespace; buyers can audit historical agent behaviour before delegation.

---

## 5. Market Analysis

**TAM** — AI governance + observability software. AI TRiSM (Trust, Risk & Security Management) spend forecast ~$6.4B by 2027, driven by EU AI Act Article 12/19 logging mandates (≥6-month retention for high-risk systems) [source: Gartner Market Guide for AI TRiSM, 2025; Regulation (EU) 2024/1689]. LLMOps observability subset estimated $0.12–0.37B by 2027 within a $3.5–9.8B broader LLMOps platform market [source: Market.us / Valuates LLMOps forecast, 2024].

**SAM** — regulated AI deployers in fintech, healthcare, and digital assets globally: ~30–50k AI-active orgs as a conservative slice of the ~34k fintechs/banks and ~186k healthcare institutions identified in industry surveys [source: Market.us LLM Observability Report 2024; FDA AI/ML-Enabled Medical Device List, May 2025] (digital-asset funds count unverified). Assume average ACV $30k → ~$0.9–1.5B.

**SOM (Year 1–2)** — Internal projection (no external benchmark): crypto-native funds (~200 globally), Sui/EVM AI-agent dApps (~500 launching), and 50 design-partner fintech/health AI startups. ~$5–15M ARR realistic by month 24, based on $30k average ACV assumption × 200–500 paying logos; no validated pipeline.

**Competitive table:**

| Product | Category | Tamper-proof? | Selective disclosure? | Self-custody keys? | Notes |
|---|---|---|---|---|---|
| LangSmith | LLM trace SaaS | No (vendor mutable) | No | No | Default LangChain stack |
| Helicone | LLM proxy/log | No | No | Self-host option | Cheap, dev-loved |
| Arize Phoenix / AX | ML+LLM observability | No | Limited RBAC | Enterprise tier | ML eval focus |
| Patronus AI | LLM eval | N/A (eval) | No | No | Complementary, not competitive |
| Credo AI | AI Governance GRC | No (policy-only) | No | No | High-level, no evidence layer |
| Holistic AI | AI risk + audit SaaS | No | No | No | Compliance reporting |
| Fiddler AI | ML observability | No | RBAC | Enterprise | Heritage in ML monitoring |
| Datadog LLM Obs | APM extension | No | RBAC | No | Bundled play |
| OpenAI Evals / Anthropic logs | Provider-native | No | No | No | Vendor lock |
| Bagel / 0G | Decentralised AI data | Partial | No | Yes | Storage-first, no compliance UX |
| EigenLayer AVS + EZKL | Verifiable inference | Yes (ZK) | N/A | Yes | Different problem (proof of compute) |
| **ComplianceVault** | Verifiable audit memory | **Yes (Walrus immutable)** | **Yes (Seal)** | **Yes** | **Compliance UX + agent query** |

Closest functional overlap: LangSmith + Credo AI stitched together. Neither offers cryptographic immutability nor third-party selective disclosure.

---

## 6. Differentiation — The Verifiable Memory Thesis

Centralised observability SaaS asks the regulator to **trust the vendor**. That trust model breaks when:

1. **The vendor is the defendant's counterparty** (vendor can be subpoenaed; logs can be amended pre-handover).
2. **The auditor is third-party** — they need read access without the vendor mediating every request.
3. **Cross-jurisdictional discovery** — EU auditor wants logs hosted by a US SaaS; data-residency conflict.

ComplianceVault's pitch: **the storage layer itself enforces immutability + retention + access policy** through Walrus blobs + Sui Move objects + Seal threshold encryption. The vendor (us) cannot rewrite a log; the customer cannot silently prune one without leaving an on-chain trail; the auditor can verify Merkle inclusion against a Sui object without our cooperation.

**Why Walrus specifically (vs. Filecoin / Arweave / S3 Object Lock):**
- **Cost**: Walrus mainnet ~$0.023/GB/month (~$0.0106/GB per 14-day epoch) via RedStuff erasure coding with reads free, vs Arweave's ~$5–8/GB one-time perpetual fee — Walrus is materially cheaper for any horizon under ~18 years [source: docs.walrus.site mainnet pricing, 2026].
- **Hot data**: Walrus is designed for sub-second read latency, unlike Filecoin retrieval.
- **Programmable per-blob policy**: each blob is a Sui object → retention, ACL, and audit rules expressed in Move, not in vendor T&Cs.
- **Selective disclosure**: Seal threshold encryption lets us issue an auditor a key that decrypts only the engagement-scoped subset, without us holding the master key.
- **MemWal**: out-of-the-box AI memory layer atop Walrus → audit-agent doesn't need a custom RAG pipeline.

S3 Object Lock + WORM gets you immutability but not selective disclosure, not third-party verifiability, and not native AI memory.

---

## 7. Product Scope

**MVP (hackathon, 4 weeks)**
- TypeScript SDK: `vault.logEvent({agentId, runId, type, payload, policyId})`.
- Move package: `PolicyObject` (retention epochs, allowed roles, optional Seal policy ref), `EventReceipt` (blob_id, hash, timestamp, parent_run).
- Walrus uploader (client-side encryption optional via Seal).
- MemWal namespace per `agentId`; ingest pipeline writes embeddings keyed by `runId`.
- Auditor web UI: zkLogin, list scoped engagements, natural-language query → audit-agent answer + cited blob IDs + Sui object links.
- Demo dataset: simulated lending agent, 30 days, 10k events, one regulator question → answer in <15s.

**v1 (6 months post-hackathon)**
- Multi-tenant; per-customer key management.
- Connectors: LangChain callback handler, OpenAI Assistants webhook, Anthropic tool-call hook.
- GRC integrations: OneTrust, Vanta, Drata evidence push.
- SIEM forwarding (Splunk, Datadog) — write-through, not write-only.
- Per-event signed receipts for inclusion in customer's data warehouse.
- Auditor attestations on Sui (auditor public key + engagement scope object).

**v2 (12–18 months)**
- TEE-attested decrypt for healthcare/PHI use cases (design-stage, v1 vs v2 TBD pending Nautilus integration timeline).
- ZK proofs of "this agent never executed prompts matching this pattern" — composes EZKL/Risc0 with Walrus blobs.
- On-chain "compliance score" SBT for agents; portable across marketplaces.
- Reg-specific report templates: AI Act Annex IV, NIST AI RMF crosswalk, SOC 2 evidence pack.

---

## 8. User Flow

**Developer flow (SDK):**
1. `npm i @compliancevault/sdk`. Run `cvault init` → creates Sui `AgentNamespace` object, registers a `PolicyObject` (retention, encryption mode, auditor allowlist).
2. Wrap agent: `const vault = new Vault({ namespace, signer })`.
3. On each agent step: `await vault.log({ type: 'tool_call', input, output, modelVersion })`. SDK batches, signs, uploads to Walrus, emits Sui `EventReceipt`.
4. Background worker indexes to MemWal namespace.
5. CI hook: `cvault verify-coverage` fails build if instrumentation drops below threshold.

**Auditor flow (UI):**
1. Customer's compliance officer mints an `EngagementObject` on Sui specifying auditor zkLogin sub, scope (date range, event types, agent IDs), and expiry.
2. Auditor receives a magic link; logs in via zkLogin; UI fetches the engagement and the Seal decryption shares.
3. Dashboard view: timeline of agent runs, search, "ask the audit agent" panel.
4. Audit agent (MemWal-backed RAG) answers in natural language with footnoted blob IDs; auditor clicks → fetches raw blob → verifies hash against the on-chain receipt client-side.
5. Auditor exports a signed report bundle (PDF + JSON Merkle proof + Sui transaction digests).

---

## 9. Technical Architecture (Summary)

- **Storage layer**: Walrus stores each event as an encrypted blob. Retention = `PolicyObject.epochs`. Blob IDs are content-addressed.
- **Policy layer**: Sui Move objects — `AgentNamespace`, `PolicyObject`, `EventReceipt`, `EngagementObject`, `AuditorAttestation`. Receipts form a hash-chained log per `runId` (each receipt references parent receipt hash → tamper-evident chain anchored on Sui).
- **Encryption layer**: Seal threshold encryption — keys split across customer KMS, ComplianceVault key server, and a customer-chosen third party (e.g., their law firm). Decryption requires an active `EngagementObject` + threshold of shares.
- **Memory layer**: MemWal namespace per agent; embeddings + structured metadata. Audit-agent uses MemWal retrieval, never bypassing Seal — it queries decrypted memory only for active engagements.
- **Verification layer**: any third party can fetch a Walrus blob and verify its hash matches the `EventReceipt` on Sui without ComplianceVault cooperation.
- **Optional**: Nautilus TEE for in-enclave decryption when PHI/PII raw text must be processed; ZK proofs (EZKL/Risc0) for "policy-conformance without disclosure" claims.

---

## 10. Business Model

- **Per-event pricing** (developer tier): $0.0001–0.001 per logged event, bundled with Walrus storage epoch cost. Free tier 100k events/month.
- **Team tier**: $499/mo flat — 10M events, 3 auditor seats, GRC integrations.
- **Enterprise license**: $30k–$250k ACV. Includes dedicated Seal key-server, custom retention policies, SLAs, SOC 2 letter, deployment support, regulator-template library.
- **Auditor seats**: free for invited auditors (network-effect lever — auditors recommend us to next client).
- **Revenue share with Walrus**: Internal projection (no external benchmark): storage pass-through with margin layered on top of ~$0.023/GB/month base cost; exact margin pending Mysten BD conversation.

---

## 11. Go-to-Market

**Phase 0 — Hackathon**: ship the demo, win a track prize, collect 3 design-partner LOIs on the spot.

**Phase 1 — Design partners (months 1–4)**:
- 2 crypto-native funds (warm intros via Sui Foundation + DeepBook ecosystem).
- 2 Sui-ecosystem AI-agent projects (Talus Network's Nexus framework and Atoma Network's verifiable inference are both running open developer/partner programs on Sui) [source: Talus Nexus docs v1.0; Atoma Network verifiable inference whitepaper, 2025].
- 1 healthcare-AI startup via YC network.
- 1 EU fintech feeling AI Act pressure.

**Phase 2 — Auditor channel (months 4–9)**:
- Partner with mid-tier audit firms: BDO already markets AI Assurance reports aligned to ISO 42001 and SOC 2(+), and RSM is investing $1B over 3 years in Agentic AI / AI governance services — both lack a *cryptographically verifiable* evidence backbone and are natural co-sell targets [source: BDO 2025 Audit Innovation Survey; RSM US press release, June 2025].
- Become a "recommended evidence backbone" in 1–2 GRC platforms.

**Phase 3 — Vertical wedges (months 9–18)**:
- AI Act compliance pack for EU SaaS.
- HIPAA AI pack for US healthtech.
- LP-due-diligence pack for crypto funds (replace quarterly PDF with live ComplianceVault dashboard).

Channels: regulator-event sponsorships (IAPP, FinregE, RSA), open-source SDK + free dev tier for bottom-up adoption, content marketing on "the LangSmith lawsuit risk" angle.

---

## 12. Hackathon Demo Plan + Judging Mapping

**Demo narrative (5 min):**
1. (30s) Cold open: news clip of an EU AI Act enforcement headline. "Where are your agent's logs, and can you prove they weren't edited?"
2. (60s) Live: a simulated lending agent processes 30 days of applications. Show SDK 4-line integration.
3. (60s) Auditor receives zkLogin link, lands in dashboard. Asks: "Show every loan where the agent overrode the bureau score". Audit-agent answers in 8 seconds with 12 cited events.
4. (60s) Click an event → fetch raw blob from Walrus → live hash verification against the Sui `EventReceipt` (open the Sui explorer).
5. (60s) Try to tamper: edit the local copy of the blob → re-upload → show that the Sui receipt makes detection trivial. Show a Seal decryption attempt **without** an active `EngagementObject` → denied on-chain.
6. (30s) Close: design-partner logo wall + ACV math.

**Judging mapping (Walrus track: Real-World 50 / Product 20 / Tech 20 / Presentation 10):**
- **Real-World (50)** — concrete regulatory drivers, named buyer personas, design-partner LOIs, dollarised ACV. Aim 47/50.
- **Product (20)** — auditor UI polish, SDK ergonomics. Aim 16/20.
- **Tech (20)** — Walrus + Seal + Sui Move + MemWal full stack; hash-chained receipts; Seal threshold demo. Aim 18/20.
- **Presentation (10)** — tamper demo is the wow moment. Aim 9/10.

Target total: **~90/100**.

---

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Demo feels "enterprisey", judges discount | Med | High | Lead with the tamper-attempt moment; show audit-agent NL query for delight |
| No real customer LOIs by demo day | Med | High | Pre-book 3 calls in week 1; even verbal commits count |
| Walrus mainnet pricing changes under us | Low-Med | Med | Architect cost as pass-through; quote unit economics in events not GB |
| Seal SDK immaturity slows MVP | Med | Med | Fall back to plain envelope encryption + post-hackathon Seal swap |
| Regulator-claim risk ("we make you compliant") | Med | High | Position as **evidence layer**, never "compliance certification". Legal review of all copy |
| Centralised competitors add "immutable logs" feature | High (12mo) | Med | Network-effect on auditor-side onboarding; ZK proofs as moat |
| AI agent adoption slower than projected | Med | High | Adjacent market: human-in-the-loop ops logs (same product, broader TAM) |
| Walrus/MemWal downtime during demo | Low | Catastrophic | Pre-record fallback video; cache demo blobs locally |
| Privacy-law conflict (GDPR right-to-erasure vs immutability) | High | High | v1: encryption + key-burn as logical deletion; document the legal argument |

**Red-team (per dev-rules.md):** attack vectors on the core flow —
1. **Replay/forge events** → mitigated by per-namespace signer + hash-chained `EventReceipt.parent_hash`.
2. **Silent log skip** (agent decides not to log a sensitive event) → mitigated by deterministic SDK middleware + `cvault verify-coverage` CI check + monotonic sequence numbers (gap = alarm).
3. **Auditor key leak** → time-bounded `EngagementObject` + threshold Seal (auditor alone cannot decrypt).
4. **Seal key-server collusion** → 2-of-3 threshold with customer-chosen 3rd party.
5. **GDPR erasure compelled** → encryption + scheduled key-shard deletion = cryptographic erasure; document compliance opinion.

---

## 14. Open Questions

1. **Walrus pricing & mainnet SLA** — base storage ~$0.023/GB/month confirmed; exact cost per event at 10M events/month (event-size assumptions, indexing overhead) and mainnet SLA for regulated workloads still need direct Mysten BD conversation.
2. **Seal production-readiness** — is threshold encryption SDK stable enough for v1? Fallback plan?
3. **MemWal multi-tenant isolation** — is per-namespace isolation sufficient for HIPAA-grade separation, or do we need separate MemWal instances per customer?
4. **GDPR right-to-erasure vs. immutability** — cryptographic erasure (key burn) defensible across all EU DPAs? Need privacy-counsel letter.
5. **Regulator acceptance** — will EU AI Act auditors actually accept Walrus blob hashes as evidence, or will they demand traditional logs too? Run pilot with one notified body.
6. **Auditor UX expectations** — Big-4 auditors vs. specialist AI auditors have very different workflows; which do we design for first?
7. **Pricing elasticity** — per-event pricing vs. flat enterprise license — which converts faster with design partners?
8. **Competitive response** — if LangSmith ships a "verifiable mode" via S3 Object Lock, what's our defensible moat? (Hypothesis: third-party verifiability + selective disclosure, not just immutability.)
9. **Move object explosion** — at 10M events/day, do we mint a receipt per event, or batch via Merkle roots? Cost/UX tradeoff.
10. **Sui-native vs. multi-chain** — do enterprise buyers care that this is on Sui, or do they want chain-agnostic? Could push to also anchor on Ethereum/Bitcoin for credibility.

---

*Document version: 1.0 (hackathon draft). Regulatory citations re-verified May 2026; internal market projections still require validation before external use.*

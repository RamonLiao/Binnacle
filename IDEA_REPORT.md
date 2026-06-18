# ComplianceVault

**One-line pitch**: Verifiable, agent-queryable compliance & audit memory vault for DeFi protocols, DAOs, and crypto funds, built on Walrus + MemWal.

**Problem**: Governance decisions, risk reports, treasury actions, and legal docs sit scattered across Notion/Discord/Drive. Auditors and regulators can't verify integrity; institutions have no tamper-proof memory backbone for AI-assisted compliance.

**Core mechanism**:
- All compliance artifacts (governance votes, risk reports, audit logs, legal docs) stored as Walrus blobs, each mapped to a Sui object encoding retention/access policy.
- MemWal layer indexes content + decisions into long-term agent memory.
- Audit agent answers questions ("show all risk overrides in Q3"), generates regulator-ready reports, traces back to raw evidence on Walrus.
- Multi-agent: drafting agent + reviewer agent + auditor-facing query agent.

**Why this track**:
- Hits all three handbook keywords: long-running workflow, multi-agent coordination, artifact-driven.
- Showcases "verifiable data layer" — without Walrus immutability + Sui-object access policy, the product cannot exist. Aligns directly with track thesis: "agents as persistent collaborative systems."
- Real-World 50% weight rewards clear institutional buyer (DeFi/DAO/funds with audit needs).

**Win probability**: 82/100
- Strongest thematic alignment with track's verifiable-memory-for-AI thesis.
- Risk: institutional buyer story is hard to *demo* convincingly in hackathon timeframe; judges may discount if no design-partner letter.

**Key risks**:
- Pitch can feel "enterprisey" / not flashy.
- Hard to show wow-factor demo vs. a consumer UX.
- Legal/compliance positioning needs careful framing to avoid claiming regulated status.

**Required Sui primitives**: Walrus (blob storage + retention), MemWal (agent memory), Sui Move objects (access policy, retention metadata), Seal (selective disclosure to auditors), optional zkLogin for auditor onboarding.

**MVP scope**:
- Upload governance/audit docs → Walrus, mint Sui policy object.
- MemWal-backed agent answers natural-language audit questions citing blob IDs.
- One end-to-end demo: simulated DAO, 30 days of decisions, auditor asks "what changed in our risk policy?" → agent returns answer + verifiable evidence trail.

// Fixture seeder so the auditor UI can integrate before the contract is deployed.
// Produces a known-good hardened-Merkle batch (matches receipt.move) so the UI's
// "verify inclusion" can be tested against a real root/proof pair (UI spec §4).
//
// Run standalone:  pnpm seed     (forces seeding regardless of SEED env)
// Or set SEED=true to seed on indexer boot.
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";

const SEED_AUDITOR = (process.env.SEED_AUDITOR ?? "0x000000000000000000000000000000000000000000000000000000000000a11ce").toLowerCase();

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const u64le = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const hex = (b: Buffer) => "0x" + b.toString("hex");
const fromHex = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");

// Hardened scheme — MUST mirror move/sources/receipt.move.
const leaf = (seq: number, eventHash: Buffer) => sha256(Buffer.concat([Buffer.from([0x00]), u64le(seq), eventHash]));
const internal = (a: Buffer, b: Buffer) => {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.concat([Buffer.from([0x01]), lo, hi]));
};
// batch_hash = sha256(parent || merkle_root || bcs_le(seq_start) || bcs_le(seq_end))
const batchHash = (parent: Buffer, root: Buffer, ss: number, se: number) =>
  sha256(Buffer.concat([parent, root, u64le(ss), u64le(se)]));

function seed() {
  const NS = "0x" + "11".repeat(32);
  const now = 1_748_000_000_000; // fixed demo epoch (ms)

  db.exec("DELETE FROM namespaces; DELETE FROM engagements; DELETE FROM batches; DELETE FROM attestations; DELETE FROM coverage_gaps;");

  // namespace
  db.prepare(
    `INSERT INTO namespaces(namespace_id, agent_id, owner, seq_next, batch_index, last_batch_hash, sealed, batch_count, last_anchor_ms, created_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(NS, "lending-agent-prod", "0x" + "0a".repeat(32), 0, 0, "0x", 0, 0, 0, now);

  // engagement (full scope fields — only available in seed; live path enriches from chain)
  db.prepare(
    `INSERT INTO engagements(engagement_id, namespace_id, auditor_addr, auditor_pubkey,
       scope_start_ms, scope_end_ms, event_type_filter, expires_at_ms, minted_at_ms, revoked)
     VALUES(?,?,?,?,?,?,?,?,?,0)`,
  ).run(
    "0x" + "e1".repeat(32), NS, SEED_AUDITOR, "0x" + "be".repeat(32),
    now - 86_400_000, now + 30 * 86_400_000, JSON.stringify(["tool_call", "decision"]),
    now + 30 * 86_400_000, now,
  );

  // --- batch 0: two-leaf tree, known-good fixture ---
  const eh0 = sha256(Buffer.from("event-0"));
  const eh1 = sha256(Buffer.from("event-1"));
  const L0 = leaf(0, eh0);
  const L1 = leaf(1, eh1);
  const root0 = internal(L0, L1);
  const parent0 = Buffer.alloc(0); // genesis parent (empty)
  const bh0 = batchHash(parent0, root0, 0, 1);
  insertBatch("0x" + "ba01".repeat(16), NS, 0, 1, root0, bh0, Buffer.from([]), ["0xblob0", "0xblob1"], now);

  // --- batch 1: single-leaf (root == leaf, empty proof) chained off batch 0 ---
  const eh2 = sha256(Buffer.from("event-2"));
  const root1 = leaf(2, eh2);
  const bh1 = batchHash(bh0, root1, 2, 2);
  insertBatch("0x" + "ba02".repeat(16), NS, 2, 2, root1, bh1, bh0, ["0xblob2"], now + 60_000);

  // namespace head after 2 batches
  db.prepare(`UPDATE namespaces SET seq_next=3, batch_index=1, last_batch_hash=?, batch_count=2, last_anchor_ms=? WHERE namespace_id=?`)
    .run(hex(bh1), now + 60_000, NS);

  // a coverage gap for the UI banner
  db.prepare(`INSERT INTO coverage_gaps(namespace_id, expected, observed, at_ms) VALUES(?,?,?,?)`)
    .run(NS, 3, 5, now + 120_000);

  // fixture for the UI's local merkle test (acceptance §4)
  const fixture = {
    namespaceId: NS,
    auditor: SEED_AUDITOR,
    batch0: {
      batchId: "0x" + "ba01".repeat(16),
      merkleRoot: hex(root0),
      verify: { seq: 0, eventHash: hex(eh0), proof: [hex(L1)] }, // expect true
    },
    batch1SingleLeaf: {
      batchId: "0x" + "ba02".repeat(16),
      merkleRoot: hex(root1),
      verify: { seq: 2, eventHash: hex(eh2), proof: [] as string[] }, // expect true
    },
  };
  console.log("[seed] fixture for UI merkle test:\n" + JSON.stringify(fixture, null, 2));
}

function insertBatch(
  batchId: string, ns: string, seqStart: number, seqEnd: number,
  root: Buffer, bh: Buffer, parent: Buffer, blobIds: string[], atMs: number,
) {
  db.prepare(
    `INSERT INTO batches(batch_id, namespace_id, run_id, seq_start, seq_end, merkle_root,
       batch_hash, parent_batch_hash, blob_ids, anchored_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    batchId, ns, "0x" + "12".repeat(32), seqStart, seqEnd, hex(root),
    hex(bh), parent.length ? hex(parent) : "0x", JSON.stringify(blobIds), atMs,
  );
}

export function seedIfRequested() {
  if (config.seed) {
    console.log("[seed] SEED=true — loading fixtures");
    seed();
  }
}

// Standalone invocation (pnpm seed)
if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
  console.log("[seed] done → " + config.dbPath);
}

// silence unused in some bundlers
void fromHex;

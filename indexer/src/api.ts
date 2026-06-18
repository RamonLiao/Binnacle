// REST API implementing the auditor-UI contract (spec §6). Read-only over SQLite.
import Fastify from "fastify";
import { db, getMeta } from "./db.js";

// --- row types ---
interface NsRow {
  namespace_id: string; agent_id: string; owner: string; seq_next: number;
  batch_index: number; last_batch_hash: string; sealed: number;
  batch_count: number; last_anchor_ms: number;
}
interface EngRow {
  engagement_id: string; namespace_id: string; auditor_addr: string; auditor_pubkey: string;
  scope_start_ms: number; scope_end_ms: number; event_type_filter: string;
  expires_at_ms: number; minted_at_ms: number; revoked: number;
}
interface BatchRow {
  batch_id: string; namespace_id: string; run_id: string; seq_start: number; seq_end: number;
  merkle_root: string; batch_hash: string; parent_batch_hash: string; blob_ids: string; anchored_at_ms: number;
}
interface AttRow {
  attestation_id: string; engagement_id: string; report_hash: string;
  cited_batch_ids: string; signed_at_ms: number;
}
interface GapRow { expected: number; observed: number; at_ms: number }

// --- prepared reads ---
const qNs = db.prepare("SELECT * FROM namespaces WHERE namespace_id = ?") as import("better-sqlite3").Statement<[string], NsRow>;
const qEngByAuditor = db.prepare(
  `SELECT e.*, n.agent_id AS agent_id FROM engagements e
   LEFT JOIN namespaces n ON n.namespace_id = e.namespace_id
   WHERE e.auditor_addr = ? ORDER BY e.minted_at_ms DESC`,
) as import("better-sqlite3").Statement<[string], EngRow & { agent_id: string }>;
const qBatch = db.prepare("SELECT * FROM batches WHERE batch_id = ?") as import("better-sqlite3").Statement<[string], BatchRow>;
const qBatchPage = db.prepare(
  `SELECT * FROM batches WHERE namespace_id = ? AND seq_start > ?
   ORDER BY seq_start ASC LIMIT ?`,
) as import("better-sqlite3").Statement<[string, number, number], BatchRow>;
const qGaps = db.prepare(
  "SELECT expected, observed, at_ms FROM coverage_gaps WHERE namespace_id = ? ORDER BY at_ms ASC",
) as import("better-sqlite3").Statement<[string], GapRow>;
const qAttByEng = db.prepare(
  "SELECT * FROM attestations WHERE engagement_id = ? ORDER BY signed_at_ms DESC",
) as import("better-sqlite3").Statement<[string], AttRow>;

// --- response mappers ---
const ns = (r: NsRow) => ({
  namespaceId: r.namespace_id, agentId: r.agent_id, owner: r.owner,
  seqNext: r.seq_next, batchIndex: r.batch_index, lastBatchHash: r.last_batch_hash,
  sealed: !!r.sealed, batchCount: r.batch_count, lastAnchorMs: r.last_anchor_ms,
});
const eng = (r: EngRow & { agent_id?: string }) => ({
  engagementId: r.engagement_id, namespaceId: r.namespace_id, agentId: r.agent_id ?? "",
  auditorAddr: r.auditor_addr, auditorPubkey: r.auditor_pubkey,
  scopeStartMs: r.scope_start_ms, scopeEndMs: r.scope_end_ms,
  eventTypeFilter: JSON.parse(r.event_type_filter) as string[],
  expiresAtMs: r.expires_at_ms, revoked: !!r.revoked, mintedAtMs: r.minted_at_ms,
});
const batch = (r: BatchRow) => ({
  batchId: r.batch_id, namespaceId: r.namespace_id, runId: r.run_id,
  seqStart: r.seq_start, seqEnd: r.seq_end, merkleRoot: r.merkle_root,
  batchHash: r.batch_hash, parentBatchHash: r.parent_batch_hash,
  blobIds: JSON.parse(r.blob_ids) as string[], anchoredAtMs: r.anchored_at_ms,
});
const att = (r: AttRow) => ({
  attestationId: r.attestation_id, engagementId: r.engagement_id, reportHash: r.report_hash,
  citedBatchIds: JSON.parse(r.cited_batch_ids) as string[], signedAtMs: r.signed_at_ms,
});

export function buildServer() {
  const app = Fastify({ logger: false });

  // permissive CORS for the local auditor UI
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "*");
  });
  app.options("/*", async (_req, reply) => reply.send());

  app.get("/health", async () => ({
    ok: true,
    lastCheckpoint: Number(getMeta("last_checkpoint") ?? 0),
  }));

  app.get<{ Querystring: { auditor?: string } }>("/engagements", async (req, reply) => {
    const auditor = req.query.auditor;
    if (!auditor) return reply.code(400).send({ error: "auditor query param required" });
    return qEngByAuditor.all(auditor).map(eng);
  });

  app.get<{ Params: { namespaceId: string } }>("/namespaces/:namespaceId", async (req, reply) => {
    const row = qNs.get(req.params.namespaceId);
    if (!row) return reply.code(404).send({ error: "namespace not found" });
    return ns(row);
  });

  app.get<{ Params: { namespaceId: string }; Querystring: { limit?: string; cursor?: string } }>(
    "/namespaces/:namespaceId/batches",
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const cursor = Number(req.query.cursor ?? -1); // seq_start cursor (exclusive)
      const rows = qBatchPage.all(req.params.namespaceId, cursor, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map(batch),
        nextCursor: rows.length === limit && last ? String(last.seq_start) : null,
      };
    },
  );

  app.get<{ Params: { batchId: string } }>("/batches/:batchId", async (req, reply) => {
    const row = qBatch.get(req.params.batchId);
    if (!row) return reply.code(404).send({ error: "batch not found" });
    return batch(row);
  });

  app.get<{ Params: { namespaceId: string } }>("/namespaces/:namespaceId/coverage", async (req) => {
    const gaps = qGaps.all(req.params.namespaceId).map((g) => ({
      expected: g.expected, observed: g.observed, atMs: g.at_ms,
    }));
    const nsRow = qNs.get(req.params.namespaceId);
    const lastObservedSeq = nsRow ? Math.max(nsRow.seq_next - 1, 0) : 0;
    return { gaps, lastObservedSeq, healthy: gaps.length === 0 };
  });

  app.get<{ Querystring: { engagementId?: string } }>("/attestations", async (req, reply) => {
    const id = req.query.engagementId;
    if (!id) return reply.code(400).send({ error: "engagementId query param required" });
    return qAttByEng.all(id).map(att);
  });

  return app;
}

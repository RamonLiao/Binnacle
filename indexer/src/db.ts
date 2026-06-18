// SQLite store. Schema mirrors the auditor-UI REST contract (spec §6).
// Bytes are stored as 0x-hex strings; vector<string> as JSON text.
// NOTE: BatchAnchored carries no batch_index, so batches are ordered by seq_start
// (monotonic per namespace) and the namespace batch_index is derived by counting.
import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS namespaces (
  namespace_id    TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL DEFAULT '',
  owner           TEXT NOT NULL DEFAULT '',
  seq_next        INTEGER NOT NULL DEFAULT 0,
  batch_index     INTEGER NOT NULL DEFAULT 0,
  last_batch_hash TEXT NOT NULL DEFAULT '0x',
  sealed          INTEGER NOT NULL DEFAULT 0,
  batch_count     INTEGER NOT NULL DEFAULT 0,
  last_anchor_ms  INTEGER NOT NULL DEFAULT 0,
  created_ms      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS engagements (
  engagement_id     TEXT PRIMARY KEY,
  namespace_id      TEXT NOT NULL,
  auditor_addr      TEXT NOT NULL,
  auditor_pubkey    TEXT NOT NULL DEFAULT '0x',
  scope_start_ms    INTEGER NOT NULL DEFAULT 0,
  scope_end_ms      INTEGER NOT NULL DEFAULT 0,
  event_type_filter TEXT NOT NULL DEFAULT '[]',
  expires_at_ms     INTEGER NOT NULL DEFAULT 0,
  minted_at_ms      INTEGER NOT NULL DEFAULT 0,
  revoked           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_eng_auditor ON engagements(auditor_addr);
CREATE INDEX IF NOT EXISTS idx_eng_ns ON engagements(namespace_id);

CREATE TABLE IF NOT EXISTS batches (
  batch_id          TEXT PRIMARY KEY,
  namespace_id      TEXT NOT NULL,
  run_id            TEXT NOT NULL DEFAULT '0x',
  seq_start         INTEGER NOT NULL,
  seq_end           INTEGER NOT NULL,
  merkle_root       TEXT NOT NULL DEFAULT '0x',
  batch_hash        TEXT NOT NULL DEFAULT '0x',
  parent_batch_hash TEXT NOT NULL DEFAULT '0x',
  blob_ids          TEXT NOT NULL DEFAULT '[]',
  anchored_at_ms    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_batch_order ON batches(namespace_id, seq_start);

CREATE TABLE IF NOT EXISTS attestations (
  attestation_id  TEXT PRIMARY KEY,
  engagement_id   TEXT NOT NULL,
  report_hash     TEXT NOT NULL DEFAULT '0x',
  cited_batch_ids TEXT NOT NULL DEFAULT '[]',
  signed_at_ms    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_att_eng ON attestations(engagement_id);

CREATE TABLE IF NOT EXISTS coverage_gaps (
  namespace_id TEXT NOT NULL,
  expected     INTEGER NOT NULL,
  observed     INTEGER NOT NULL,
  at_ms        INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, expected, observed, at_ms)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

// --- meta / cursor helpers ---
const _getMeta = db.prepare("SELECT v FROM meta WHERE k = ?") as Database.Statement<[string], { v: string }>;
const _setMeta = db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");

export function getMeta(k: string): string | null {
  return _getMeta.get(k)?.v ?? null;
}
export function setMeta(k: string, v: string): void {
  _setMeta.run(k, v);
}

// --- upserts (idempotent — events may be re-seen on cursor replay) ---
export const upsertNamespace = db.prepare(`
INSERT INTO namespaces(namespace_id, agent_id, owner, created_ms)
VALUES(@namespace_id, @agent_id, @owner, @created_ms)
ON CONFLICT(namespace_id) DO UPDATE SET
  agent_id = excluded.agent_id, owner = excluded.owner`);

export const insertBatch = db.prepare(`
INSERT INTO batches(batch_id, namespace_id, run_id, seq_start, seq_end, merkle_root,
  batch_hash, parent_batch_hash, blob_ids, anchored_at_ms)
VALUES(@batch_id, @namespace_id, @run_id, @seq_start, @seq_end, @merkle_root,
  @batch_hash, @parent_batch_hash, @blob_ids, @anchored_at_ms)
ON CONFLICT(batch_id) DO NOTHING`);

// Roll the namespace head forward. Also creates the row if NamespaceCreated wasn't
// seen (e.g. backfill starting mid-history). batch_index/seq_next derived from this batch.
export const bumpNamespaceFromBatch = db.prepare(`
INSERT INTO namespaces(namespace_id, seq_next, batch_index, last_batch_hash, batch_count, last_anchor_ms)
VALUES(@namespace_id, @seq_next, 0, @batch_hash, 1, @anchored_at_ms)
ON CONFLICT(namespace_id) DO UPDATE SET
  batch_count     = namespaces.batch_count + 1,
  batch_index     = namespaces.batch_count,            -- 0-based index of the new head
  seq_next        = MAX(namespaces.seq_next, excluded.seq_next),
  last_batch_hash = CASE WHEN excluded.seq_next >= namespaces.seq_next
                         THEN excluded.last_batch_hash ELSE namespaces.last_batch_hash END,
  last_anchor_ms  = MAX(namespaces.last_anchor_ms, excluded.last_anchor_ms)`);

export const upsertEngagement = db.prepare(`
INSERT INTO engagements(engagement_id, namespace_id, auditor_addr, auditor_pubkey,
  scope_start_ms, scope_end_ms, event_type_filter, expires_at_ms, minted_at_ms, revoked)
VALUES(@engagement_id, @namespace_id, @auditor_addr, @auditor_pubkey,
  @scope_start_ms, @scope_end_ms, @event_type_filter, @expires_at_ms, @minted_at_ms, 0)
ON CONFLICT(engagement_id) DO UPDATE SET
  namespace_id = excluded.namespace_id, auditor_addr = excluded.auditor_addr`);

export const revokeEngagement = db.prepare(`UPDATE engagements SET revoked = 1 WHERE engagement_id = ?`);

export const insertAttestation = db.prepare(`
INSERT INTO attestations(attestation_id, engagement_id, report_hash, cited_batch_ids, signed_at_ms)
VALUES(@attestation_id, @engagement_id, @report_hash, @cited_batch_ids, @signed_at_ms)
ON CONFLICT(attestation_id) DO NOTHING`);

export const insertGap = db.prepare(`
INSERT INTO coverage_gaps(namespace_id, expected, observed, at_ms)
VALUES(@namespace_id, @expected, @observed, @at_ms)
ON CONFLICT DO NOTHING`);

export const setSealed = db.prepare(`UPDATE namespaces SET sealed = 1 WHERE namespace_id = ?`);

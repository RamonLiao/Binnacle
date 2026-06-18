// Decode Sui GraphQL event JSON (contents.json) into DB row params.
// Move type -> JSON shape (observed): vector<u8> => number[]; ID/address => "0x..";
// u64 => string|number; String => string; vector<vector<u8>> => number[][].

export type EventName =
  | "NamespaceCreated"
  | "BatchAnchored"
  | "EngagementMinted"
  | "EngagementRevoked"
  | "AttestationFiled"
  | "CoverageGapDetected";

export interface RawEvent {
  typeName: EventName;
  json: Record<string, unknown>;
  timestampMs: number;
}

const HEX = "0123456789abcdef";

/** Normalize any byte-vector representation to a 0x-prefixed lowercase hex string. */
export function toHex(v: unknown): string {
  if (v == null) return "0x";
  if (typeof v === "string") return v.startsWith("0x") ? v.toLowerCase() : "0x" + v.toLowerCase();
  if (Array.isArray(v)) {
    let out = "0x";
    for (const b of v) {
      const n = Number(b) & 0xff;
      out += HEX[n >> 4]! + HEX[n & 0x0f]!;
    }
    return out;
  }
  return "0x";
}

export function toHexArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(toHex) : [];
}

/** u64 fields can exceed Number.MAX_SAFE_INTEGER on chain, but ms timestamps and
 *  seq values in practice fit; clamp via Number. (Demo-scale; revisit if needed.) */
export function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

export function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function toStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(toStr) : [];
}

// --- per-event mappers: return the @named params for the prepared statements ---

export function mapNamespaceCreated(e: RawEvent) {
  return {
    namespace_id: toStr(e.json.namespace_id),
    owner: toStr(e.json.owner),
    agent_id: toStr(e.json.agent_id),
    created_ms: e.timestampMs,
  };
}

export function mapBatchAnchored(e: RawEvent) {
  const seqEnd = toNum(e.json.seq_end);
  return {
    batch_id: toStr(e.json.batch_id),
    namespace_id: toStr(e.json.namespace_id),
    run_id: toHex(e.json.run_id),
    seq_start: toNum(e.json.seq_start),
    seq_end: seqEnd,
    merkle_root: toHex(e.json.merkle_root),
    batch_hash: toHex(e.json.batch_hash),
    parent_batch_hash: "0x", // not in event; backfilled from prior head if needed
    blob_ids: JSON.stringify(toHexArray(e.json.blob_ids)),
    anchored_at_ms: e.timestampMs,
    seq_next: seqEnd + 1,
  };
}

export function mapEngagementMinted(e: RawEvent) {
  return {
    engagement_id: toStr(e.json.engagement_id),
    namespace_id: toStr(e.json.namespace_id),
    auditor_addr: toStr(e.json.auditor_addr),
    auditor_pubkey: "0x",
    scope_start_ms: 0,
    scope_end_ms: 0,
    event_type_filter: "[]",
    expires_at_ms: toNum(e.json.expires_at_ms),
    minted_at_ms: toNum(e.json.minted_at_ms) || e.timestampMs,
  };
}

export function mapEngagementRevoked(e: RawEvent): string {
  return toStr(e.json.engagement_id);
}

export function mapAttestationFiled(e: RawEvent) {
  return {
    attestation_id: toStr(e.json.attestation_id),
    engagement_id: toStr(e.json.engagement_id),
    report_hash: toHex(e.json.report_hash),
    cited_batch_ids: JSON.stringify([]), // not in event; UI reads from on-chain object
    signed_at_ms: e.timestampMs,
  };
}

export function mapCoverageGap(e: RawEvent) {
  return {
    namespace_id: toStr(e.json.namespace_id),
    expected: toNum(e.json.expected),
    observed: toNum(e.json.observed),
    at_ms: e.timestampMs,
  };
}

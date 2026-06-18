// Applies decoded events to the store. Idempotent: re-seen events are no-ops.
import { db } from "./db.js";
import * as store from "./db.js";
import * as decode from "./decode.js";
import type { RawEvent } from "./decode.js";

const applyAll = db.transaction((events: RawEvent[]) => {
  for (const e of events) {
    switch (e.typeName) {
      case "NamespaceCreated":
        store.upsertNamespace.run(decode.mapNamespaceCreated(e));
        break;
      case "BatchAnchored": {
        const row = decode.mapBatchAnchored(e);
        store.insertBatch.run(row);
        store.bumpNamespaceFromBatch.run(row);
        break;
      }
      case "EngagementMinted":
        store.upsertEngagement.run(decode.mapEngagementMinted(e));
        break;
      case "EngagementRevoked":
        store.revokeEngagement.run(decode.mapEngagementRevoked(e));
        break;
      case "AttestationFiled":
        store.insertAttestation.run(decode.mapAttestationFiled(e));
        break;
      case "CoverageGapDetected":
        store.insertGap.run(decode.mapCoverageGap(e));
        break;
    }
  }
});

export function process(events: RawEvent[]): void {
  if (events.length) applyAll(events);
}

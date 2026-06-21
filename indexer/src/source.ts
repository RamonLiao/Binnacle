// Event source: polls Sui GraphQL for events emitted by `${PACKAGE_ID}::events`,
// paginating with a persisted cursor. JSON-RPC is NOT used (removed April 2026).
import { config } from "./config.js";
import { getMeta, setMeta } from "./db.js";
import type { EventName, RawEvent } from "./decode.js";

const CURSOR_KEY = "events_cursor";

// Filter by the event struct's defining module (`<pkg>::events`), NOT the emitting
// module: events are emitted by functions in namespace/batch/engagement but the
// structs live in the `events` module. The Sui GraphQL `type` filter accepts
// `package::module`. (Old `emittingModule`/top-level `type{repr}` schema retired
// alongside the *.mystenlabs.com host; live endpoint = graphql.testnet.sui.io.)
const QUERY = `
query Events($type: String!, $after: String, $first: Int!) {
  events(filter: { type: $type }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      timestamp
      contents { type { repr } json }
    }
  }
}`;

interface GqlNode {
  timestamp: string | null;
  contents: { type: { repr: string }; json: Record<string, unknown> | null } | null;
}

const KNOWN: ReadonlySet<string> = new Set<EventName>([
  "NamespaceCreated",
  "BatchAnchored",
  "EngagementMinted",
  "EngagementRevoked",
  "AttestationFiled",
  "CoverageGapDetected",
]);

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(config.graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  if (!body.data) throw new Error("GraphQL: empty data");
  return body.data;
}

function eventName(repr: string): EventName | null {
  const name = repr.split("::").pop() ?? "";
  return KNOWN.has(name) ? (name as EventName) : null;
}

/** Fetch one cursor-bounded page of new events. Returns decoded RawEvents in order
 *  and advances the persisted cursor. Returns [] when caught up. */
export async function pollOnce(): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  const moduleRef = `${config.packageId}::events`;
  let after = getMeta(CURSOR_KEY);
  let hasNext = true;

  while (hasNext) {
    const data = await gql<{
      events: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlNode[] };
    }>(QUERY, { type: moduleRef, after, first: config.pollPageSize });

    for (const node of data.events.nodes) {
      if (!node.contents?.type || !node.contents.json) continue;
      const name = eventName(node.contents.type.repr);
      if (!name) continue;
      out.push({
        typeName: name,
        json: node.contents.json,
        timestampMs: node.timestamp ? Date.parse(node.timestamp) : 0,
      });
    }

    const { hasNextPage, endCursor } = data.events.pageInfo;
    if (endCursor) {
      after = endCursor;
      setMeta(CURSOR_KEY, endCursor);
    }
    hasNext = hasNextPage;
  }
  return out;
}

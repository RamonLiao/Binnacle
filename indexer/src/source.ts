// Event source: polls Sui GraphQL for events emitted by `${PACKAGE_ID}::events`,
// paginating with a persisted cursor. JSON-RPC is NOT used (removed April 2026).
import { config } from "./config.js";
import { getMeta, setMeta } from "./db.js";
import type { EventName, RawEvent } from "./decode.js";

const CURSOR_KEY = "events_cursor";

const QUERY = `
query Events($module: String!, $after: String, $first: Int!) {
  events(filter: { emittingModule: $module }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      type { repr }
      timestamp
      contents { json }
    }
  }
}`;

interface GqlNode {
  type: { repr: string };
  timestamp: string | null;
  contents: { json: Record<string, unknown> | null } | null;
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
    }>(QUERY, { module: moduleRef, after, first: config.pollPageSize });

    for (const node of data.events.nodes) {
      const name = eventName(node.type.repr);
      if (!name || !node.contents?.json) continue;
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

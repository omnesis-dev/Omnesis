// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E for the source-declared edge contract.
 *
 * Drives a mock source that emits documents AND `edges` (the explicit
 * `EdgeDeclaration` contract) through the real collector→gateway sync path,
 * then asserts via `GET /documents/:id/edges` that:
 *   - an explicitly-declared edge lands in document_links with source-declared
 *     provenance and the declaring source as its origin;
 *   - the implicit `metadata.extra.parentExternalId` convention still produces a
 *     `contains` edge (the attachment migration);
 *   - a forward-reference edge (target not yet ingested) is parked as `pending`;
 *   - re-syncing with a changed target reconciles within the edge type
 *     (diff-and-delete).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import { E2EHarness } from "./harness.js";
import { type MockSource } from "./mock-source.js";
import type { DocumentInput } from "@omnesis/types";
import type { EdgeDeclaration } from "@omnesis/core";

const PROVIDER_TYPE = "mock-mail";
const SOURCE_TYPE = "mock-edges";
const ACCOUNT_ID = "edges@test.com";
const SOURCE_ID = `${SOURCE_TYPE}:${ACCOUNT_ID}`;

function doc(
  externalId: string,
  documentType: string,
  extra: Record<string, unknown> = {},
): DocumentInput {
  const content = `Body of ${externalId}`;
  return {
    providerId: ProviderId(`${PROVIDER_TYPE}:${ACCOUNT_ID}`),
    sourceId: SourceId(SOURCE_ID),
    externalId,
    title: `Doc ${externalId}`,
    content,
    contentHash: computeContentHash(content + externalId),
    metadata: { documentType, extra },
    sourceCreatedAt: "2026-01-01T10:00:00Z",
    sourceUpdatedAt: "2026-01-01T10:00:00Z",
  };
}

// Phase controls which edge set the mock source declares on each sync.
let phase = 1;

interface EdgeView {
  direction: "outbound" | "inbound";
  linkType: string;
  otherDocId: string | null;
  otherSourceId: string | null;
  resolved: boolean;
  provenanceKind: string | null;
  provenanceOrigin: string | null;
  metadataJson: string | null;
}
interface PendingView {
  linkType: string;
  targetSourceId: string;
  targetExternalId: string;
}
interface EdgesResp {
  edges: EdgeView[];
  pending: PendingView[];
}
interface RecentDoc {
  id: string;
  externalId: string;
}

let harness: E2EHarness;
let source: MockSource;

async function docIdByExternalId(externalId: string): Promise<string> {
  const data = await harness.gatewayJson<{ documents: RecentDoc[] }>(
    `/documents/recent/${encodeURIComponent(SOURCE_ID)}?limit=100`,
  );
  const found = data.documents.find((d) => d.externalId === externalId);
  if (!found) throw new Error(`doc not found: ${externalId}`);
  return found.id;
}

async function edgesOf(externalId: string): Promise<EdgesResp> {
  const id = await docIdByExternalId(externalId);
  return harness.gatewayJson<EdgesResp>(`/documents/${encodeURIComponent(id)}/edges`);
}

/**
 * Poll a document's edges until `predicate` holds. Convention-derived edges
 * (contains/part-of-thread/references via extractLinks) are written by the
 * async `linkBackfill` task — not synchronously in the sync write — so a test
 * asserting one must wait for the backfill tick.
 */
async function waitForEdges(
  externalId: string,
  predicate: (v: EdgesResp) => boolean,
  timeoutMs = 60_000,
): Promise<EdgesResp> {
  const deadline = Date.now() + timeoutMs;
  let last: EdgesResp | undefined;
  while (Date.now() < deadline) {
    last = await edgesOf(externalId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForEdges(${externalId}) timed out; last: ${JSON.stringify(last)}`);
}

beforeAll(async () => {
  harness = new E2EHarness();
  source = harness.registerMockSource({
    sourceType: SOURCE_TYPE,
    providerType: PROVIDER_TYPE,
    accountId: ACCOUNT_ID,
    unitName: "messages",
  });

  source.setSyncFn(async () => {
    const documents = [
      doc("msg-1", "email"),
      doc("msg-2", "email"),
      doc("reply-1", "email"),
      // Attachment of msg-1: the parentExternalId convention → a `contains` edge.
      doc("att-1", "attachment", { parentExternalId: "msg-1" }),
    ];
    const edges: EdgeDeclaration[] =
      phase === 1
        ? [
            // Explicit reply chain: reply-1 → msg-1.
            {
              from: { kind: "internal", sourceDocumentId: "reply-1" },
              to: { kind: "internal", sourceDocumentId: "msg-1" },
              type: "replies-to",
            },
            // Forward reference to a doc this source never emits → pending.
            {
              from: { kind: "internal", sourceDocumentId: "msg-1" },
              to: { kind: "internal", sourceDocumentId: "ghost-doc" },
              type: "references",
            },
          ]
        : [
            // Phase 2: the reply now points at msg-2 (reconcile within type).
            {
              from: { kind: "internal", sourceDocumentId: "reply-1" },
              to: { kind: "internal", sourceDocumentId: "msg-2" },
              type: "replies-to",
            },
          ];
    return { documents, deletedExternalIds: [], edges, cursor: { page: 0 }, hasMore: false };
  });

  await harness.start();
  await harness.triggerSyncAndWait(SOURCE_ID, 30_000);
}, 60_000);

afterAll(async () => {
  await harness.destroy();
}, 15_000);

describe("Source-declared edges E2E", () => {
  test("explicit replies-to edge lands with source-declared provenance", async () => {
    const view = await edgesOf("reply-1");
    const out = view.edges.filter((e) => e.direction === "outbound" && e.linkType === "replies-to");
    expect(out).toHaveLength(1);
    expect(out[0].resolved).toBe(true);
    expect(out[0].provenanceKind).toBe("source-declared");
    expect(out[0].provenanceOrigin).toBe(SOURCE_ID);
  });

  test("the parentExternalId convention still produces a contains edge", async () => {
    const view = await waitForEdges("att-1", (v) =>
      v.edges.some((e) => e.direction === "outbound" && e.linkType === "contains"),
    );
    const contains = view.edges.filter(
      (e) => e.direction === "outbound" && e.linkType === "contains",
    );
    expect(contains).toHaveLength(1);
    expect(contains[0].provenanceKind).toBe("source-declared");
    // The attachment flavour carries metadata {role:attachment}.
    expect(JSON.parse(contains[0].metadataJson ?? "{}")).toMatchObject({ role: "attachment" });
  }, 65_000);

  test("a forward-reference edge is parked as pending", async () => {
    const view = await edgesOf("msg-1");
    const pendingRef = view.pending.find((p) => p.linkType === "references");
    expect(pendingRef).toBeDefined();
    expect(pendingRef!.targetExternalId).toBe("ghost-doc");
  });

  test("re-syncing with a changed target reconciles within the edge type", async () => {
    // triggerSync (NOT resync, which wipes the source) re-upserts the same docs
    // so the declared-edge diff-and-delete runs against the existing edges.
    phase = 2;
    await harness.triggerSyncAndWait(SOURCE_ID, 30_000);

    const reply = await edgesOf("reply-1");
    const repliesTo = reply.edges.filter(
      (e) => e.direction === "outbound" && e.linkType === "replies-to",
    );
    expect(repliesTo).toHaveLength(1);
    const msg2Id = await docIdByExternalId("msg-2");
    expect(repliesTo[0].otherDocId).toBe(msg2Id);
  });
});

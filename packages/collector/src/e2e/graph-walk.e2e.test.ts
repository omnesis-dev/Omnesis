// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E for the unified `POST /graph/walk` primitive through a real
 * gateway. Drives a mock source that declares a `replies-to` edge (written
 * synchronously in the sync transaction), then walks from the reply and asserts
 * the edge surfaces — and that the edgeTypes / provenanceKinds filters narrow
 * the traversal end-to-end.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import { E2EHarness } from "./harness.js";
import { type MockSource } from "./mock-source.js";
import type { DocumentInput } from "@omnesis/types";
import type { EdgeDeclaration } from "@omnesis/core";

const PROVIDER_TYPE = "mock-mail";
const SOURCE_TYPE = "mock-walk";
const ACCOUNT_ID = "walk@test.com";
const SOURCE_ID = `${SOURCE_TYPE}:${ACCOUNT_ID}`;

function doc(externalId: string): DocumentInput {
  const content = `Body of ${externalId}`;
  return {
    providerId: ProviderId(`${PROVIDER_TYPE}:${ACCOUNT_ID}`),
    sourceId: SourceId(SOURCE_ID),
    externalId,
    title: `Doc ${externalId}`,
    content,
    contentHash: computeContentHash(content + externalId),
    metadata: { documentType: "email", extra: {} },
    sourceCreatedAt: "2026-01-01T10:00:00Z",
    sourceUpdatedAt: "2026-01-01T10:00:00Z",
  };
}

interface GraphResult {
  seeds: string[];
  vertices: { id: string; kind: string }[];
  edges: { from: string; to: string; type: string }[];
  truncated: boolean;
}
interface RecentDoc {
  id: string;
  externalId: string;
}

let harness: E2EHarness;
let source: MockSource;
let replyId = "";

async function walk(body: Record<string, unknown>): Promise<GraphResult> {
  return harness.gatewayJson<GraphResult>("/graph/walk", {
    method: "POST",
    body: JSON.stringify(body),
  });
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
    const edges: EdgeDeclaration[] = [
      {
        from: { kind: "internal", sourceDocumentId: "reply-1" },
        to: { kind: "internal", sourceDocumentId: "msg-1" },
        type: "replies-to",
      },
    ];
    return {
      documents: [doc("msg-1"), doc("reply-1")],
      deletedExternalIds: [],
      edges,
      cursor: { page: 0 },
      hasMore: false,
    };
  });
  await harness.start();
  await harness.triggerSyncAndWait(SOURCE_ID, 30_000);

  const recent = await harness.gatewayJson<{ documents: RecentDoc[] }>(
    `/documents/recent/${encodeURIComponent(SOURCE_ID)}?limit=100`,
  );
  replyId = recent.documents.find((d) => d.externalId === "reply-1")!.id;
}, 60_000);

afterAll(async () => {
  await harness.destroy();
}, 15_000);

describe("POST /graph/walk E2E", () => {
  test("an unfiltered walk from the reply surfaces the declared replies-to edge", async () => {
    const g = await walk({ start: [{ kind: "document", id: replyId }] });
    expect(g.seeds).toContain(`doc:${replyId}`);
    expect(g.edges.some((e) => e.type === "replies-to")).toBe(true);
  });

  test("edgeTypes filter excludes the replies-to edge when not requested", async () => {
    const g = await walk({ start: [{ kind: "document", id: replyId }], edgeTypes: ["url"] });
    expect(g.edges.some((e) => e.type === "replies-to")).toBe(false);
  });

  test("provenanceKinds filter keeps source-declared, drops content-derived", async () => {
    const declared = await walk({
      start: [{ kind: "document", id: replyId }],
      provenanceKinds: ["source-declared"],
    });
    expect(declared.edges.some((e) => e.type === "replies-to")).toBe(true);

    const derived = await walk({
      start: [{ kind: "document", id: replyId }],
      provenanceKinds: ["content-derived"],
    });
    expect(derived.edges.some((e) => e.type === "replies-to")).toBe(false);
  });

  test("rejects a non-document seed with 400", async () => {
    // The non-2xx is the assertion, so this reads the raw response: gatewayJson
    // would throw on it.
    const res = await harness.gatewayFetch("/graph/walk", {
      method: "POST",
      body: JSON.stringify({ start: [{ kind: "person", id: "p1" }] }),
    });
    expect(res.status).toBe(400);
    // The error message names the unsupported seed kind.
    expect(JSON.stringify(await res.json())).toMatch(/document seeds only|person/i);
  });
});

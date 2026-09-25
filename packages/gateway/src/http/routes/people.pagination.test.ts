// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_READ, type DeviceId, type TokenId } from "@omnesis/types";
import { HttpError, errorResponse } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountPeopleRoutes } from "./people.js";
import type { PersonService } from "../services/PersonService.js";
import type { AppEnv } from "./types.js";

function buildApp(personService: PersonService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "device_test" as DeviceId,
      tokenId: "token_test" as TokenId,
      scopes: [SCOPE_READ],
    });
    await next();
  });
  mountPeopleRoutes(strictRoute(app), {
    personService,
  });
  return app;
}

describe("people list pagination routes", () => {
  let browse: ReturnType<typeof vi.fn>;
  let listMergeRuleGroups: ReturnType<typeof vi.fn>;
  let listMergeRules: ReturnType<typeof vi.fn>;
  let listEnrichedCandidates: ReturnType<typeof vi.fn>;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    browse = vi.fn(
      async (
        _query: string,
        limit: number,
        options: { after?: { id: string } },
      ): Promise<
        Array<{
          id: string;
          isSelf: boolean;
          interactionScoreRecent: number;
          documentCount: number;
        }>
      > => {
        const start = options.after ? Number(options.after.id.replace("person_", "")) + 1 : 0;
        return Array.from({ length: Math.min(limit, Math.max(0, 4 - start)) }, (_, i) => ({
          id: `person_${start + i}`,
          isSelf: false,
          interactionScoreRecent: 0,
          documentCount: 4 - start - i,
        }));
      },
    );
    listMergeRuleGroups = vi.fn((options: { before?: { latest: string; key: string } }) =>
      options.before
        ? {
            items: [{ key: "person_b", latest: "2026-07-01T00:00:00.000Z", sources: [] }],
            hasMore: false,
            last: { latest: "2026-07-01T00:00:00.000Z", key: "person_b" },
          }
        : {
            items: [{ key: "person_a", latest: "2026-07-02T00:00:00.000Z", sources: [] }],
            hasMore: true,
            last: { latest: "2026-07-02T00:00:00.000Z", key: "person_a" },
          },
    );
    listMergeRules = vi.fn(
      (options: { beforeCreated?: { createdAt: string; id: string } }) =>
        (options.beforeCreated
          ? [
              {
                id: "rule_3",
                createdAt: "2026-07-01T00:00:00.000Z",
              },
            ]
          : [
              {
                id: "rule_1",
                createdAt: "2026-07-03T00:00:00.000Z",
              },
              {
                id: "rule_2",
                createdAt: "2026-07-02T00:00:00.000Z",
              },
              {
                id: "rule_3",
                createdAt: "2026-07-01T00:00:00.000Z",
              },
            ]) as never[],
    );
    listEnrichedCandidates = vi.fn(
      async (options: { clusterAfter?: { kind: "rank"; rankScore: number; clusterId: string } }) =>
        options.clusterAfter
          ? {
              candidates: [{ id: "candidate_3", clusterId: "cluster_2" }],
              hasMoreClusters: false,
              nextClusterCursor: null,
              counts: { pending: 3, accepted: 0, denied: 0, needsOperator: 0 },
            }
          : {
              // One whole two-row cluster is the first page.
              candidates: [
                { id: "candidate_1", clusterId: "cluster_1" },
                { id: "candidate_2", clusterId: "cluster_1" },
              ],
              hasMoreClusters: true,
              nextClusterCursor: { kind: "rank", rankScore: 0.8, clusterId: "cluster_1" },
              counts: { pending: 3, accepted: 0, denied: 0, needsOperator: 0 },
            },
    );
    app = buildApp({
      browse,
      listMergeRuleGroups,
      listMergeRules,
      listEnrichedCandidates,
    } as unknown as PersonService);
  });

  test("binds the people cursor to query and sort while advancing the worker keyset", async () => {
    const first = (await (await app.request("/people?q=maya&sort=documents&limit=2")).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { nextCursor?: string };
    };
    expect(first.items.map((person) => person.id)).toEqual(["person_0", "person_1"]);
    expect(browse).toHaveBeenLastCalledWith("maya", 3, {
      sortBy: "documents",
      after: undefined,
    });

    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = (await (
      await app.request(`/people?q=maya&sort=documents&limit=2&cursor=${cursor}`)
    ).json()) as { items: Array<{ id: string }> };
    expect(second.items.map((person) => person.id)).toEqual(["person_2", "person_3"]);
    expect(browse).toHaveBeenLastCalledWith("maya", 3, {
      sortBy: "documents",
      after: expect.objectContaining({
        isSelf: 0,
        interactionScoreRecent: 0,
        documentCount: 3,
        id: "person_1",
      }),
    });
    expect((await app.request(`/people?q=david&sort=documents&cursor=${cursor}`)).status).toBe(400);
  });

  test("carries the match tier through the cursor on a query walk", async () => {
    // The tier is the primary sort key ahead of any score, so a cursor that
    // omits it cannot say where the walk stopped. The repository then has to
    // assume, and every assumption either repeats or drops rows — so the
    // round-trip through the encoded cursor is the thing to pin.
    browse.mockImplementation(
      async (_q: string, limit: number, options: { after?: { id: string } }) => {
        const start = options.after ? Number(options.after.id.replace("person_", "")) + 1 : 0;
        return Array.from({ length: Math.min(limit, Math.max(0, 4 - start)) }, (_, i) => ({
          id: `person_${start + i}`,
          isSelf: false,
          interactionScoreRecent: 0,
          documentCount: 4 - start - i,
          matchRank: start + i < 2 ? 1 : 3,
        }));
      },
    );

    const first = (await (await app.request("/people?q=maya&limit=2")).json()) as {
      pageInfo: { nextCursor?: string };
    };
    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    await app.request(`/people?q=maya&limit=2&cursor=${cursor}`);
    expect(browse).toHaveBeenLastCalledWith("maya", 3, {
      sortBy: "interaction",
      after: expect.objectContaining({ id: "person_1", matchRank: 1 }),
    });
  });

  test("omits the match tier on a browse, which has no query to rank against", async () => {
    const first = (await (await app.request("/people?limit=2")).json()) as {
      pageInfo: { nextCursor?: string };
    };
    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    await app.request(`/people?limit=2&cursor=${cursor}`);
    const after = browse.mock.calls[browse.mock.calls.length - 1][2].after as Record<
      string,
      unknown
    >;
    expect("matchRank" in after).toBe(false);
  });

  test("rejects a cursor carrying a malformed match tier", async () => {
    const first = (await (await app.request("/people?q=maya&limit=2")).json()) as {
      pageInfo: { nextCursor?: string };
    };
    // Cursors are opaque base64 JSON, not signed, so a caller can hand back
    // anything; the payload validator is what keeps a bad tier out of the
    // sort-tuple comparison.
    const decoded = JSON.parse(
      Buffer.from(decodeURIComponent(first.pageInfo.nextCursor!), "base64url").toString("utf8"),
    ) as { payload: Record<string, unknown> };
    decoded.payload.matchRank = "not-a-number";
    const tampered = encodeURIComponent(
      Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url"),
    );
    expect((await app.request(`/people?q=maya&limit=2&cursor=${tampered}`)).status).toBe(400);
  });

  test("binds merge-rule group cursors to search and kind filters", async () => {
    const first = (await (
      await app.request("/people/merge-rule-groups?q=maya&kind=user&limit=1")
    ).json()) as { items: unknown[]; pageInfo: { nextCursor?: string } };
    expect(first.items).toHaveLength(1);
    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);

    const second = await app.request(
      `/people/merge-rule-groups?q=maya&kind=user&limit=1&cursor=${cursor}`,
    );
    expect(second.status).toBe(200);
    expect(listMergeRuleGroups).toHaveBeenLastCalledWith(
      expect.objectContaining({
        q: "maya",
        kind: "user",
        before: { latest: "2026-07-02T00:00:00.000Z", key: "person_a" },
      }),
    );
    expect(
      (await app.request(`/people/merge-rule-groups?q=david&kind=user&cursor=${cursor}`)).status,
    ).toBe(400);
  });

  test("keyset-pages a person's touching merge rules and binds the cursor to resolution", async () => {
    const first = (await (
      await app.request("/people/person_a/merge-rules?limit=2&resolve=1")
    ).json()) as {
      rules: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.rules.map((rule) => rule.id)).toEqual(["rule_1", "rule_2"]);
    expect(first.pageInfo.hasMore).toBe(true);
    expect(listMergeRules).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: true,
        touchesPersonId: "person_a",
        withResolved: true,
        limit: 3,
      }),
    );

    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = (await (
      await app.request(`/people/person_a/merge-rules?limit=2&resolve=1&cursor=${cursor}`)
    ).json()) as {
      rules: Array<{ id: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.rules.map((rule) => rule.id)).toEqual(["rule_3"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect(listMergeRules).toHaveBeenLastCalledWith(
      expect.objectContaining({
        beforeCreated: {
          createdAt: "2026-07-02T00:00:00.000Z",
          id: "rule_2",
        },
      }),
    );
    expect(
      (await app.request(`/people/person_b/merge-rules?limit=2&resolve=1&cursor=${cursor}`)).status,
    ).toBe(400);
    expect(
      (await app.request(`/people/person_a/merge-rules?limit=2&resolve=0&cursor=${cursor}`)).status,
    ).toBe(400);
  });

  test("returns complete merge-candidate clusters and advances by cluster offset", async () => {
    const first = (await (
      await app.request("/people/merge-candidates?status=pending&clusterLimit=1")
    ).json()) as {
      items: Array<{ id: string; clusterId: string }>;
      pageInfo: { nextCursor?: string };
    };
    expect(first.items.map((candidate) => candidate.id)).toEqual(["candidate_1", "candidate_2"]);
    expect(new Set(first.items.map((candidate) => candidate.clusterId)).size).toBe(1);

    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = await app.request(
      `/people/merge-candidates?status=pending&clusterLimit=1&cursor=${cursor}`,
    );
    expect(second.status).toBe(200);
    expect(listEnrichedCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "pending",
        clusterLimit: 1,
        clusterAfter: { kind: "rank", rankScore: 0.8, clusterId: "cluster_1" },
      }),
    );
    expect(
      (
        await app.request(
          `/people/merge-candidates?status=pending&q=other&clusterLimit=1&cursor=${cursor}`,
        )
      ).status,
    ).toBe(400);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage, clampLimit } from "@omnesis/types";
import { experimentalVisible } from "@omnesis/core";
import { BadRequestError, HttpError, NotFoundError } from "../errors.js";
import { decodePageCursor, encodePageCursor } from "../pagination-cursor.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import {
  acceptMergeCandidateBody,
  createMergeRuleBody,
  mergeClusterBody,
  peopleBulkBody,
} from "../schemas/index.js";
import type { PersonService } from "../services/PersonService.js";
import type {
  PersonBrowseCursor,
  PersonSummary,
} from "../../data/repositories/PersonRepository.js";
import type { MergeRuleKind } from "../../people.js";
import type { RouteApp } from "./types.js";

interface PeopleCursor extends PersonBrowseCursor {
  q: string;
  sort: "interaction" | "documents";
}

function peopleCursor(
  raw: string | undefined,
  q: string,
  sort: "interaction" | "documents",
): PeopleCursor | null {
  return decodePageCursor(raw, "people", (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const candidate = payload as Record<string, unknown>;
    if (
      (candidate.isSelf !== 0 && candidate.isSelf !== 1) ||
      typeof candidate.interactionScoreRecent !== "number" ||
      !Number.isFinite(candidate.interactionScoreRecent) ||
      typeof candidate.documentCount !== "number" ||
      !Number.isSafeInteger(candidate.documentCount) ||
      candidate.documentCount < 0 ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      candidate.q !== q ||
      candidate.sort !== sort ||
      // Present for a query walk, absent for a browse — but never anything else.
      (candidate.matchRank !== undefined &&
        (typeof candidate.matchRank !== "number" ||
          !Number.isSafeInteger(candidate.matchRank) ||
          candidate.matchRank < 0))
    ) {
      return null;
    }
    return {
      isSelf: candidate.isSelf,
      interactionScoreRecent: candidate.interactionScoreRecent,
      documentCount: candidate.documentCount,
      id: candidate.id,
      ...(candidate.matchRank === undefined ? {} : { matchRank: candidate.matchRank }),
      q,
      sort,
    };
  });
}

function nextPeopleCursor(
  person: PersonSummary,
  q: string,
  sort: "interaction" | "documents",
): PeopleCursor {
  return {
    isSelf: person.isSelf ? 1 : 0,
    interactionScoreRecent: person.interactionScoreRecent,
    documentCount: person.documentCount,
    id: person.id,
    // The match tier is part of the sort tuple whenever the walk carries a
    // query, so the next page must compare on it too. A browse has no tier and
    // omits it.
    ...(person.matchRank === undefined ? {} : { matchRank: person.matchRank }),
    q,
    sort,
  };
}

export interface PeopleRoutesDeps {
  personService: PersonService;
}

/**
 * People + per-document people lookups + merges. Mirrors the original
 * block at server.ts:2738-2991. The order is load-bearing — the
 * merge-rules + merge-candidates GETs must come before /people/:id GET
 * so the greedy :id matcher doesn't catch them, and /documents/:id/people
 * + /documents/people-bulk are interleaved between the people getters
 * and the merge POSTs in the original.
 */
export function mountPeopleRoutes(app: RouteApp, deps: PeopleRoutesDeps): void {
  const { personService } = deps;

  app.get("/people", scope.read(), async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = clampLimit(c.req.query("limit"), { default: 50, max: 500 });
    const sort = c.req.query("sort");
    const sortBy = sort === "documents" ? "documents" : "interaction";
    const cursor = peopleCursor(c.req.query("cursor"), q, sortBy);
    // Fetch one extra person to establish hasMore without a count scan.
    // The complete sort tuple is applied inside the read worker, so later pages
    // neither rescan preceding rows nor shift when an earlier row is inserted.
    const probe = await personService.browse(q, limit + 1, {
      sortBy,
      after: cursor ?? undefined,
    });
    const hasMore = probe.length > limit;
    const results = hasMore ? probe.slice(0, limit) : probe;
    const nextCursor = hasMore
      ? encodePageCursor("people", nextPeopleCursor(results[results.length - 1], q, sortBy))
      : undefined;
    return c.json(buildPage(results, { hasMore, limit, nextCursor }));
  });

  app.get("/people/self", scope.read(), (c) => {
    const selfId = personService.getSelfId();
    if (!selfId) throw new NotFoundError("Self not detected");
    const person = personService.getById(selfId);
    return c.json(person);
  });

  app.get("/people/stats", scope.read(), (c) => {
    return c.json(personService.getStats());
  });

  app.get("/people/search", scope.read(), async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = clampLimit(c.req.query("limit"), { default: 50, max: 500 });
    const sort = c.req.query("sort");
    const sortBy = sort === "documents" ? "documents" : "interaction";
    const cursor = peopleCursor(c.req.query("cursor"), q, sortBy);
    const probe = await personService.browse(q, limit + 1, {
      sortBy,
      after: cursor ?? undefined,
    });
    const hasMore = probe.length > limit;
    const results = hasMore ? probe.slice(0, limit) : probe;
    const nextCursor = hasMore
      ? encodePageCursor("people", nextPeopleCursor(results[results.length - 1], q, sortBy))
      : undefined;
    return c.json(buildPage(results, { hasMore, limit, nextCursor }));
  });

  // Merge-rule GETs registered BEFORE /people/:id so the greedy
  // :id matcher doesn't catch /people/merge-rules.
  app.get("/people/merge-rules", scope.read(), (c) => {
    const activeParam = c.req.query("active");
    const kindParam = c.req.query("kind");
    const withResolved = c.req.query("resolve") === "1";
    const withDetails = c.req.query("details") === "1";
    const preMerge = c.req.query("preMerge") === "1";
    const active =
      activeParam === "1" || activeParam === "true"
        ? true
        : activeParam === "0" || activeParam === "false"
          ? false
          : undefined;
    const kind: MergeRuleKind | undefined =
      kindParam === "system" || kindParam === "user" ? kindParam : undefined;
    const rules = personService.listMergeRules({
      active,
      kind,
      withResolved,
      withDetails,
      preMerge,
    });
    return c.json({ rules });
  });

  app.get("/people/merge-rule-groups", scope.read(), (c) => {
    const limit = clampLimit(c.req.query("limit"), { default: 50, max: 200 });
    const q = (c.req.query("q") ?? "").trim();
    const kindParam = c.req.query("kind");
    const kind: MergeRuleKind | undefined =
      kindParam === "system" || kindParam === "user" ? kindParam : undefined;
    if (kindParam && !kind) {
      throw new BadRequestError("kind must be one of: user, system");
    }
    const cursor = decodePageCursor(c.req.query("cursor"), "merge-rule-groups", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      if (
        value.q !== q ||
        value.kind !== (kind ?? null) ||
        typeof value.latest !== "string" ||
        typeof value.key !== "string"
      ) {
        return null;
      }
      return { latest: value.latest, key: value.key };
    });
    const result = personService.listMergeRuleGroups({
      limit,
      ...(q ? { q } : {}),
      ...(kind ? { kind } : {}),
      ...(cursor ? { before: cursor } : {}),
    });
    const nextCursor =
      result.hasMore && result.last
        ? encodePageCursor("merge-rule-groups", {
            q,
            kind: kind ?? null,
            latest: result.last.latest,
            key: result.last.key,
          })
        : undefined;
    return c.json(buildPage(result.items, { hasMore: result.hasMore, limit, nextCursor }));
  });

  app.get("/people/:id/merge-rules", scope.read(), (c) => {
    const id = c.req.param("id");
    const withResolved = c.req.query("resolve") === "1";
    const limit = clampLimit(c.req.query("limit"), { default: 25, max: 100 });
    const cursor = decodePageCursor(c.req.query("cursor"), "person-merge-rules", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      if (
        value.personId !== id ||
        value.resolve !== withResolved ||
        typeof value.createdAt !== "string" ||
        typeof value.id !== "string"
      ) {
        return null;
      }
      return { createdAt: value.createdAt, id: value.id };
    });
    const probe = personService.listMergeRules({
      active: true,
      touchesPersonId: id,
      withResolved,
      limit: limit + 1,
      ...(cursor ? { beforeCreated: cursor } : {}),
    });
    const hasMore = probe.length > limit;
    const rules = hasMore ? probe.slice(0, limit) : probe;
    const last = rules.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePageCursor("person-merge-rules", {
            personId: id,
            resolve: withResolved,
            createdAt: last.createdAt,
            id: last.id,
          })
        : undefined;
    return c.json({
      rules,
      pageInfo: buildPage([], { hasMore, limit, nextCursor }).pageInfo,
    });
  });

  app.get("/people/merge-candidates", scope.read(), async (c) => {
    const statusParam = c.req.query("status");
    const status: "pending" | "accepted" | "denied" =
      statusParam === "accepted" || statusParam === "denied" ? statusParam : "pending";
    // Rolling compatibility for clients that predate cluster pagination. New
    // clients request complete clusters in bounded pages; the high row cap
    // keeps an older client from slicing a cluster card mid-group.
    const limit = clampLimit(c.req.query("limit"), { default: 5000, max: 5000 });
    const q = (c.req.query("q") ?? "").trim();
    const clusterLimitRaw = c.req.query("clusterLimit");
    const cursorRaw = c.req.query("cursor");
    const clusterPaging = clusterLimitRaw !== undefined || cursorRaw !== undefined || q.length > 0;
    const clusterLimit = clusterPaging
      ? clampLimit(clusterLimitRaw, { default: 25, max: 100 })
      : undefined;
    const cursor = clusterPaging
      ? decodePageCursor(cursorRaw, "merge-candidate-clusters", (payload) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
          const value = payload as Record<string, unknown>;
          if (value.status !== status || value.q !== q) {
            return null;
          }
          const historyCursor = status !== "pending";
          if (historyCursor) {
            if (
              value.kind !== "history" ||
              typeof value.sortAt !== "string" ||
              !Number.isFinite(Date.parse(value.sortAt)) ||
              typeof value.id !== "string" ||
              value.id.length === 0
            ) {
              return null;
            }
            return { kind: "history" as const, sortAt: value.sortAt, id: value.id };
          }
          if (
            value.kind !== "rank" ||
            typeof value.rankScore !== "number" ||
            !Number.isFinite(value.rankScore) ||
            value.rankScore < 0 ||
            typeof value.clusterId !== "string" ||
            value.clusterId.length === 0
          ) {
            return null;
          }
          return {
            kind: "rank" as const,
            rankScore: value.rankScore,
            clusterId: value.clusterId,
          };
        })
      : null;
    const result = await personService.listEnrichedCandidates({
      status,
      limit,
      ...(clusterLimit !== undefined ? { clusterLimit } : {}),
      ...(cursor !== null ? { clusterAfter: cursor } : {}),
      ...(q ? { q } : {}),
    });
    const nextCursor =
      result.hasMoreClusters && result.nextClusterCursor !== null
        ? encodePageCursor("merge-candidate-clusters", {
            status,
            q,
            ...result.nextClusterCursor,
          })
        : undefined;
    // `counts` remains endpoint-specific metadata alongside the canonical
    // items/pageInfo envelope.
    return c.json({
      ...buildPage(result.candidates, {
        hasMore: result.hasMoreClusters,
        limit: clusterLimit ?? limit,
        nextCursor,
      }),
      counts: result.counts,
    });
  });

  /**
   * `GET /people/merge-candidates/visibility` — why the queue shows, or does
   * not show, each candidate of a status.
   *
   * The view layer applies nine vetoes to damp detector noise, and a vetoed
   * pair simply fails to appear; recovering which veto did it otherwise means
   * re-deriving hub membership, the identity-bridge graph and the corpus
   * suppression context by hand. Admin-scoped, and it reports alias TYPES and
   * opaque person ids only — never alias values — so its output is safe to
   * quote in a bug report.
   */
  app.get("/people/merge-candidates/visibility", scope.admin(), async (c) => {
    const statusParam = c.req.query("status");
    const status: "pending" | "accepted" | "denied" =
      statusParam === "accepted" || statusParam === "denied" ? statusParam : "pending";
    return c.json({ status, rows: await personService.explainCandidateVisibility({ status }) });
  });

  app.get("/people/:id", scope.read(), (c) => {
    const id = c.req.param("id");
    const person = personService.getById(id);
    if (!person) throw new NotFoundError("Person not found");
    return c.json(person);
  });

  /**
   * `GET /people/:id/annotations` — the agent's durable LLM-derived
   * observations ABOUT a person (`person_annotations`), live priors only.
   * Omnesis-derived (not source-provided). The queried id is resolved to its canonical root
   * (people merge, so a loser id still surfaces its canonical's annotations).
   * 404 when the person is unknown.
   */
  app.get("/people/:id/annotations", scope.read(), (c) => {
    const id = c.req.param("id");
    const person = personService.getById(id);
    if (!person) throw new NotFoundError("Person not found");
    const canonicalId = personService.canonicalId(id);
    const limit = clampLimit(c.req.query("limit"), { default: 20, max: 100 });
    const showDependents = experimentalVisible();
    const includeDependents = showDependents && c.req.query("includeDependents") !== "0";
    const cursor = decodePageCursor(c.req.query("cursor"), "person-annotations", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      if (
        value.personId !== canonicalId ||
        typeof value.sortAt !== "number" ||
        !Number.isFinite(value.sortAt) ||
        typeof value.id !== "string"
      ) {
        return null;
      }
      return { sortAt: value.sortAt, id: value.id };
    });
    const page = personService.listAnnotations(id, {
      limit,
      includeDependents,
      ...(cursor ? { before: cursor } : {}),
    });
    const last = page.items.at(-1);
    const nextCursor =
      page.hasMore && last
        ? encodePageCursor("person-annotations", {
            personId: page.canonicalId,
            sortAt: last.sortAt,
            id: last.id,
          })
        : undefined;
    return c.json({
      annotations: page.items.map(({ sortAt: _sortAt, ...annotation }) =>
        showDependents ? annotation : { ...annotation, dependentCount: 0, dependents: [] },
      ),
      pageInfo: buildPage([], { hasMore: page.hasMore, limit, nextCursor }).pageInfo,
    });
  });

  app.get("/people/:id/documents", scope.read(), (c) => {
    const id = c.req.param("id");
    const role = c.req.query("role");
    const limit = clampLimit(c.req.query("limit"), { default: 50, max: 500 });
    const offsetRaw = c.req.query("cursor") ?? c.req.query("offset");
    const offset = offsetRaw ? Math.max(0, parseInt(offsetRaw, 10) || 0) : 0;
    // Fetch one extra row to detect hasMore without a count query.
    const probe = personService.getDocuments(id, {
      role: role ?? undefined,
      limit: limit + 1,
      offset,
    });
    const hasMore = probe.length > limit;
    const entries = hasMore ? probe.slice(0, limit) : probe;
    const nextCursor = hasMore ? String(offset + limit) : undefined;
    return c.json(buildPage(entries, { hasMore, limit, nextCursor }));
  });

  app.get("/documents/:id/people", scope.read(), (c) => {
    const id = c.req.param("id");
    const result = personService.resolveDocumentPeople(id);
    if (result.matches.length === 0) throw new NotFoundError("Document not found");
    if (result.matches.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix", { matches: result.matches });
    }
    return c.json({ people: result.people });
  });

  app.post("/documents/people-bulk", scope.readBulk(), validateJson(peopleBulkBody), async (c) => {
    const { ids } = c.req.valid("json");
    if (ids.length === 0) return c.json({ docs: {} });
    const docs = personService.bulkAssignDocumentsSummary(ids);
    return c.json({ docs });
  });

  app.post("/people/:id/merge/:otherId", scope.admin(), async (c) => {
    const winnerId = c.req.param("id");
    const loserId = c.req.param("otherId");
    const result = await personService.merge(winnerId, loserId);
    return c.json(result);
  });

  app.post("/people/rebuild", scope.admin(), async (c) => {
    await personService.rebuild();
    return c.json({ ok: true, message: "Rebuild initiated. Backfill will process documents." });
  });

  app.post("/people/merge-rules", scope.admin(), validateJson(createMergeRuleBody), async (c) => {
    const body = c.req.valid("json");
    let parsed;
    try {
      parsed = personService.parseCreateMergeRuleInput(body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Error) throw new BadRequestError(err.message);
      throw err;
    }
    try {
      const result = await personService.createMergeRule(parsed);
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Invalid alias type") ||
        msg.includes("must be a non-empty string") ||
        msg.includes("must reference different aliases") ||
        msg.includes("winnerSide must be")
      ) {
        throw new BadRequestError(msg);
      }
      throw err;
    }
  });

  // Literal-prefixed path — registered before `/people/merge-rules/:id` so the
  // `:id` matcher doesn't swallow `/group/...`. Undoes a whole cluster merge.
  app.delete("/people/merge-rules/group/:groupId", scope.admin(), async (c) => {
    const groupId = c.req.param("groupId");
    const result = await personService.deleteMergeRuleGroup(groupId);
    return c.json(result);
  });

  app.delete("/people/merge-rules/:id", scope.admin(), async (c) => {
    const id = c.req.param("id");
    const result = await personService.deleteMergeRule(id);
    return c.json(result);
  });

  // Literal path — registered before the `:id/accept` param route so it
  // isn't shadowed. Unifies a whole cluster of duplicates in one action.
  app.post(
    "/people/merge-candidates/merge-cluster",
    scope.admin(),
    validateJson(mergeClusterBody),
    async (c) => {
      const { personIds, reason } = c.req.valid("json");
      const result = await personService.mergeCluster(personIds, { reason: reason ?? null });
      return c.json(result);
    },
  );

  app.post(
    "/people/merge-candidates/:id/accept",
    scope.admin(),
    validateJson(acceptMergeCandidateBody),
    async (c) => {
      const id = c.req.param("id");
      const { winnerSide, reason } = c.req.valid("json");
      try {
        const result = await personService.acceptCandidate({
          candidateId: id,
          winnerSide,
          reason: reason ?? null,
        });
        return c.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) throw new NotFoundError(msg);
        if (msg.includes("denied")) throw new BadRequestError(msg);
        throw err;
      }
    },
  );

  app.post("/people/merge-candidates/:id/deny", scope.admin(), async (c) => {
    const id = c.req.param("id");
    try {
      const cand = await personService.denyCandidate(id);
      return c.json({ candidate: cand });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) throw new NotFoundError(msg);
      if (msg.includes("accepted")) throw new BadRequestError(msg);
      throw err;
    }
  });
}

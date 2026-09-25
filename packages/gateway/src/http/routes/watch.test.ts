// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Watch V2's admin surface, at the HTTP boundary.
 *
 * What is checked here is what a handler is answerable for: the gate, the scope
 * guard, and what happens to a body or a query parameter that is not what the
 * route expected. The runtime behind it has its own tests; these are about the
 * edge where an operator's input arrives.
 *
 * Two of the cases exist because the values reach further than they look.
 * `fromSeq` decides where a watch starts, and a value that survives validation
 * as the wrong type makes the watch wake on the whole corpus rather than on
 * what happens next — silently, since nothing downstream can tell. `?limit`
 * reaches a SQL `LIMIT`, where a negative reads as unbounded and a non-integer
 * is a driver error rather than a clamped value.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { ANCHOR_UNMINTED_NOTE, layerHealth } from "../../watch/health.js";
import { WatchDefinitionStore } from "../../watch/definitions.js";
import { DEFAULT_RETAINED as MAX_TRACE_LIMIT, WatchTraceStore } from "../../watch/traces.js";
import { WatchJournalStore } from "../../watch/store.js";
import { WriteLease } from "../../watch/write-lease.js";
import { getPersonNames } from "../../data/repositories/PersonRepository.js";
import { watchDisclosure, watchDisclosureSummaries } from "../../watch/disclosure.js";
import type { WatchLiveState, FailureClass } from "@omnesis/watch";
import type { WatchStateResult } from "../../watch/engine-host.js";
import type { PreviewWatchRequest, PreviewWatchResult } from "../../watch/authoring.js";
import type { WatchV2RoutesDeps, WatchWorkflowOutcome } from "./watch.js";
import type { EncryptedSqliteDatabase } from "../../sqlite-encryption.js";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let dir: string;
let journal: WatchJournalStore;
let adminDb: EncryptedSqliteDatabase;
let definitions: WatchDefinitionStore;
let traces: WatchTraceStore;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let READ_TOKEN: string;
let forgotten: string[];
let reactivated: string[];
let skipRequests: string[];
/** What the runtime would say stopped a watch, for the resume tests. */
let recordedFailure: { seq: number; nodeId: string; failure: FailureClass } | null;
let leaseTurns: number;
let judgeReadiness: { loadable: boolean; reason: string | null };

/**
 * A write lease that counts its turns.
 *
 * Every write to the definitions file goes through one; a handler that wrote
 * outside it would join whatever transaction the engine has open and could be
 * rolled back after the request had already answered. Counting is how a test
 * can tell the difference.
 */
function countingLease(): WriteLease {
  const lease = new WriteLease();
  const run = lease.run.bind(lease);
  return Object.assign(lease, {
    run: <T>(work: () => Promise<T>): Promise<T> => {
      leaseTurns += 1;
      return run(work);
    },
  });
}

function mintToken(scopes: readonly Scope[]): string {
  const device = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, device.id, scopes).token;
}

function req(path: string, init: RequestInit = {}, token = ADMIN_TOKEN): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    }),
  );
}

/** A watch the install's ontology accepts — gmail declares `email`. */
function emailWatch(fingerprint: string, name = "every-email"): unknown {
  return {
    watch: {
      name,
      firing_policy: "stays_active",
      ontology_fingerprint: fingerprint,
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
    },
  };
}

function judgedEmailWatch(fingerprint: string, name = "judged-email"): unknown {
  const dsl = emailWatch(fingerprint, name) as {
    watch: { nodes: Array<Record<string, unknown>> };
  };
  Object.assign(dsl.watch.nodes[0]!, {
    recall: { semantic: { query: "a fictional project update", threshold: 0.35 } },
    judge: {
      proposition: "the update says the fictional project is complete",
      output_schema: { decision: "bool" },
    },
  });
  return dsl;
}

async function fingerprint(): Promise<string> {
  const res = await req("/admin/watch/ontology");
  return ((await res.json()) as { fingerprint: string }).fingerprint;
}

/** What the runtime has recorded, for the tests that read it back. */
let recordedFirings: ReturnType<WatchV2RoutesDeps["firings"]> = [];
/**
 * What the subscriptions would say each firing's woken workflow did.
 *
 * Empty by default, because most firings wake nobody — a case that wants a
 * report puts one in under the firing key the route derives.
 */
let recordedWorkflows = new Map<string, WatchWorkflowOutcome>();
let recordedDeliveries: ReturnType<WatchV2RoutesDeps["deliveries"]> = [];
let corpus = new Map<string, { id: string; title: string; sourceId: string }>();
/** What the route asked the engine to fire, and what the engine answered. */
let fireRequests: Array<{ watchId: string; input: unknown }> = [];
/** Candidates the route handed the engine to try. */
let preflightRequests: unknown[] = [];
/** Built in `beforeEach`, once, so no fixture here can drift from the type. */
let watchV2Routes: WatchV2RoutesDeps & { compiles: { open: boolean; size: number } };
/** What the compile route asked the preview for, and what it was told. */
let previewRequests: PreviewWatchRequest[] = [];
let previewResult: PreviewWatchResult;
/** What the runtime says it is holding, and what the route asked it for. */
/** A deadline far enough out that no clock skew moves it. */
const NEXT_DUE = "2027-01-04T09:15:30.000Z";
let stateResult: WatchStateResult = { outcome: "no-watch" };
let stateRequests: { watchId: string; parkedLimit: number }[] = [];
/** What the runtime is holding across every watch, for the listing. */
let liveState: { held: Map<string, WatchLiveState>; journalHead: number } = {
  held: new Map(),
  journalHead: 0,
};
let fireResult: Awaited<ReturnType<NonNullable<WatchV2RoutesDeps["fireByHand"]>>> = {
  outcome: "fired",
  seq: -1,
  delivered: 1,
  suppressed: 0,
};

async function addWatch(name = "every-email"): Promise<string> {
  const res = await req("/admin/watch/watches", {
    method: "POST",
    body: JSON.stringify({ dsl: emailWatch(await fingerprint(), name) }),
  });
  const body = await res.text();
  expect(res.status, body).toBe(201);
  return (JSON.parse(body) as { watch: { id: string } }).watch.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-wv2-routes-"));
  dbPath = join(dir, `omnesis-${randomUUID()}.db`);
  db = createDatabase(dbPath);
  db.prepare(
    `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
     VALUES ('gmail', ?, 0)`,
  ).run(JSON.stringify({ documentTypes: ["email"], personRoles: ["sender"], metadataFields: [] }));

  journal = WatchJournalStore.open(join(dir, "watch.db"), null);
  adminDb = new Database(join(dir, "watch.db")) as unknown as EncryptedSqliteDatabase;
  definitions = new WatchDefinitionStore(adminDb);
  traces = new WatchTraceStore(adminDb);
  forgotten = [];
  reactivated = [];
  recordedFirings = [];
  recordedWorkflows = new Map();
  recordedDeliveries = [];
  corpus = new Map();
  skipRequests = [];
  fireRequests = [];
  preflightRequests = [];
  stateRequests = [];
  stateResult = { outcome: "no-watch" };
  liveState = { held: new Map(), journalHead: 0 };
  fireResult = { outcome: "fired", seq: -1, delivered: 1, suppressed: 0 };
  recordedFailure = null;
  leaseTurns = 0;
  judgeReadiness = { loadable: true, reason: null };
  previewRequests = [];
  previewResult = {
    status: "compiled",
    document: { watch: { name: "a-parcel-shipped" } },
    interpretation: "tell me when a parcel ships",
    diagnostics: [],
    backtest: null,
    compileRunId: "run_the_compile",
  };

  // The watch routes' dependencies, checked against the type the route asks
  // for. `satisfies` on a named constant rather than a literal inline below,
  // because the options object is cast — a test cannot build a whole server
  // config — and a cast defeats every check inside it. Pinned here, a member
  // added to the type is a compile error naming this file rather than a 500
  // in whichever case first reads it.
  watchV2Routes = {
    definitions,
    // Open and idle, which is every case here but the one that closes it.
    compiles: { open: true, size: 0 },
    traces,
    // The real store, like `traces` beside it: the route's job is to hand back
    // what was kept, and a canned list would pass whatever the store did.
    judgeExchanges: (id, limit) => traces.judgeExchanges(id, limit),
    journal,
    ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
    firings: () => recordedFirings,
    deliveries: () => recordedDeliveries,
    evidenceDocuments: (ids) => ids.flatMap((id) => corpus.get(id) ?? []),
    firingCount: () => recordedFirings.length,
    // Only the keys the route asked about, like the real reader: a map holding
    // an entry nobody asked for would let a row carry a report belonging to
    // another firing without the case noticing.
    workflowOutcomes: (keys) =>
      new Map(
        keys.flatMap((key) => {
          const found = recordedWorkflows.get(key);
          return found === undefined ? [] : [[key, found] as const];
        }),
      ),
    judgeSpend: () => ({ calls: 0, deferrals: 0, errors: 0, byWatch: {} }),
    judgeReadiness: () => judgeReadiness,
    judgeBudget: () => ({
      dailyCap: 200,
      perWatchDailyCap: 50,
      spentToday: 7,
      watchSpentToday: 2,
    }),
    state: (watchId, parkedLimit) => {
      stateRequests.push({ watchId, parkedLimit });
      return Promise.resolve(stateResult);
    },
    liveState: () => Promise.resolve(liveState),
    // See #1885 — a required dep added here is not caught by the typechecker,
    // because `*.test.ts` is excluded from every tsconfig; it surfaces as a
    // 500 in whichever case first reads it.
    //
    // The real readers over this test's own subscriptions, not stubs: a
    // watch's disclosure is the record that authorised it, and only the real
    // query can be wrong about which record that is — or about a revoked one
    // still having a history worth showing.
    disclosureSummaries: () => watchDisclosureSummaries(db),
    disclosure: (watchId) => watchDisclosure(db, watchId),
    // The real reader over this test's own people table, not a stub: the
    // point of the join is that a key component which happens to be a person
    // id resolves and one that is not stays as it is, and only the real
    // query can be wrong about that.
    people: (ids) => getPersonNames(db, ids),
    latency: () => ({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 }),
    pending: () => 0,
    forget: (id) => forgotten.push(id),
    // A stub here would hide the half of a resume that matters: a definition
    // marked active while the engine still holds its runtime flag down.
    reactivate: (id) => reactivated.push(id),
    // The route calls this whenever a delivery block changes or a watch is
    // removed; the anchor machinery itself is exercised in its own tests.
    setWakeAnchor: () => Promise.resolve(null),
    failure: () => recordedFailure,
    deliveryToday: () => ({ dailyCap: 20, perWatchDailyCap: 5, attempted: 0, degraded: 0 }),
    ontologyCoverage: () => null,
    attemptedToday: () => 0,
    // Assembled from the real function over the definitions this test holds,
    // not stubbed: the point of the report's health block is that it cannot
    // disagree with the watches beside it, and a canned object would.
    health: () =>
      layerHealth({
        watches: definitions.list().map((w) => ({
          status: w.status,
          note: w.note,
          hasNodeFailure: recordedFailure !== null,
        })),
        lastEvaluatedAtMs: Date.now(),
        startedAtMs: Date.now(),
        journalHead: journal.head(),
        journalHeadAtMs: journal.headAt().observedAtMs,
        evaluatedThroughSeq: journal.head(),
        idleEvaluateIntervalMs: 30_000,
        now: Date.now(),
      }),
    skipPlan: () =>
      recordedFailure === null
        ? null
        : {
            what: "event" as const,
            seq: recordedFailure.seq,
            nodeId: recordedFailure.nodeId,
            why: recordedFailure.failure,
          },
    applySkip: (watchId: string) => skipRequests.push(watchId),
    preflight: (watch, opts) => {
      preflightRequests.push({ watch, opts });
      return Promise.resolve({
        outcome: "probed" as const,
        report: {
          window: {
            events: 2,
            offered: 2,
            fromSeq: 1,
            toSeq: 2,
            from: null,
            to: null,
            observedMs: 0,
          },
          nodes: [],
          firings: 0,
          judgeGated: false,
        },
      });
    },
    fireByHand: (watchId, input) => {
      fireRequests.push({ watchId, input });
      return Promise.resolve(fireResult);
    },
    writes: countingLease(),
    enabled: () => true,
    // The three the suite never drives. Supplied rather than omitted because
    // omitting them is indistinguishable from forgetting them: each throws if
    // a case ever reaches it, so the route that grew a dependency on one says
    // so by name here instead of 500-ing somewhere downstream.
    author: () => {
      throw new Error("authoring is exercised in its own suite");
    },
    // Answered rather than thrown, unlike `author` beside it: the route's own
    // job on this path — choosing the preview over the install, and shaping
    // the answer — is only exercisable if something comes back.
    preview: (input) => {
      previewRequests.push(input);
      return Promise.resolve(previewResult);
    },
    retireAuthoredWatch: () => {
      throw new Error("authoring is exercised in its own suite");
    },
    probe: {
      db,
      indexDb: null,
      recall: {
        score: () => {
          throw new Error("recall scoring is exercised in its own suite");
        },
      },
      embedderAssigned: () => false,
    } as unknown as WatchV2RoutesDeps["probe"],
    // The two the verdict is decided from that no other row field carries:
    // what each watch has caught, and whether the ones that wake an agent
    // still hold a record to wake it through.
    firingSummary: () =>
      Promise.resolve(
        new Map(
          recordedFirings.length > 0
            ? [["w", { count: recordedFirings.length, lastFiredAtMs: null }]]
            : [],
        ),
      ),
    anchorBreaches: () => [],
  } satisfies WatchV2RoutesDeps;

  app = createServer(db, dbPath, {
    port: 0,
    writeGate: directWriteGate(db),
    watchV2Routes,
  } as never);

  ADMIN_TOKEN = mintToken([SCOPE_ADMIN]);
  READ_TOKEN = mintToken([SCOPE_READ]);
});

afterEach(() => {
  adminDb.close();
  journal.close();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("the report on a layer that has stopped", () => {
  test("cannot describe a stopped install without saying so", async () => {
    // The incident this exists for: every watch paused by an ontology move,
    // and a report that said `0 failed` for as long as it stayed that way.
    // There is no longer a number that can be read as healthy on its own.
    const id = await addWatch("stopped-by-drift");
    const stored = definitions.get(id)!;
    definitions.put({
      ...stored,
      status: "paused",
      note: "no longer validates: ONTOLOGY_FINGERPRINT_MISMATCH",
    });

    const res = await req("/admin/watch/report");
    const body = (await res.json()) as {
      failed?: unknown;
      health: {
        active: number;
        stopped: { total: number; drifted: number };
        alarm: string | null;
      };
    };

    expect(body.health.active).toBe(0);
    expect(body.health.stopped.drifted).toBe(1);
    expect(body.health.alarm, "a wholly stopped layer reported nothing wrong").toContain(
      "no watch is evaluating",
    );
    expect(
      body.failed,
      "the count that could read healthy while the layer was inert came back",
    ).toBeUndefined();
  });

  test("says nothing is wrong while the watches run", async () => {
    await addWatch("running-fine");
    const res = await req("/admin/watch/report");
    const body = (await res.json()) as { health: { active: number; alarm: string | null } };

    expect(body.health.active).toBe(1);
    expect(body.health.alarm).toBeNull();
  });

  test("reports whether semantic judging can run", async () => {
    const res = await req("/admin/watch/report");
    const body = (await res.json()) as { judge: { loadable: boolean; reason: string | null } };

    expect(body.judge.loadable).toBe(true);
    expect(body.judge.reason).toBeNull();
  });

  test("reports the actionable reason when the assigned judge cannot load", async () => {
    judgeReadiness = {
      loadable: false,
      reason: 'Backend "fictional" is unreachable: HTTP 401',
    };
    const res = await req("/admin/watch/report");
    const body = (await res.json()) as { judge: typeof judgeReadiness };

    expect(body.judge).toMatchObject(judgeReadiness);
  });

  test("reports which active watches require semantic judging before nominations exist", async () => {
    const plain = await addWatch("plain");
    const res = await req("/admin/watch/watches", {
      method: "POST",
      body: JSON.stringify({ dsl: judgedEmailWatch(await fingerprint()) }),
    });
    expect(res.status, await res.text()).toBe(201);

    const report = await req("/admin/watch/report");
    const body = (await report.json()) as {
      watches: Array<{ id: string; judgeRequired: boolean; pendingNominations: number }>;
    };
    expect(body.watches.find((watch) => watch.id === plain)?.judgeRequired).toBe(false);
    expect(body.watches.find((watch) => watch.id !== plain)).toMatchObject({
      judgeRequired: true,
      pendingNominations: 0,
    });
  });

  test("carries the liveness a silent install is read with", async () => {
    await addWatch("quiet");
    const res = await req("/admin/watch/report");
    const body = (await res.json()) as {
      health: { liveness: { journalHead: number; staleAfterMs: number; stalled: boolean } };
    };

    // Without these two, "quiet because nothing happened" and "quiet because
    // nothing is running" are the same page.
    expect(body.health.liveness).toHaveProperty("lastEvaluatedAt");
    expect(body.health.liveness).toHaveProperty("journalHeadAt");
    expect(body.health.liveness.staleAfterMs).toBeGreaterThan(0);
  });
});

describe("who may reach the surface", () => {
  test("a read token cannot", async () => {
    const res = await req("/admin/watch/watches", {}, READ_TOKEN);
    expect(res.status).toBe(403);
  });

  test("a client still asking for the old path is answered, not refused", async () => {
    // A phone already in someone's pocket asks for `/admin/watch-v2/*`. This
    // API promises additive-within-minor, so the move has to keep answering
    // the old prefix until the major bump — a 404 here is a Watches screen
    // that goes blank on a build the operator has not updated yet.
    const moved = await req("/admin/watch-v2/watches");
    const now = await req("/admin/watch/watches");
    expect(moved.status).toBe(now.status);
    expect(await moved.json()).toEqual(await now.json());
  });

  test("a legacy path that cannot be rewritten is refused, not re-dispatched", async () => {
    // Hono matches on a percent-decoded path while the raw URL is not decoded,
    // so both of these route to the legacy middleware and then rewrite to
    // themselves. Re-dispatching an unchanged URL re-enters the middleware
    // against the top-level app, re-running the entire global chain —
    // unauthenticated — until the stack gives out. Each of these was a ~2000x
    // amplification of every request-scoped middleware, including a token
    // lookup against SQLite.
    // The bare prefix has nothing under it to rewrite to, so it is refused.
    const bare = await req("/admin/watch-v2");
    expect(bare.status).toBe(404);

    // The encoded spelling is the same request written differently, and
    // matching on the decoded path is what makes it answerable rather than a
    // request that rewrites to itself.
    const encoded = await req("/admin/watch%2dv2/watches");
    const plain = await req("/admin/watch/watches");
    expect(encoded.status).toBe(plain.status);
    expect(await encoded.json()).toEqual(await plain.json());

    // The failure mode being guarded is a blown stack surfacing as a 500.
    for (const res of [bare, encoded]) expect(res.status).not.toBe(500);
  });

  test("a dot-segment path never reaches the watch surface", async () => {
    // Resolved while the URL is parsed, before routing — so these never match
    // the legacy prefix and the rewrite never sees them. Pinned as the reason
    // the middleware carries no dot-segment guard of its own.
    // Each of these resolves OUTSIDE the watch prefix, so none may be answered
    // as a watch route. (One that resolves back inside it is served normally,
    // gate and all — that is the same request written awkwardly, not an
    // escape.)
    for (const path of ["/admin/watch-v2/%2e%2e/watches", "/admin/watch-v2/../watches"]) {
      const res = await req(path);
      expect(res.status, `${path} was served as a watch route`).toBe(404);
    }
  });

  test("carries a body through to the surface it moved to", async () => {
    // The alias re-dispatches a Request; a body that did not survive would
    // fail as a validation error rather than as a routing one, which is a
    // much harder thing to notice.
    const moved = await req("/admin/watch-v2/watches", { method: "POST", body: "{}" });
    const now = await req("/admin/watch/watches", { method: "POST", body: "{}" });
    expect(moved.status).toBe(now.status);
    expect(await moved.json()).toEqual(await now.json());
  });

  test("does not spend the one-time deprecation warning on a refused path", async () => {
    // The warning is latched. A probe that could not be rewritten must not burn
    // it, or the first genuine legacy client goes unmentioned.
    await req("/admin/watch-v2");
    const moved = await req("/admin/watch-v2/watches");
    expect(moved.status).toBe(200);
  });

  test("the old path is gated and scoped exactly like the new one", async () => {
    // The rewrite must not become a way around the feature gate or the scope
    // check — it is a spelling, not a second door.
    const res = await req("/admin/watch-v2/watches", {}, READ_TOKEN);
    expect(res.status).toBe(403);
  });
});

describe("adding a watch", () => {
  test("refuses a fromSeq that is not a whole number of events", async () => {
    // The value that decides where a watch starts. A JSON string survives an
    // unchecked read, binds TEXT into an INTEGER column, and makes the "start
    // at the head" comparison false — so the watch wakes on the whole corpus.
    for (const fromSeq of ["0", -5, 1.5, {}, null]) {
      const res = await req("/admin/watch/watches", {
        method: "POST",
        body: JSON.stringify({ dsl: emailWatch(await fingerprint()), fromSeq }),
      });
      expect(res.status, `fromSeq ${JSON.stringify(fromSeq)} was accepted`).toBe(400);
    }
  });

  test("refuses a body with no dsl", async () => {
    const res = await req("/admin/watch/watches", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });

  test("refuses a watch the ontology does not accept, with the diagnostics", async () => {
    const res = await req("/admin/watch/watches", {
      method: "POST",
      body: JSON.stringify({ dsl: emailWatch("not-this-install's-fingerprint") }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { diagnostics: { code: string }[] };
    expect(body.diagnostics.map((d) => d.code)).toContain("ONTOLOGY_FINGERPRINT_MISMATCH");
  });

  test("starts a watch at the journal head when it says nothing", async () => {
    journal.commit({
      events: [
        {
          kind: "doc.indexed",
          occurredAt: "2026-03-01T09:00:00Z",
          observedAt: "2026-03-01T09:00:00Z",
          payload: {
            docId: "aaaaaaaa-0000-4000-8000-000000000001",
            eventIndexedAt: "2026-03-01T09:00:00Z",
          },
        },
      ],
    });
    const res = await req("/admin/watch/watches", {
      method: "POST",
      body: JSON.stringify({ dsl: emailWatch(await fingerprint()) }),
    });
    const { watch } = (await res.json()) as { watch: { fromSeq: number } };
    expect(watch.fromSeq, "a watch was added pointing at the past").toBe(journal.head());
  });
});

describe("reading what a watch is holding", () => {
  const MAYA = "a1111111-0000-4000-8000-000000000001";
  const AT = Date.parse("2026-04-06T09:00:00Z");
  const DAY_MS = 86_400_000;

  /**
   * Two live keys on one node, one of them keyed by a person.
   *
   * Two rather than one deliberately: a response that resolved the wrong
   * component, or attached a name to the wrong key, is still internally
   * consistent with a single-key fixture behind it.
   */
  function holding(): WatchStateResult {
    return {
      outcome: "read",
      journalHead: 420,
      atMs: AT + DAY_MS,
      snapshot: {
        asOfSeq: 412,
        nodes: [
          {
            nodeId: "quiet",
            type: "stateful.wait",
            onCollision: "spawn",
            maxLiveInstances: 2,
            cancelledBy: ["reply"],
            cells: [
              {
                keyHash: "h-person",
                instance: 0,
                key: { person: MAYA },
                state: "live",
                armedAtMs: AT,
                deadlineAtMs: AT + 2 * DAY_MS,
                lastFiredAtMs: null,
                detail: { kind: "wait", firesAtMs: AT + 2 * DAY_MS },
              },
              {
                keyHash: "h-thread",
                instance: 0,
                key: { person: "T-4417" },
                state: "live",
                armedAtMs: AT,
                deadlineAtMs: AT + 3 * DAY_MS,
                lastFiredAtMs: null,
                detail: { kind: "wait", firesAtMs: AT + 3 * DAY_MS },
              },
            ],
          },
        ],
        timers: [
          {
            nodeId: "quiet",
            keyHash: "h-person",
            instance: 0,
            key: { person: MAYA },
            kind: "wait",
            dueAtMs: AT + 2 * DAY_MS,
          },
        ],
        parked: [],
      },
    };
  }

  function seedPerson(): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Maya Reeves', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(MAYA);
  }

  test("returns one snapshot with a moment on it", async () => {
    seedPerson();
    const id = await addWatch("holding-state");
    stateResult = holding();

    const res = await req(`/admin/watch/watches/${id}/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      watch: { id: string; name: string };
      asOf: { at: string; seq: number; journalHead: number };
      nodes: { id: string; cells: number; instances: { components: unknown[] }[] }[];
      timers: { dueAt: string; overdue: boolean }[];
      judge: Record<string, number>;
    };

    expect(body.watch).toEqual({ id, name: "holding-state" });
    // The header the whole page is stated against: one instant, one cursor,
    // and where the producer has reached.
    expect(body.asOf).toEqual({
      at: new Date(AT + DAY_MS).toISOString(),
      seq: 412,
      journalHead: 420,
    });
    expect(body.nodes[0]?.cells).toBe(2);
    // A key component that is a person id acquires a name; one that only looks
    // like an id does not, and keeps its raw value either way.
    expect(body.nodes[0]?.instances[0]?.components).toEqual([
      { name: "person", raw: MAYA, display: "Maya Reeves" },
    ]);
    expect(body.nodes[0]?.instances[1]?.components).toEqual([
      { name: "person", raw: "T-4417", display: null },
    ]);
    expect(body.timers).toHaveLength(1);
    expect(body.timers[0]?.overdue).toBe(false);
    expect(body.judge).toEqual({
      dailyCap: 200,
      perWatchDailyCap: 50,
      spentToday: 7,
      watchSpentToday: 2,
    });
  });

  test("clamps the bound it reads the parked queue with", async () => {
    const id = await addWatch("state-limit");
    stateResult = holding();

    // Negative binds as "no limit" in SQL and a non-integer is a driver error,
    // so neither may reach the store.
    await req(`/admin/watch/watches/${id}/state?limit=-1`);
    await req(`/admin/watch/watches/${id}/state?limit=1.5`);
    await req(`/admin/watch/watches/${id}/state?limit=7`);
    expect(stateRequests.map((request) => request.parkedLimit)).toEqual([200, 200, 7]);
    expect(stateRequests.every((request) => request.watchId === id)).toBe(true);
  });

  test("names the class a parked nomination is waiting on", async () => {
    const id = await addWatch("state-parked");
    const held = holding();
    if (held.outcome !== "read") throw new Error("fixture");
    stateResult = {
      ...held,
      snapshot: {
        ...held.snapshot,
        parked: [{ nodeId: "sift", docId: "doc-1", seq: 400, atMs: AT }],
      },
    };
    // The class lives on the trace, not on the nomination row, so the join is
    // through the pair the two share.
    traces.record(
      {
        watch: id,
        records: [
          {
            seq: 400,
            nodeId: "sift",
            key: "singleton",
            transition: "held" as const,
            failure: "budget" as const,
          },
        ],
        firings: [],
      },
      new Date(AT).toISOString(),
    );

    const res = await req(`/admin/watch/watches/${id}/state`);
    const body = (await res.json()) as { parked: { failure: string | null }[] };
    expect(body.parked).toEqual([
      {
        nodeId: "sift",
        docId: "doc-1",
        seq: 400,
        at: new Date(AT).toISOString(),
        failure: "budget",
      },
    ]);
  });

  test("404s a watch this install does not have", async () => {
    const res = await req("/admin/watch/watches/not-a-watch/state");
    expect(res.status).toBe(404);
    // The runtime is never asked about a definition that is not there.
    expect(stateRequests).toEqual([]);
  });

  test("says plainly when this build cannot read the definition", async () => {
    const id = await addWatch("state-unreadable");
    stateResult = { outcome: "unreadable", why: "nodes must be an array" };
    const res = await req(`/admin/watch/watches/${id}/state`);
    // Not an empty snapshot: the runtime may well be holding cells for it, and
    // reporting none would be a lie in the one direction that matters.
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("cannot read that watch"),
    });
  });

  test("is admin-only, like everything else here", async () => {
    const id = await addWatch("state-scope");
    const res = await req(`/admin/watch/watches/${id}/state`, {}, READ_TOKEN);
    expect(res.status).toBe(403);
  });
});

describe("reading a trace", () => {
  test("clamps a limit SQLite could not bind", async () => {
    // `1.5` is finite and inside every range check, and still a driver error;
    // `-1` binds as "no limit". Neither may reach the statement.
    const id = await addWatch();
    for (const limit of ["1.5", "-1", "0", "abc", "1e9", "Infinity"]) {
      const res = await req(`/admin/watch/watches/${id}/trace?limit=${limit}`);
      expect(res.status, `limit=${limit} was not clamped`).toBe(200);
    }
  });

  test("bounds the firings a single read returns", async () => {
    const id = await addWatch();
    const res = await req(`/admin/watch/watches/${id}/firings?limit=1.5`);
    expect(res.status).toBe(200);
  });

  test("hands back each firing with what it read and what delivery did", async () => {
    const id = await addWatch();
    corpus.set("doc_quote", {
      id: "doc_quote",
      title: "Your quote for the roof",
      sourceId: "gmail:jamie.lopez@example.com",
    });
    recordedFirings = [
      {
        seq: 7,
        nodeId: "mail",
        keyHash: "k1:0",
        firedAt: "2026-05-04T09:15:00.000Z",
        noticedAt: "2026-05-04T09:15:30.000Z",
        payload: { doc_id: "doc_quote" },
        documentIds: ["doc_quote", "doc_deleted_since"],
        forced: false,
      },
    ];
    recordedDeliveries = [
      {
        seq: 7,
        nodeId: "mail",
        keyHash: "k1:0",
        // A historical journal row. `watch_deliveries.kind` is written from
        // whatever the DSL said at firing time, so a watch's history can hold
        // both spellings — nothing compares the column, it is displayed.
        kind: "ios-push",
        attempted: 2,
        delivered: 0,
        error: "APNs delivery failed for all 2 device(s)",
        degraded: null,
        at: "2026-05-04T09:15:31.000Z",
      },
    ];

    const res = await req(`/admin/watch/watches/${id}/firings`);
    const body = (await res.json()) as {
      firings: {
        documents: { id: string; title: string }[];
        delivery?: { delivered: number; error?: string };
      }[];
    };

    // The document is named rather than left as an id, and one the corpus no
    // longer holds is simply absent — a firing can outlive its evidence, and
    // refusing to render the row over that would lose the whole ledger.
    expect(body.firings[0]?.documents).toEqual([
      {
        id: "doc_quote",
        title: "Your quote for the roof",
        sourceId: "gmail:jamie.lopez@example.com",
      },
    ]);
    expect(body.firings[0]?.delivery).toMatchObject({ delivered: 0 });
  });

  test("matches a delivery to its own firing, not to the tick they share", async () => {
    // A broadcast arm re-judges every live cell at one tick's sequence, so two
    // firings can carry the same seq. Keyed on seq alone they would both be
    // handed the first one's outcome.
    const id = await addWatch();
    const firing = {
      seq: 11,
      nodeId: "mail",
      firedAt: "2026-05-04T09:15:00.000Z",
      noticedAt: null,
      payload: {},
      documentIds: [],
      forced: false,
    };
    recordedFirings = [
      { ...firing, keyHash: "k1:0" },
      { ...firing, keyHash: "k2:0" },
    ];
    recordedDeliveries = [
      {
        seq: 11,
        nodeId: "mail",
        keyHash: "k2:0",
        kind: "agent-wake",
        attempted: 1,
        delivered: 1,
        error: null,
        degraded: null,
        at: "2026-05-04T09:15:01.000Z",
      },
    ];

    const res = await req(`/admin/watch/watches/${id}/firings`);
    const body = (await res.json()) as { firings: { delivery?: { kind: string } }[] };

    expect(body.firings[0]?.delivery, "an outcome was handed to a firing it is not about").toBe(
      undefined,
    );
    expect(body.firings[1]?.delivery).toMatchObject({ kind: "agent-wake", delivered: 1 });
  });

  test("404s an id that is not a watch", async () => {
    expect((await req("/admin/watch/watches/nope/trace")).status).toBe(404);
    expect((await req("/admin/watch/watches/nope/firings")).status).toBe(404);
  });
});

/**
 * The cross-watch ledger, which is where an audit of the wake chain starts.
 *
 * The per-watch route answers "what did this watch do" and can only be asked of
 * a watch you already know about. This one answers "what did the install do",
 * and each row carries the whole chain: what fired, what delivering it did, and
 * what the woken workflow said it did about it.
 */
describe("every watch's firings in one read", () => {
  /** One firing, at a chosen instant, from the shared recorded set. */
  function firingAt(seq: number, firedAt: string, keyHash = "k1:0") {
    return {
      seq,
      nodeId: "mail",
      keyHash,
      firedAt,
      noticedAt: null,
      payload: { doc_id: "doc_quote" },
      documentIds: [],
      forced: false,
    };
  }

  test("carries every watch's firings, newest first, each naming its watch", async () => {
    // The deps hand back one recorded set for whichever watch is asked about,
    // so two watches is two labelled copies — which is the property under test:
    // a row that did not name its watch would be unattributable.
    const first = await addWatch("every-email");
    const second = await addWatch("every-parcel");
    recordedFirings = [
      firingAt(7, "2026-05-04T09:15:00.000Z"),
      firingAt(9, "2026-05-04T11:15:00.000Z"),
    ];

    const res = await req("/admin/watch/firings?since=0");
    const body = (await res.json()) as {
      firings: { watchId: string; watchName: string; seq: number }[];
    };

    expect(res.status).toBe(200);
    expect(body.firings.map((f) => f.seq)).toEqual([9, 9, 7, 7]);
    expect(new Set(body.firings.map((f) => f.watchId))).toEqual(new Set([first, second]));
    expect(new Set(body.firings.map((f) => f.watchName))).toEqual(
      new Set(["every-email", "every-parcel"]),
    );
  });

  test("holds the window it was asked for", async () => {
    await addWatch();
    recordedFirings = [
      firingAt(7, "2026-05-04T09:15:00.000Z"),
      firingAt(9, "2026-05-04T11:15:00.000Z"),
    ];

    const res = await req(`/admin/watch/firings?since=${Date.parse("2026-05-04T10:00:00.000Z")}`);
    const body = (await res.json()) as { firings: { seq: number }[] };

    expect(body.firings.map((f) => f.seq)).toEqual([9]);
  });

  test("reads nothing older than a day when nobody says", async () => {
    // The default is a window rather than the whole ledger: a route that read
    // every firing on the install by default is the expensive way to answer a
    // question about this morning.
    await addWatch();
    recordedFirings = [
      firingAt(7, "2020-01-01T00:00:00.000Z"),
      firingAt(9, new Date(Date.now() - 60_000).toISOString()),
    ];

    const body = (await (await req("/admin/watch/firings")).json()) as {
      firings: { seq: number }[];
    };

    expect(body.firings.map((f) => f.seq)).toEqual([9]);
  });

  test("bounds the page, whatever the caller asks for", async () => {
    await addWatch();
    recordedFirings = [
      firingAt(7, "2026-05-04T09:15:00.000Z"),
      firingAt(9, "2026-05-04T11:15:00.000Z"),
    ];

    for (const limit of ["1.5", "-1", "0", "abc", "1e9", "Infinity"]) {
      const res = await req(`/admin/watch/firings?since=0&limit=${limit}`);
      expect(res.status, `limit=${limit} was not clamped`).toBe(200);
    }
    const capped = (await (await req("/admin/watch/firings?since=0&limit=1")).json()) as {
      firings: { seq: number }[];
    };
    expect(capped.firings.map((f) => f.seq)).toEqual([9]);
  });

  test("says what the woken workflow reported, beside what delivery did", async () => {
    // The whole reason this read exists. A firing that was delivered and then
    // ignored looks exactly like one that was delivered and completed, and the
    // difference is the only thing an audit of the wake chain is after.
    const id = await addWatch();
    recordedFirings = [firingAt(7, "2026-05-04T09:15:00.000Z")];
    recordedDeliveries = [
      {
        seq: 7,
        nodeId: "mail",
        keyHash: "k1:0",
        kind: "agent-wake",
        attempted: 1,
        delivered: 1,
        error: null,
        degraded: null,
        at: "2026-05-04T09:15:01.000Z",
      },
    ];
    recordedWorkflows.set(`${id}:7:mail:k1:0`, {
      subscriptionId: "sub_fictional",
      firingId: `${id}:7:mail:k1:0`,
      deliveryStatus: "accepted",
      acceptedAt: 1_777_000_000_000,
      localRunId: "run-4417",
      outcome: {
        status: "nothing_to_do",
        report: "The order had already shipped.",
        reportedAt: 1_777_000_060_000,
      },
    });

    const body = (await (await req("/admin/watch/firings?since=0")).json()) as {
      firings: {
        delivery?: { kind: string; delivered: number };
        workflow?: { deliveryStatus: string; outcome?: { status: string; report: string } };
      }[];
    };

    expect(body.firings[0]?.delivery).toMatchObject({ kind: "agent-wake", delivered: 1 });
    expect(body.firings[0]?.workflow).toMatchObject({
      subscriptionId: "sub_fictional",
      deliveryStatus: "accepted",
      localRunId: "run-4417",
      outcome: { status: "nothing_to_do", report: "The order had already shipped." },
    });
  });

  test("leaves the report off a run that has not made one", async () => {
    // Absent rather than null. A run that has not said what it did is not a run
    // that reported doing nothing, and a reader cannot tell those apart from a
    // field that is present either way.
    const id = await addWatch();
    recordedFirings = [firingAt(7, "2026-05-04T09:15:00.000Z")];
    recordedWorkflows.set(`${id}:7:mail:k1:0`, {
      subscriptionId: "sub_fictional",
      firingId: `${id}:7:mail:k1:0`,
      deliveryStatus: "queued",
      acceptedAt: null,
      localRunId: null,
      outcome: null,
    });

    const body = (await (await req("/admin/watch/firings?since=0")).json()) as {
      firings: { workflow?: Record<string, unknown> }[];
    };

    expect(body.firings[0]?.workflow).toBeDefined();
    expect(body.firings[0]?.workflow).not.toHaveProperty("outcome");
  });

  test("carries no workflow at all for a firing that woke nobody", async () => {
    await addWatch();
    recordedFirings = [firingAt(7, "2026-05-04T09:15:00.000Z")];

    const body = (await (await req("/admin/watch/firings?since=0")).json()) as {
      firings: Record<string, unknown>[];
    };

    expect(body.firings[0]).not.toHaveProperty("workflow");
  });

  test("answers on a gateway whose subscriptions cannot say", async () => {
    // The reader is optional: this surface mounts on installs that have no
    // subscription service wired, and the ledger is still worth reading there.
    await addWatch();
    recordedFirings = [firingAt(7, "2026-05-04T09:15:00.000Z")];
    app = createServer(db, dbPath, {
      port: 0,
      writeGate: directWriteGate(db),
      watchV2Routes: { ...watchV2Routes, workflowOutcomes: undefined },
    } as never);

    const res = await req("/admin/watch/firings?since=0");
    const body = (await res.json()) as { firings: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(body.firings).toHaveLength(1);
    expect(body.firings[0]).not.toHaveProperty("workflow");
  });

  test("is admin-only, like the ledger it reads from", async () => {
    expect((await req("/admin/watch/firings", {}, READ_TOKEN)).status).toBe(403);
  });
});

describe("holding and resuming", () => {
  test("refuses a status that is neither", async () => {
    const id = await addWatch();
    for (const status of ["retired", "", 1, null, undefined]) {
      const res = await req(`/admin/watch/watches/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      expect(res.status, `status ${JSON.stringify(status)} was accepted`).toBe(400);
    }
  });

  test("reports the note the store actually holds", async () => {
    // A hand-built response can say one thing while the store says another, and
    // the next list would disagree with what the operator was just shown.
    const id = await addWatch();
    const res = await req(`/admin/watch/watches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    });
    const { watch } = (await res.json()) as { watch: { status: string; note: string } };
    expect(watch.status).toBe("paused");
    expect(watch.note).toBe(definitions.get(id)?.note);
  });

  test("will not un-retire a watch that already finished", async () => {
    // `once_ever` got its answer, or the horizon passed. Re-activating it would
    // let a watch that has said its piece say it again about whatever arrived
    // since.
    const id = await addWatch();
    definitions.setStatus(id, "retired", "fired once and was done");
    const res = await req(`/admin/watch/watches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(400);
    expect(definitions.get(id)?.status).toBe("retired");
  });

  test("404s an id that is not a watch", async () => {
    const res = await req("/admin/watch/watches/nope", {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(404);
  });

  test("refuses to resume a watch this install can no longer validate", async () => {
    // Without this the resume "works", the very next evaluation re-validates
    // and pauses it again, and the operator is left holding two facts that
    // contradict each other with nothing to say which is current.
    const id = await addWatch();
    db.prepare("DELETE FROM source_document_profiles WHERE source_type = 'gmail'").run();

    const res = await req(`/admin/watch/watches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not validate");
    expect(reactivated, "a watch that cannot run was let go anyway").toEqual([]);
  });

  test("moves past the failed event only when asked, and says which", async () => {
    const id = await addWatch();
    recordedFailure = { seq: 41, nodeId: "mail", failure: "query" };

    const plain = await req(`/admin/watch/watches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    expect(plain.status).toBe(200);
    expect(skipRequests, "a plain resume skipped an event nobody asked it to").toEqual([]);
    expect(((await plain.json()) as { skipped: unknown }).skipped).toBeNull();

    const skipping = await req(`/admin/watch/watches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active", skip: true }),
    });
    expect(skipping.status).toBe(200);
    expect(skipRequests).toEqual([id]);
    expect(((await skipping.json()) as { skipped: { seq: number } }).skipped.seq).toBe(41);
  });

  test("refuses a skip when nothing failed", async () => {
    // Otherwise `skip` becomes a way to nudge a healthy watch past whatever it
    // was about to read next.
    const id = await addWatch();
    const res = await req(`/admin/watch/watches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active", skip: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("nothing a skip can move it past");
  });

  test("refuses a skip on a pause, which has nothing to skip", async () => {
    const id = await addWatch();
    const res = await req(`/admin/watch/watches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused", skip: true }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * Where a watch's firings go.
 *
 * Off is the default and the only way on is to ask for it by name. That is the
 * invariant the whole feature rests on: a firing that interrupts a person is a
 * different thing from a firing that is written down, and nothing should be
 * able to promote one to the other on a watch's behalf.
 */
describe("delivery", () => {
  test("a watch cannot be added with delivery already on", async () => {
    // A definition is a document, and documents arrive from places that are not
    // an operator typing. Refusing here means the only way a watch acquires the
    // ability to interrupt someone is somebody asking for it.
    const dsl = emailWatch(await fingerprint()) as { watch: Record<string, unknown> };
    dsl.watch.delivery = { kind: "omnesis-notify" };
    const res = await req("/admin/watch/watches", {
      method: "POST",
      body: JSON.stringify({ dsl }),
    });

    expect(res.status, "a watch was installed already notifying").toBe(400);
    expect(await res.text()).toContain("watch deliver");
  });

  test("turns on and off, and says which", async () => {
    const id = await addWatch();
    const on = await req(`/admin/watch/watches/${id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({ kind: "omnesis-notify" }),
    });
    expect(on.status).toBe(200);
    expect(
      (definitions.get(id)?.dsl as { watch: { delivery?: { kind: string } } }).watch.delivery?.kind,
    ).toBe("omnesis-notify");

    const off = await req(`/admin/watch/watches/${id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({ kind: null }),
    });
    expect(off.status).toBe(200);
    // Removed rather than set to a "none" kind, so a watch that delivers
    // nowhere reads exactly like one written without the block.
    expect(
      (definitions.get(id)?.dsl as { watch: { delivery?: unknown } }).watch.delivery,
    ).toBeUndefined();
  });

  test("accepts the old spelling of the notify kind and stores the new one", async () => {
    // An operator has `--to ios-push` in an alias or a note, and the CLI is
    // not the only caller of this route. What lands on disk is the current
    // spelling either way, so the compat is one hop wide rather than a second
    // vocabulary the whole runtime has to keep answering for.
    const id = await addWatch();

    const res = await req(`/admin/watch/watches/${id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({ kind: "ios-push" }),
    });

    expect(res.status).toBe(200);
    expect(
      (definitions.get(id)?.dsl as { watch: { delivery?: { kind: string } } }).watch.delivery?.kind,
    ).toBe("omnesis-notify");
  });

  test("refuses a kind it does not know", async () => {
    const id = await addWatch();
    for (const kind of ["email", "", 1, undefined]) {
      const res = await req(`/admin/watch/watches/${id}/delivery`, {
        method: "PUT",
        body: JSON.stringify({ kind }),
      });
      expect(res.status, `kind ${JSON.stringify(kind)} was accepted`).toBe(400);
    }
  });

  test("stores the referents a wake's instruction names", async () => {
    // The instruction says "the conversation this came from"; the referent is
    // the only thing that says which one. Written into the definition, because
    // that is what the anchor is read from.
    const id = await addWatch();

    const res = await req(`/admin/watch/watches/${id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({
        kind: "agent-wake",
        integration: "openclaw",
        instruction: "reply in the conversation this came from",
        bindings: { conversation: "thread-8821" },
      }),
    });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(
      (definitions.get(id)?.dsl as { watch: { delivery?: { bindings?: unknown } } }).watch.delivery
        ?.bindings,
    ).toEqual({ conversation: "thread-8821" });
  });

  test("refuses referents on a kind that carries no instruction", async () => {
    // Refused rather than dropped: a caller who sent them believes the wake
    // carries them, and a notify has nothing to point at.
    const id = await addWatch();

    const res = await req(`/admin/watch/watches/${id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({ kind: "omnesis-notify", bindings: { conversation: "thread-8821" } }),
    });

    expect(res.status).toBe(400);
  });

  test("refuses a referent the DSL would not accept", async () => {
    const id = await addWatch();

    for (const bindings of [
      { conversation: "x".repeat(513) },
      { ["k".repeat(65)]: "thread-8821" },
      { conversation: 7 },
      { conversation: "" },
    ]) {
      const res = await req(`/admin/watch/watches/${id}/delivery`, {
        method: "PUT",
        body: JSON.stringify({
          kind: "agent-wake",
          integration: "openclaw",
          instruction: "reply in the conversation this came from",
          bindings,
        }),
      });
      expect(res.status, `${JSON.stringify(bindings)} was accepted`).toBe(400);
    }
  });

  test("404s an id that is not a watch", async () => {
    const res = await req("/admin/watch/watches/nope/delivery", {
      method: "PUT",
      body: JSON.stringify({ kind: "omnesis-notify" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("removing a watch", () => {
  test("takes the runtime's state and its trace with it", async () => {
    const id = await addWatch();
    traces.record(
      {
        watch: id,
        firings: [],
        records: [{ seq: 1, nodeId: "mail", key: "singleton", transition: "fired" }],
      },
      "2026-03-01T09:00:00Z",
    );
    expect(traces.count(id)).toBe(1);

    const res = await req(`/admin/watch/watches/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(definitions.get(id)).toBeNull();
    expect(forgotten, "the runtime was not told to forget it").toEqual([id]);
    expect(traces.count(id), "a removed watch kept its trace").toBe(0);
  });

  test("404s an id that is not a watch", async () => {
    expect((await req("/admin/watch/watches/nope", { method: "DELETE" })).status).toBe(404);
  });
});

describe("the gate", () => {
  test("hides the whole surface when the feature is off", async () => {
    const hidden = await addWatch();
    // 404 before authentication, so an install with the feature off is
    // indistinguishable from one that never had it.
    app = createServer(db, dbPath, {
      port: 0,
      writeGate: directWriteGate(db),
      // The same dependencies, switched off. A second hand-written object here
      // would be a fixture nothing checks against the type, and the routes it
      // stands for are the ones this case asserts are absent.
      watchV2Routes: { ...watchV2Routes, enabled: () => false },
    } as never);

    expect((await req("/admin/watch/watches")).status).toBe(404);
    // Without a token at all: still 404, not 401.
    expect((await app.request("/admin/watch/watches")).status).toBe(404);
    // And the route that carries the DSL, which is the one worth hiding: it
    // holds the operator's own propositions, person ids and search queries.
    // The gate is one wildcard `use`, so this also pins the ordering it
    // depends on — a route registered above that middleware would not run it.
    expect((await req(`/admin/watch/watches/${hidden}`)).status).toBe(404);
    expect((await app.request(`/admin/watch/watches/${hidden}`)).status).toBe(404);
  });
});

describe("listing watches", () => {
  test("carries what each watch is for, without carrying its definition", async () => {
    // A name is a slug. Without the request beside it, the only way to answer
    // "which of these catches the thing I care about" is to fetch every watch
    // and read its DSL — from a phone, on a list that is polled.
    const dsl = emailWatch(await fingerprint(), "listing-unanswered") as {
      watch: Record<string, unknown>;
    };
    dsl.watch["nl_query"] = "Tell me when an email arrives.";
    const created = await req("/admin/watch/watches", {
      method: "POST",
      body: JSON.stringify({ dsl }),
    });
    expect(created.status, await created.text()).toBe(201);

    const res = await req("/admin/watch/watches");
    const body = (await res.json()) as {
      watches: Array<{ name: string; request: string | null; dsl?: unknown }>;
    };
    const watch = body.watches.find((w) => w.name === "listing-unanswered");

    expect(watch?.request).toBe("Tell me when an email arrives.");
    expect(watch, "the polled listing started carrying the whole DSL").not.toHaveProperty("dsl");
  });

  test("says null for a watch that never wrote one", async () => {
    await addWatch("no-request");
    const res = await req("/admin/watch/watches");
    const body = (await res.json()) as { watches: Array<{ name: string; request: string | null }> };

    expect(body.watches.find((w) => w.name === "no-request")?.request).toBeNull();
  });

  test("carries a verdict on every row, and the same one on the watch's own page", async () => {
    // The seam the pure derivation and the row renderer cannot test between
    // them: a route that computed nothing, or dropped it, would leave both
    // their suites green and every screen saying nothing at all.
    const id = await addWatch("judged-by-nobody");
    // Old enough to be judged: the store stamps `addedAt` at add time, and the
    // verdict refuses to call a watch never-matched before it has had a week.
    adminDb
      .prepare("UPDATE watch_defs SET added_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", id);
    liveState = {
      journalHead: 400,
      held: new Map([
        [
          id,
          {
            keys: 0,
            cells: 0,
            holdingKeys: 0,
            holdingCells: 0,
            timers: 0,
            nextDueAtMs: null,
            cursorSeq: 400,
          },
        ],
      ]),
    };
    traces.record(
      {
        watch: id,
        records: Array.from({ length: 300 }, (_, i) => ({
          seq: i,
          nodeId: "mail",
          key: "singleton",
          transition: "ignored" as const,
        })),
        firings: [],
      } as never,
      "2026-05-04T09:15:30.000Z",
    );

    const list = (await (await req("/admin/watch/watches")).json()) as {
      watches: { name: string; verdict: { name: string; because: string } }[];
    };
    const row = list.watches.find((w) => w.name === "judged-by-nobody");
    expect(row?.verdict.name).toBe("never-matched");
    expect(row?.verdict.because).toContain("300 events");

    // The row and the page it opens must not describe one watch two ways.
    const detail = (await (await req(`/admin/watch/watches/${id}`)).json()) as {
      watch: { verdict: { name: string; because: string } };
    };
    expect(detail.watch.verdict).toEqual(row?.verdict);

    const report = (await (await req("/admin/watch/report")).json()) as {
      watches: { name: string; verdict: { name: string } }[];
    };
    expect(report.watches.find((w) => w.name === "judged-by-nobody")?.verdict.name).toBe(
      "never-matched",
    );
  });

  test("does not diagnose a watch nothing is evaluating", async () => {
    // A watch paused on a thrown node keeps ageing. Every rule that reads
    // silence as evidence about how it was written would eventually tell the
    // operator to widen an arm that has not been offered anything since it
    // stopped — and the status, which every surface already shows, is the
    // whole diagnosis.
    const id = await addWatch("stopped-on-a-throw");
    adminDb
      .prepare("UPDATE watch_defs SET added_at = ?, status = 'paused' WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", id);
    traces.record(
      {
        watch: id,
        records: Array.from({ length: 300 }, (_, i) => ({
          seq: i,
          nodeId: "mail",
          key: "singleton",
          transition: "ignored" as const,
        })),
        firings: [],
      } as never,
      "2026-05-04T09:15:30.000Z",
    );

    const list = (await (await req("/admin/watch/watches")).json()) as {
      watches: { name: string; verdict: { name: string; because: string } }[];
    };
    const row = list.watches.find((w) => w.name === "stopped-on-a-throw");
    expect(row?.verdict.name).toBe("stopped");
    expect(row?.verdict.because).toContain("paused");
  });

  test("does not say a husk population is being waited on", async () => {
    // Three cells and nothing holding: a cooldown that fired months ago, a
    // drained window. The verdict's sentence is the one that reads wrong —
    // "holding something, and waiting for the rest of it" about a watch that
    // is waiting for nothing.
    const id = await addWatch("husks-only");
    liveState = {
      journalHead: 400,
      held: new Map([
        [
          id,
          {
            keys: 3,
            cells: 3,
            holdingKeys: 0,
            holdingCells: 0,
            timers: 0,
            nextDueAtMs: null,
            cursorSeq: 400,
          },
        ],
      ]),
    };

    const list = (await (await req("/admin/watch/watches")).json()) as {
      watches: { name: string; verdict: { name: string; because: string } }[];
    };
    const row = list.watches.find((w) => w.name === "husks-only");
    expect(row?.verdict.name).toBe("resting");
    expect(row?.verdict.because).not.toContain("holding something");
  });

  test("carries what each watch is holding, so a list can say which are awake", async () => {
    const holding = await addWatch("holding");
    await addWatch("resting");
    liveState = {
      journalHead: 4400,
      held: new Map([
        [
          holding,
          {
            // A population larger than what is still holding: five of the keys
            // are cells a node keeps after they stopped waiting for anything.
            keys: 14,
            cells: 21,
            holdingKeys: 9,
            holdingCells: 12,
            timers: 14,
            nextDueAtMs: Date.parse(NEXT_DUE),
            cursorSeq: 4100,
          },
        ],
      ]),
    };

    const res = await req("/admin/watch/watches");
    const body = (await res.json()) as {
      journalHead: number;
      watches: Array<{ name: string; live: Record<string, unknown> }>;
    };
    const of = (name: string) => body.watches.find((w) => w.name === name)?.live;

    expect(of("holding")).toEqual({
      keys: 14,
      cells: 21,
      // Both, because a surface needs them apart: the mark claims the watch is
      // tracking something, and only the holding count can make that claim.
      holdingKeys: 9,
      holdingCells: 12,
      timers: 14,
      nextDueAt: NEXT_DUE,
      cursorSeq: 4100,
    });
    // A watch the aggregate never mentioned holds nothing. Zeros rather than an
    // absent field: a client would have to decide what a missing one meant, and
    // "nothing live" is a real answer rather than a gap.
    //
    // The cursor is the exception, and null rather than zero. A watch is added
    // at the journal head and its cursor is seeded on the first pass that
    // evaluates it, so no row means "has not started" — where zero would mean
    // "at the beginning of the journal" and accuse it of a backlog of
    // everything ever indexed.
    expect(of("resting")).toEqual({
      keys: 0,
      cells: 0,
      holdingKeys: 0,
      holdingCells: 0,
      timers: 0,
      nextDueAt: null,
      cursorSeq: null,
    });
    // The head comes from the same read as the cells, not from a second one —
    // it is what each row's cursor is compared against, and a head from a later
    // moment would report a caught-up watch as behind.
    expect(body.journalHead).toBe(4400);
  });
});

describe("reading one watch", () => {
  test("returns the spec it is actually running", async () => {
    // The listing omits the DSL because it is polled and the field is large.
    // But the stored definition is the authority on what a watch does — stored
    // verbatim and never reinterpreted — so without this the only way to read
    // what an install runs is to open its database.
    const id = await addWatch();
    const res = await req(`/admin/watch/watches/${id}`);
    expect(res.status).toBe(200);
    const { watch } = (await res.json()) as { watch: { id: string; dsl: unknown } };
    expect(watch.id).toBe(id);
    expect(watch.dsl, "the response carried no DSL — the whole point of the route").toBeTruthy();
    expect((watch.dsl as { watch: { name: string } }).watch.name).toBe("every-email");
  });

  test("returns the stored spec, not whatever was sent most recently", async () => {
    // Two watches from the same file differ only by id, so a route that
    // returned the wrong one would still look plausible.
    const first = await addWatch("one");
    const second = await addWatch("two");
    const res = await req(`/admin/watch/watches/${first}`);
    const { watch } = (await res.json()) as { watch: { id: string; name: string } };
    expect(watch.id).toBe(first);
    expect(watch.name).toBe("one");
    expect(watch.id).not.toBe(second);
  });

  test("404s an id that is not a watch", async () => {
    expect((await req("/admin/watch/watches/nope")).status).toBe(404);
  });

  test("is not reachable with a read token", async () => {
    const id = await addWatch();
    expect((await req(`/admin/watch/watches/${id}`, {}, READ_TOKEN)).status).toBe(403);
  });
});

describe("re-stamping after the ontology moves", () => {
  /** A watch whose stored fingerprint is deliberately not the current one. */
  async function addStale(name: string): Promise<string> {
    const id = await addWatch(name);
    const stored = definitions.get(id)!;
    const dsl = JSON.parse(JSON.stringify(stored.dsl)) as { watch: Record<string, unknown> };
    dsl.watch["ontology_fingerprint"] = "a-fingerprint-from-before";
    definitions.put({ ...stored, dsl, status: "paused", note: "ontology moved" });
    return id;
  }

  test("records the surface the operator just approved, so the approval sticks", async () => {
    // Re-stamping is the operator saying "yes, I have looked at this surface".
    // Without recording what they looked at, the runtime goes on holding the
    // surface from before the change — and pauses the watch again at the next
    // unrelated drift, for a move that had already been approved.
    const id = await addStale("approved-by-hand");
    expect(definitions.get(id)?.referenceDigest, "the fixture began with a digest").toBeNull();

    expect((await req("/admin/watch/restamp", { method: "POST" })).status).toBe(200);

    expect(definitions.get(id)?.referenceDigest).not.toBeNull();
  });

  test("re-stamps and resumes a watch that still validates", async () => {
    const id = await addStale("still-good");
    const res = await req("/admin/watch/restamp", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fingerprint: string;
      restamped: { name: string; resumed: boolean }[];
      refused: unknown[];
    };

    expect(body.refused).toEqual([]);
    expect(body.restamped.map((w) => w.name)).toContain("still-good");
    expect(body.restamped.find((w) => w.name === "still-good")?.resumed).toBe(true);

    const after = definitions.get(id)!;
    expect(after.status, "a re-stamped watch was left paused").toBe("active");
    expect(
      (after.dsl as { watch: { ontology_fingerprint: string } }).watch.ontology_fingerprint,
    ).toBe(body.fingerprint);
  });

  test("refuses a watch that no longer validates, and leaves it alone", async () => {
    // The property that makes this safe to run in bulk. A watch naming a source
    // the install no longer has must not be blessed with a fingerprint saying
    // it was checked against a world it was never checked against.
    const id = await addStale("names-a-missing-source");
    const stored = definitions.get(id)!;
    const dsl = JSON.parse(JSON.stringify(stored.dsl)) as {
      watch: { nodes: { filter: { source: string } }[]; ontology_fingerprint: string };
    };
    dsl.watch.nodes[0].filter.source = "a-source-this-install-does-not-have";
    definitions.put({ ...stored, dsl });

    const res = await req("/admin/watch/restamp", { method: "POST" });
    const body = (await res.json()) as {
      restamped: { name: string }[];
      refused: { name: string; diagnostics: unknown[] }[];
    };

    expect(body.restamped.map((w) => w.name)).not.toContain("names-a-missing-source");
    const refused = body.refused.find((w) => w.name === "names-a-missing-source");
    expect(refused, "a watch that cannot validate was silently re-stamped").toBeDefined();
    expect(refused!.diagnostics.length).toBeGreaterThan(0);

    const after = definitions.get(id)!;
    expect(after.status, "a refused watch was resumed anyway").toBe("paused");
    expect(
      (after.dsl as { watch: { ontology_fingerprint: string } }).watch.ontology_fingerprint,
      "a refused watch was re-stamped anyway",
    ).toBe("a-fingerprint-from-before");
  });

  test("does not resurrect a watch the engine retired while it was working", async () => {
    // The lease is yielded once per watch, which is long enough for the engine
    // to retire one that just fired. Acting on the list taken before the loop
    // began would set that watch active again and wipe the note saying why it
    // stopped — a `once_ever` watch speaking a second time.
    const first = await addStale("aaa-first");
    const second = await addStale("bbb-second");
    const realGet = definitions.get.bind(definitions);
    let turns = 0;
    definitions.get = ((id: string) => {
      // Retire the *other* watch as soon as the first one is being written.
      if (turns++ === 0) definitions.setStatus(second, "retired", "fired once and was done");
      return realGet(id);
    }) as typeof definitions.get;

    const res = await req("/admin/watch/restamp", { method: "POST" });
    const body = (await res.json()) as {
      restamped: { name: string }[];
      skipped: { name: string; reason: string }[];
    };
    definitions.get = realGet;

    expect(body.restamped.map((w) => w.name)).toContain("aaa-first");
    expect(
      body.restamped.map((w) => w.name),
      "a retired watch was re-stamped anyway",
    ).not.toContain("bbb-second");
    const after = definitions.get(second)!;
    expect(after.status, "a retired watch was brought back to life").toBe("retired");
    expect(after.note, "the reason it retired was wiped").toBe("fired once and was done");
    expect(reactivated, "a retired watch had its runtime flag raised").not.toContain(second);
    void first;
  });

  test("records the watch that failed and finishes the rest", async () => {
    // A bulk pass that abandons the loop on the first failure leaves some
    // watches re-stamped and some not, with nothing said about which. Here the
    // store throws for one watch — a decode failure, a locked row — and the
    // pass has to survive it and name it.
    await addStale("aaa-fine");
    const doomed = await addStale("bbb-throws");
    const realGet = definitions.get.bind(definitions);
    definitions.get = ((id: string) => {
      if (id === doomed) throw new Error("this row will not read");
      return realGet(id);
    }) as typeof definitions.get;

    const res = await req("/admin/watch/restamp", { method: "POST" });
    definitions.get = realGet;

    expect(res.status, "one failing watch took the whole pass down").toBe(200);
    const body = (await res.json()) as {
      restamped: { name: string }[];
      refused: { name: string; diagnostics: { code?: string; message?: string }[] }[];
    };
    expect(
      body.restamped.map((w) => w.name),
      "the healthy watch was abandoned",
    ).toContain("aaa-fine");
    const named = body.refused.find((w) => w.name === "bbb-throws");
    expect(named, "the failing watch went unreported").toBeDefined();
    expect(named?.diagnostics[0]?.message).toContain("will not read");
  });

  test("leaves the note of a watch that was already running", async () => {
    // Resuming a held watch clears its note, which is right — it is no longer
    // held. A watch that was already active is not being resumed, so its note
    // is somebody else's and must survive being re-stamped.
    const id = await addWatch("already-running");
    const stored = definitions.get(id)!;
    const dsl = JSON.parse(JSON.stringify(stored.dsl)) as { watch: Record<string, unknown> };
    dsl.watch["ontology_fingerprint"] = "a-fingerprint-from-before";
    definitions.put({ ...stored, dsl, status: "active", note: "a note worth keeping" });

    await req("/admin/watch/restamp", { method: "POST" });
    const after = definitions.get(id)!;
    expect(after.note, "re-stamping wrote over a note it did not own").toBe("a note worth keeping");
    expect(after.status).toBe("active");
  });

  test("writes only through the lease", async () => {
    // A definition write outside it joins whatever transaction the engine has
    // open, and can be rolled back after this handler has already answered 200.
    await addStale("through-the-lease");
    const before = leaseTurns;
    await req("/admin/watch/restamp", { method: "POST" });
    expect(leaseTurns, "a definition was written outside the write lease").toBeGreaterThan(before);
  });

  test("raises the runtime flag for what it resumes, and not for what it refuses", async () => {
    const resumable = await addStale("resumable");
    const broken = await addStale("still-broken");
    const stored = definitions.get(broken)!;
    const dsl = JSON.parse(JSON.stringify(stored.dsl)) as {
      watch: { nodes: { filter: { source: string } }[] };
    };
    dsl.watch.nodes[0].filter.source = "a-source-this-install-does-not-have";
    definitions.put({ ...stored, dsl });

    await req("/admin/watch/restamp", { method: "POST" });
    expect(reactivated, "a resumed watch was left with its runtime flag down").toContain(resumable);
    expect(reactivated, "a refused watch was reactivated").not.toContain(broken);
  });

  test("keeps everything else about a re-stamped watch, including its note", async () => {
    // `fromSeq` deliberately non-zero: a test whose watches all start at zero
    // compares zero to zero and would pass however badly this behaved.
    const id = await addWatch("keeps-its-past");
    const stored = definitions.get(id)!;
    definitions.put({ ...stored, fromSeq: 4242, status: "paused", note: "held for a reason" });

    await req("/admin/watch/restamp", { method: "POST" });
    const after = definitions.get(id)!;
    expect(after.fromSeq, "a re-stamped watch lost its starting point").toBe(4242);
    expect(after.addedAt).toBe(stored.addedAt);
  });

  test("re-arms a watch it resumes from an unarmed hold, and holds it again on failure", async () => {
    // Re-stamping was never why this watch stopped — its wake record could not
    // be minted. Resuming it clears the note, which is the only evidence of
    // why, and the fingerprint has nothing to do with the arming. Without the
    // retry it goes back to active with no record: evaluating, judging,
    // spending its budget and waking nobody, with the reason erased.
    const id = await addStale("wakes-nobody");
    const stored = definitions.get(id)!;
    const dsl = JSON.parse(JSON.stringify(stored.dsl)) as { watch: Record<string, unknown> };
    dsl.watch["delivery"] = {
      kind: "agent-wake",
      integration: "example-harness",
      instruction: "Summarise it and file the thread.",
    };
    definitions.put({ ...stored, dsl, status: "paused", note: ANCHOR_UNMINTED_NOTE });

    const res = await req("/admin/watch/restamp", { method: "POST" });
    const body = (await res.json()) as {
      restamped: { name: string; resumed: boolean }[];
      refused: { name: string }[];
    };

    // Asserted first: a watch refused for its DSL never reaches the resume
    // path, and would leave the state below looking exactly like a pass.
    expect(body.refused.map((w) => w.name)).not.toContain("wakes-nobody");
    // `setWakeAnchor` mints nothing in this suite, so the retry fails and the
    // watch is held again with the reason back.
    const after = definitions.get(id)!;
    expect(after.status, "an unarmable watch was left running by a re-stamp").toBe("paused");
    expect(after.note).toBe(ANCHOR_UNMINTED_NOTE);
    // And the report says what it is rather than what the pass attempted.
    expect(body.restamped.find((w) => w.name === "wakes-nobody")?.resumed).toBe(false);
  });

  test("still resumes a drifted watch that wakes nobody", async () => {
    // The guard above must not cost the ordinary case: a watch stopped by
    // drift has nothing to arm, and the retry has no opinion about it.
    const id = await addStale("ordinary-drift");
    await req("/admin/watch/restamp", { method: "POST" });
    expect(definitions.get(id)!.status).toBe("active");
    expect(definitions.get(id)!.note).toBeNull();
  });

  test("serves what the judge was asked and what it answered", async () => {
    const id = await addWatch("judged-by-a-model");
    traces.recordJudgeExchange({
      watchId: id,
      nodeId: "mail",
      key: "singleton",
      subject: "doc-1",
      verdict: "declined",
      prompt: "Does this email confirm a booked date?",
      reply: '{"decision":"not_matched"}',
      ms: 120,
      at: "2026-03-01T09:00:00.000Z",
    });

    const res = await req(`/admin/watch/watches/${id}/judge-exchanges`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exchanges: { prompt: string; reply: string; verdict: string; ms: number }[];
    };
    expect(body.exchanges).toHaveLength(1);
    expect(body.exchanges[0]?.prompt).toContain("confirm a booked date");
    expect(body.exchanges[0]?.verdict).toBe("declined");
    expect(body.exchanges[0]?.ms).toBe(120);
  });

  test("tells a trace reader whether there is an exchange behind the records", async () => {
    // A judge leaves no transition of its own — its decision surfaces as the
    // node firing or holding — so nothing in the records says the words were
    // kept, and a reader who is not told does not know to look.
    const id = await addWatch("nothing-judged-yet");
    const before = (await (await req(`/admin/watch/watches/${id}/trace`)).json()) as {
      judgeExchanges: boolean;
    };
    expect(before.judgeExchanges).toBe(false);

    traces.recordJudgeExchange({
      watchId: id,
      nodeId: "mail",
      key: "singleton",
      subject: "doc-1",
      verdict: "matched",
      prompt: "Is this a quote?",
      reply: '{"decision":"matched"}',
      ms: 10,
      at: "2026-03-01T09:00:00.000Z",
    });
    const after = (await (await req(`/admin/watch/watches/${id}/trace`)).json()) as {
      judgeExchanges: boolean;
    };
    expect(after.judgeExchanges).toBe(true);
  });

  test("leaves a retired watch retired", async () => {
    // Retired is finished, not held. Re-stamping one would let a watch that has
    // already said its piece speak again about whatever arrived since.
    const id = await addWatch("finished");
    definitions.setStatus(id, "retired", "once_ever fired");

    const res = await req("/admin/watch/restamp", { method: "POST" });
    const body = (await res.json()) as { skipped: { name: string; reason: string }[] };
    expect(body.skipped.map((w) => w.name)).toContain("finished");
    expect(definitions.get(id)!.status).toBe("retired");
  });

  test("changes only the fingerprint", async () => {
    // A re-stamp that edited anything else would be a different watch wearing
    // the history of the old one.
    const id = await addStale("unchanged-otherwise");
    const before = definitions.get(id)!;
    await req("/admin/watch/restamp", { method: "POST" });
    const after = definitions.get(id)!;

    const strip = (dsl: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(dsl)) as { watch: Record<string, unknown> };
      delete copy.watch["ontology_fingerprint"];
      return copy;
    };
    expect(strip(after.dsl)).toEqual(strip(before.dsl));
    expect(after.name).toBe(before.name);
    expect(after.fromSeq).toBe(before.fromSeq);
    expect(after.addedAt).toBe(before.addedAt);
  });
});

describe("trying a candidate before storing it", () => {
  test("probes a candidate that was never stored", async () => {
    const res = await req("/admin/watch/preflight", {
      method: "POST",
      body: JSON.stringify({ dsl: emailWatch(await fingerprint(), "a-candidate") }),
    });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(preflightRequests, "the candidate never reached the engine").toHaveLength(1);
    // Nothing was stored: the point of asking before installing.
    expect(definitions.list()).toHaveLength(0);
  });

  test("refuses a candidate carrying a delivery block", async () => {
    // Trying a watch out is not a way to acquire the ability to interrupt
    // somebody — the same rule the add route enforces.
    const dsl = emailWatch(await fingerprint()) as { watch: Record<string, unknown> };
    dsl.watch.delivery = { kind: "omnesis-notify" };

    const res = await req("/admin/watch/preflight", {
      method: "POST",
      body: JSON.stringify({ dsl }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("watch deliver");
    expect(preflightRequests).toEqual([]);
  });

  test("refuses something that is not a watch at all", async () => {
    const res = await req("/admin/watch/preflight", {
      method: "POST",
      body: JSON.stringify({ dsl: { watch: { name: "no-nodes" } } }),
    });

    expect(res.status).toBe(400);
    expect(preflightRequests).toEqual([]);
  });

  test("needs the admin scope", async () => {
    const res = await req(
      "/admin/watch/preflight",
      { method: "POST", body: JSON.stringify({ dsl: emailWatch(await fingerprint()) }) },
      READ_TOKEN,
    );

    expect(res.status).toBe(403);
    expect(preflightRequests).toEqual([]);
  });
});

describe("firing a watch by hand", () => {
  test("fires, and reports where it went", async () => {
    const id = await addWatch("provable-watch");

    const res = await req(`/admin/watch/watches/${id}/fire`, {
      method: "POST",
      body: JSON.stringify({ documentIds: ["d1"] }),
    });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ seq: -1, delivered: 1, suppressed: 0 });
    expect(fireRequests).toEqual([{ watchId: id, input: { documentIds: ["d1"] } }]);
  });

  test("refuses a watch that delivers nowhere, naming what to do about it", async () => {
    // The commonest way to reach for this is on a watch that was never wired
    // to deliver, and a firing recorded into one goes nowhere while reporting
    // success — which reads as the delivery path being broken.
    const id = await addWatch("shadow-watch");
    fireResult = { outcome: "delivers-nowhere" };

    const res = await req(`/admin/watch/watches/${id}/fire`, { method: "POST", body: "{}" });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("watch deliver");
  });

  test("404s an id that is not a watch", async () => {
    const res = await req("/admin/watch/watches/nope/fire", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  test("refuses a watch the runtime is not running, naming what to do", async () => {
    const id = await addWatch("held-watch");
    fireResult = { outcome: "not-active", status: "paused" };

    const res = await req(`/admin/watch/watches/${id}/fire`, { method: "POST", body: "{}" });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("watch resume");
  });

  test("carries an operator-chosen payload through", async () => {
    const id = await addWatch("payload-watch");

    await req(`/admin/watch/watches/${id}/fire`, {
      method: "POST",
      body: JSON.stringify({ payload: { note: "checking the path" } }),
    });

    expect(fireRequests[0]?.input).toEqual({ payload: { note: "checking the path" } });
  });

  test("refuses a body it does not understand rather than firing on a guess", async () => {
    const id = await addWatch("strict-watch");

    const res = await req(`/admin/watch/watches/${id}/fire`, {
      method: "POST",
      body: JSON.stringify({ documentIds: "d1", surprise: true }),
    });

    expect(res.status).toBe(400);
    expect(fireRequests, "a malformed body still fired the watch").toEqual([]);
  });

  test("needs the admin scope", async () => {
    const id = await addWatch("guarded-watch");

    const res = await req(
      `/admin/watch/watches/${id}/fire`,
      { method: "POST", body: "{}" },
      READ_TOKEN,
    );

    expect(res.status).toBe(403);
    expect(fireRequests).toEqual([]);
  });
});

/**
 * The history projection — one entry per journal event, joined to the ledger.
 *
 * The fixtures are deliberately multi-key and multi-cell. A single-instance
 * trace reads the same however the grouping is written, so it would pass over
 * exactly the bug this projection can have: folding two keys' verdicts onto one
 * node and reporting one outcome for a moment that produced two.
 */
describe("projecting the path an event took", () => {
  /** Every record of one event shares an `at`, because the host writes it once. */
  function recordEvent(
    watchId: string,
    at: string,
    records: {
      seq: number;
      nodeId: string;
      key: string;
      transition: string;
      detail?: string;
      failure?: FailureClass;
    }[],
  ): void {
    traces.record({ watch: watchId, records, firings: [] } as never, at);
  }

  /**
   * Four events and a firing older than the trace remembers.
   *
   * Event 12 touches two keys at once, as a tick over a live population does.
   * Event 13 is the case this lens exists for: considered, and held in the
   * judge's own words. Event 14 is a nomination the budget parked rather than a
   * judgement. The timer at -1 fires, and happens *after* all of them.
   */
  async function history(): Promise<{
    id: string;
    body: {
      trace: { records: number; retained: number };
      paths: {
        seq: number;
        at: string;
        timer: boolean;
        traceRetained: boolean;
        outcome: string;
        forced: boolean;
        keys: string[];
        nodes: {
          nodeId: string;
          key: string;
          verdict: string;
          detail: string | null;
          failure: string | null;
          steps: { transition: string; detail: string | null }[];
        }[];
        firings: {
          nodeId: string;
          documents: { id: string; title: string }[];
          delivery?: { kind: string; delivered: number };
        }[];
      }[];
    };
  }> {
    const id = await addWatch();
    corpus.set("doc_quote", {
      id: "doc_quote",
      title: "Re: roof quote",
      sourceId: "gmail:jamie.lopez@example.com",
    });

    recordEvent(id, "2026-05-04T09:15:30.000Z", [
      { seq: 12, nodeId: "mail", key: "person=maya", transition: "armed" },
      { seq: 12, nodeId: "mail", key: "person=jamie", transition: "armed" },
      { seq: 12, nodeId: "unanswered_2d", key: "person=maya", transition: "armed" },
      {
        seq: 12,
        nodeId: "unanswered_2d",
        key: "person=jamie",
        transition: "ignored",
        detail: "a cell is already live under this key",
      },
    ]);
    recordEvent(id, "2026-05-04T10:02:00.000Z", [
      { seq: 13, nodeId: "mail", key: "person=david", transition: "armed" },
      { seq: 13, nodeId: "judge", key: "person=david", transition: "armed" },
      {
        seq: 13,
        nodeId: "judge",
        key: "person=david",
        transition: "held",
        detail: "The thread already carries a reply from you, so nothing is outstanding.",
      },
    ]);
    recordEvent(id, "2026-05-04T10:30:00.000Z", [
      {
        seq: 14,
        nodeId: "judge",
        key: "person=maya",
        transition: "held",
        detail: "today's allowance is spent",
        failure: "budget",
      },
    ]);
    recordEvent(id, "2026-05-04T11:45:00.000Z", [
      {
        seq: -1,
        nodeId: "unanswered_2d",
        key: "person=maya",
        transition: "fired",
        detail: "the wait elapsed",
      },
      { seq: -1, nodeId: "notify", key: "singleton", transition: "fired" },
    ]);

    recordedFirings = [
      {
        // Older than anything the trace still holds.
        seq: 3,
        nodeId: "notify",
        keyHash: "rolled:0",
        firedAt: "2026-05-01T08:00:00.000Z",
        noticedAt: "2026-05-01T08:00:05.000Z",
        payload: {},
        documentIds: [],
        forced: false,
      },
      {
        seq: -1,
        nodeId: "notify",
        keyHash: "waitmaya:0",
        firedAt: "2026-05-04T11:45:00.000Z",
        noticedAt: "2026-05-04T11:45:02.000Z",
        payload: { doc_id: "doc_quote" },
        documentIds: ["doc_quote", "doc_deleted_since"],
        forced: false,
      },
    ];
    recordedDeliveries = [
      {
        seq: -1,
        nodeId: "notify",
        keyHash: "waitmaya:0",
        // The old spelling, as a historical row holds it.
        kind: "ios-push",
        attempted: 1,
        delivered: 1,
        error: null,
        degraded: null,
        at: "2026-05-04T11:45:03.000Z",
      },
    ];

    const res = await req(`/admin/watch/watches/${id}/history`);
    expect(res.status).toBe(200);
    return { id, body: (await res.json()) as never };
  }

  test("orders events by when they happened, not by sequence number", async () => {
    // A deadline is journaled with a timer sequence counting down from -1. On a
    // numeric sort it lands before every arrival, however recently it elapsed.
    const { body } = await history();
    expect(body.paths.map((path) => path.seq)).toEqual([-1, 14, 13, 12, 3]);
    expect(body.paths[0]?.timer, "a timer sequence was not recognised").toBe(true);
    expect(body.paths[1]?.timer).toBe(false);
  });

  test("keeps one key's story apart from another's inside a single event", async () => {
    const { body } = await history();
    const event = body.paths.find((path) => path.seq === 12);

    expect(event?.keys).toEqual(["person=maya", "person=jamie"]);
    // The same node under two keys is two verdicts, not one. Folding them would
    // report that this tick armed a cell when for one of the keys it did not.
    const armed = event?.nodes.filter((node) => node.nodeId === "unanswered_2d");
    expect(armed?.map((node) => [node.key, node.verdict])).toEqual([
      ["person=maya", "armed"],
      ["person=jamie", "ignored"],
    ]);
    expect(event?.outcome).toBe("considered");
  });

  test("surfaces the judge's own sentence on a hold it decided", async () => {
    const { body } = await history();
    const event = body.paths.find((path) => path.seq === 13);
    const judge = event?.nodes.find((node) => node.nodeId === "judge");

    expect(event?.outcome, "a considered event was reported as a firing").toBe("considered");
    expect(judge?.verdict).toBe("held");
    expect(judge?.detail).toBe(
      "The thread already carries a reply from you, so nothing is outstanding.",
    );
    // Nothing failed: a hold the judge reasoned its way to is a decision, and a
    // class beside it would read as the judge never having run.
    expect(judge?.failure).toBe(null);
    // The verdict is the last transition, and the ones before it are kept.
    expect(judge?.steps.map((step) => step.transition)).toEqual(["armed", "held"]);
  });

  test("surfaces the class that parked a nomination", async () => {
    const { body } = await history();
    const judge = body.paths
      .find((path) => path.seq === 14)
      ?.nodes.find((node) => node.nodeId === "judge");

    expect(judge?.verdict).toBe("held");
    expect(judge?.failure, "a parked nomination read as a judgement").toBe("budget");
  });

  test("hands a firing its evidence and what delivering it did", async () => {
    const { body } = await history();
    const event = body.paths.find((path) => path.seq === -1);

    expect(event?.outcome).toBe("fired");
    expect(event?.forced).toBe(false);
    // Named, and one the corpus no longer holds is simply absent.
    expect(event?.firings[0]?.documents).toEqual([
      { id: "doc_quote", title: "Re: roof quote", sourceId: "gmail:jamie.lopez@example.com" },
    ]);
    // Normalised to the one name a reader sees everywhere else.
    expect(event?.firings[0]?.delivery).toMatchObject({
      kind: "omnesis-notify",
      delivered: 1,
    });
    // And the path it took is still there to light.
    expect(event?.nodes.map((node) => [node.nodeId, node.verdict])).toEqual([
      ["unanswered_2d", "fired"],
      ["notify", "fired"],
    ]);
  });

  test("says so when a firing's trace is no longer retained", async () => {
    const { body } = await history();
    const rolled = body.paths.find((path) => path.seq === 3);

    // The ledger keeps a firing for as long as the watch exists; the trace is
    // bounded. An empty path here would read as a firing that touched nothing.
    expect(rolled?.traceRetained).toBe(false);
    expect(rolled?.nodes).toEqual([]);
    expect(rolled?.keys).toEqual([]);
    // It still counts as a firing, and it still carries the ledger's own row.
    expect(rolled?.outcome).toBe("fired");
    expect(rolled?.firings).toHaveLength(1);
    // Every other event has its records, so this is a claim about one firing
    // rather than a trace that was never read.
    expect(body.paths.filter((path) => path.traceRetained)).toHaveLength(4);
    expect(body.trace.records).toBe(10);
  });

  test("bounds a page and clamps a limit SQLite could not bind", async () => {
    const { id } = await history();
    const res = await req(`/admin/watch/watches/${id}/history?limit=2`);
    const body = (await res.json()) as { paths: { seq: number }[] };
    expect(body.paths.map((path) => path.seq)).toEqual([-1, 14]);

    // A limit no reader would send by hand. None of these is a bound this
    // route can honour, so every one falls back to the default page — and the
    // page is what has to be asserted, because the status stays 200 through all
    // of it either way.
    //
    // Each means something different, and wrong, to a bare `slice`: `-1` drops
    // the newest event, `0` and `abc` empty the page, `1.5` truncates to one
    // and is a datatype mismatch the moment such a value reaches a bound query.
    for (const limit of ["1.5", "-1", "0", "abc", "1e9", "Infinity"]) {
      const clamped = await req(`/admin/watch/watches/${id}/history?limit=${limit}`);
      expect(clamped.status, `limit=${limit} was not clamped`).toBe(200);
      const page = (await clamped.json()) as { paths: { seq: number }[] };
      expect(
        page.paths.map((path) => path.seq),
        `limit=${limit} did not fall back to a whole page`,
      ).toEqual([-1, 14, 13, 12, 3]);
    }
  });

  test("404s an id that is not a watch", async () => {
    expect((await req("/admin/watch/watches/nope/history")).status).toBe(404);
  });

  test("needs the admin scope", async () => {
    const id = await addWatch("guarded-history");
    expect((await req(`/admin/watch/watches/${id}/history`, {}, READ_TOKEN)).status).toBe(403);
  });
});

/**
 * Retention is an operator tunable, and it can sit above this route's own
 * response ceiling.
 *
 * The read that decides whether a firing's trace has rolled off must therefore
 * be bounded by what the store *holds*, not by a constant in the route: bounded
 * by the constant, every event past it would be reported as pruned on an
 * install that had merely been asked to keep more.
 */
describe("a trace kept past the route's own ceiling", () => {
  test("does not report an event it simply did not fetch as one that rolled off", async () => {
    const id = await addWatch("long-memory");
    const roomy = new WatchTraceStore(adminDb, MAX_TRACE_LIMIT + 500);
    // More records than a read capped at the ceiling would return, spread over
    // few enough events that one page still holds them all — so the oldest
    // event is missing only if the read was capped rather than the page.
    const events = Math.floor(MAX_TRACE_LIMIT / 2) + 1;
    const records = Array.from({ length: events }, (_, index) => index + 1).flatMap((seq) => [
      { seq, nodeId: "mail", key: "person=maya", transition: "armed" },
      { seq, nodeId: "judge", key: "person=maya", transition: "held" },
    ]);
    expect(records.length, "the fixture must exceed the ceiling to be a test").toBeGreaterThan(
      MAX_TRACE_LIMIT,
    );
    roomy.record({ watch: id, records, firings: [] } as never, "2026-05-04T09:00:00.000Z");
    recordedFirings = [
      {
        seq: 1,
        nodeId: "mail",
        keyHash: "k1:0",
        firedAt: "2026-05-04T09:00:00.000Z",
        noticedAt: "2026-05-04T09:00:01.000Z",
        payload: {},
        documentIds: [],
        forced: false,
      },
    ];

    const res = await req(`/admin/watch/watches/${id}/history?limit=${MAX_TRACE_LIMIT}`);
    const body = (await res.json()) as {
      trace: { records: number };
      paths: { seq: number; traceRetained: boolean }[];
    };

    expect(body.trace.records).toBe(records.length);
    expect(body.paths.find((path) => path.seq === 1)?.traceRetained).toBe(true);
    expect(body.paths.every((path) => path.traceRetained)).toBe(true);
  });
});

/**
 * One trace per evaluation pass, which is how the host actually writes them.
 *
 * `WatchEngineHost` runs the engine over a *batch* of journal events and records
 * the whole run's trace under a single timestamp, taking any deadline that came
 * due inside that batch on a sequence counting down from -1. So every record of
 * a pass shares an `at`, and the only thing that says what happened in what
 * order is the order the rows were written.
 */
describe("ordering a pass the runtime recorded in one go", () => {
  test("keeps the runtime's own order, so a deadline does not sort behind every arrival", async () => {
    const id = await addWatch("one-pass");
    // Journal events 40 and 41, then a deadline that came due during the same
    // pass — all stamped with the one timestamp the host uses for the run.
    traces.record(
      {
        watch: id,
        records: [
          { seq: 40, nodeId: "mail", key: "person=maya", transition: "armed" },
          { seq: 41, nodeId: "mail", key: "person=jamie", transition: "armed" },
          { seq: -7, nodeId: "unanswered_2d", key: "person=maya", transition: "fired" },
        ],
        firings: [],
      } as never,
      "2026-05-04T09:15:30.000Z",
    );

    const res = await req(`/admin/watch/watches/${id}/history`);
    const body = (await res.json()) as { paths: { seq: number; timer: boolean }[] };

    // Newest first is the reverse of the order they were worked in. Sorted on
    // the sequence number instead, the deadline would come last of the three.
    expect(body.paths.map((path) => path.seq)).toEqual([-7, 41, 40]);
    expect(body.paths[0]?.timer).toBe(true);
  });

  test("holds back the events no node took up, and counts them", async () => {
    // A document that fails a source's filter never reaches a node and leaves
    // no record. A document that reaches one and no arm nominates it leaves an
    // `ignored` record saying so — and on a watch with a narrow recall arm that
    // is most of what it sees. Observed on a real install: 100 of 100 retained
    // events, every record `ignored`, burying the one event that armed a cell.
    const id = await addWatch("narrow-arm");
    traces.record(
      {
        watch: id,
        records: [
          { seq: 70, nodeId: "mail", key: "singleton", transition: "ignored" },
          { seq: 71, nodeId: "mail", key: "singleton", transition: "ignored" },
          { seq: 72, nodeId: "mail", key: "person=maya", transition: "armed" },
        ],
        firings: [],
      } as never,
      "2026-05-04T09:15:30.000Z",
    );

    const res = await req(`/admin/watch/watches/${id}/history`);
    const body = (await res.json()) as {
      events: { total: number; untouched: number; showing: string };
      paths: { seq: number }[];
    };

    expect(body.paths.map((path) => path.seq)).toEqual([72]);
    expect(body.events).toEqual({ total: 3, untouched: 2, showing: "engaged" });

    // Held back, never dropped: on a watch declining everything they are the
    // whole story, and a page that could not show them would be hiding the
    // evidence for its own summary.
    const all = await req(`/admin/watch/watches/${id}/history?untouched=include`);
    const shown = (await all.json()) as {
      events: { showing: string };
      paths: { seq: number }[];
    };
    expect(shown.paths.map((path) => path.seq)).toEqual([72, 71, 70]);
    expect(shown.events.showing).toBe("all");
  });

  test("an arm a live cell collided with is a decision, not noise", async () => {
    // `ignored` also covers a colliding arm dropped while a cell was live, and
    // that is a real answer to "why did nothing spawn". It is told apart with
    // no detail-string reading: for an arm to collide the source feeding it
    // fired on the same event, so the path is not ignored throughout.
    const id = await addWatch("collided");
    traces.record(
      {
        watch: id,
        records: [
          { seq: 80, nodeId: "mail", key: "singleton", transition: "fired" },
          { seq: 80, nodeId: "hold", key: "person=maya", transition: "ignored" },
        ],
        firings: [],
      } as never,
      "2026-05-04T09:15:30.000Z",
    );

    const res = await req(`/admin/watch/watches/${id}/history`);
    const body = (await res.json()) as {
      events: { untouched: number };
      paths: { seq: number }[];
    };

    expect(body.paths.map((path) => path.seq)).toEqual([80]);
    expect(body.events.untouched).toBe(0);
  });

  test("an event worked on twice sorts where it was last worked on", async () => {
    // A nomination the judge's budget parked is re-judged on a later pass, and
    // it settles — and fires — under its *original* sequence. So its earliest
    // records sit far back in the stream while the firing is the newest thing
    // the watch has done.
    //
    // Ordering on where an event *first* appears files that firing last, and on
    // a watch with a full page it slices it off entirely — so the ledger's link
    // to it lands on "this event is not on this page", about a firing from a
    // moment ago.
    const id = await addWatch("re-judged");
    traces.record(
      {
        watch: id,
        records: [{ seq: 30, nodeId: "judge", key: "person=maya", transition: "held" }],
        firings: [],
      } as never,
      "2026-05-04T09:00:00.000Z",
    );
    traces.record(
      {
        watch: id,
        records: [
          { seq: 31, nodeId: "mail", key: "person=jamie", transition: "armed" },
          { seq: 32, nodeId: "mail", key: "person=david", transition: "armed" },
        ],
        firings: [],
      } as never,
      "2026-05-04T10:00:00.000Z",
    );
    traces.record(
      {
        watch: id,
        records: [{ seq: 30, nodeId: "judge", key: "person=maya", transition: "fired" }],
        firings: [],
      } as never,
      "2026-05-04T11:00:00.000Z",
    );

    const res = await req(`/admin/watch/watches/${id}/history`);
    const body = (await res.json()) as { paths: { seq: number }[] };

    expect(body.paths.map((path) => path.seq)).toEqual([30, 32, 31]);
  });

  // `fireByHand` takes its sequence from the same counter deadlines use, so a
  // forced firing is negative too — and a page that read the sign alone would
  // tell an operator their own firing was a deadline elapsing.
  //
  // Two independent witnesses say it was forced, and each is the only one in
  // some real install: the ledger's `forced` column is nullable, so a firing
  // recorded before it existed cannot answer, and the trace is bounded, so an
  // older firing's `forced` transition is gone while its ledger row remains.
  // One test setting both would pass with either reading deleted.
  async function forcedBy(
    witness: "ledger" | "trace",
  ): Promise<{ seq: number; timer: boolean; forced: boolean; outcome: string }> {
    const id = await addWatch(`by-hand-${witness}`);
    traces.record(
      {
        watch: id,
        records: [
          {
            seq: -3,
            nodeId: "mail",
            key: "singleton",
            transition: witness === "trace" ? "forced" : "fired",
          },
        ],
        firings: [],
      } as never,
      "2026-05-04T09:15:30.000Z",
    );
    recordedFirings = [
      {
        seq: -3,
        nodeId: "mail",
        keyHash: "singleton",
        firedAt: "2026-05-04T09:15:30.000Z",
        noticedAt: "2026-05-04T09:15:30.000Z",
        payload: {},
        documentIds: [],
        forced: witness === "ledger",
      },
    ];
    const res = await req(`/admin/watch/watches/${id}/history`);
    return (
      (await res.json()) as {
        paths: { seq: number; timer: boolean; forced: boolean; outcome: string }[];
      }
    ).paths[0]!;
  }

  test("does not call a firing an operator forced a deadline — the ledger saying so", async () => {
    expect(await forcedBy("ledger")).toMatchObject({
      seq: -3,
      forced: true,
      timer: false,
      outcome: "fired",
    });
  });

  test("does not call a firing an operator forced a deadline — the trace saying so", async () => {
    expect(await forcedBy("trace")).toMatchObject({
      seq: -3,
      forced: true,
      timer: false,
      outcome: "fired",
    });
  });

  test("a node firing mid-graph is not the watch firing", async () => {
    // A source that fired into a cooldown which swallowed it is a node that
    // fired and a watch that said nothing. Only the ledger says otherwise.
    const id = await addWatch("mid-graph");
    traces.record(
      {
        watch: id,
        records: [
          { seq: 50, nodeId: "mail", key: "person=maya", transition: "fired" },
          {
            seq: 50,
            nodeId: "quiet_period",
            key: "person=maya",
            transition: "held",
            detail: "it said something about this 20 minutes ago",
          },
        ],
        firings: [],
      } as never,
      "2026-05-04T09:15:30.000Z",
    );

    const res = await req(`/admin/watch/watches/${id}/history`);
    const body = (await res.json()) as { paths: { outcome: string }[] };
    expect(body.paths[0]?.outcome).toBe("considered");
  });
});

describe("asking a gateway that is stopping to compile", () => {
  const ask = { request: "tell me when a parcel ships" };

  test("is refused in words rather than by a dropped connection", async () => {
    // A compile runs for minutes and a deploy takes seconds, so a restart
    // landing mid-compile is ordinary. Accepted anyway it reaches the caller as
    // a dropped connection, which an agent reads as a broken feature and
    // answers by asking again in different words — a different idempotency key
    // by design, so the duplicate guard never fires and one intent becomes
    // several watches.
    watchV2Routes.compiles = { open: false, size: 0 };
    try {
      const res = await app.request("/admin/watch/compile", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...ask, compileOnly: true }),
      });
      expect(res.status).toBe(503);
      expect(await res.text()).toMatch(/restarting/i);
    } finally {
      watchV2Routes.compiles = { open: true, size: 0 };
    }
  });

  test("does not start the compile it would not finish", async () => {
    // The discriminating half: refusing after paying for the compile would
    // spend the minutes anyway and still tell the caller nothing happened.
    const before = previewRequests.length;
    watchV2Routes.compiles = { open: false, size: 0 };
    try {
      await app.request("/admin/watch/compile", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...ask, compileOnly: true }),
      });
      expect(previewRequests).toHaveLength(before);
    } finally {
      watchV2Routes.compiles = { open: true, size: 0 };
    }
  });
});

describe("compiling with the replay withheld, to measure what it costs", () => {
  test("refuses the switch on a request that would install", async () => {
    // The one case where the replay is worth its minutes whatever the caller
    // thinks. A switch reachable from the install path would end up being used
    // to install something faster.
    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ request: "tell me when a parcel ships", withoutBacktest: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/compileOnly/);
  });

  test("passes it through on a compile-only request", async () => {
    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        request: "tell me when a parcel ships",
        compileOnly: true,
        withoutBacktest: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(previewRequests.at(-1)).toMatchObject({ withoutBacktest: true });
  });

  test("says nothing about it when the caller did not ask", async () => {
    // Hygiene rather than behaviour: `previewWatch` re-checks for `true`, so a
    // key present with `undefined` changes no outcome. It is here so the route
    // hands on what it was given rather than a shape of its own.
    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ request: "tell me when a parcel ships", compileOnly: true }),
    });
    expect(res.status).toBe(200);
    expect(previewRequests.at(-1)).not.toHaveProperty("withoutBacktest");
  });
});

describe("what a preview says about how the watch would have behaved", () => {
  test("hands back the replay's counts, so the asker can decide", async () => {
    // The whole point of replaying before installing: "this would have fired 0
    // times in 12 days" is the sentence that stops a watch being installed and
    // then quietly never firing, and nothing else in this answer can say it.
    previewResult = {
      ...previewResult,
      status: "compiled",
      backtest: {
        watch: "a-parcel-shipped",
        events: 4_200,
        days: 12,
        firings: 0,
        reachByNode: { mail: 31 },
        totalReaches: 31,
      },
    } as typeof previewResult;
    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ request: "tell me when a parcel ships", compileOnly: true }),
    });
    const body = (await res.json()) as { backtest?: Record<string, unknown> };
    expect(body.backtest).toMatchObject({ days: 12, firings: 0, totalReaches: 31 });
  });

  test("says null rather than zero when nothing replayed it", async () => {
    // The discriminating case. A watch that reached nothing and a watch nobody
    // replayed are opposite facts, and a zero here would be read as the first.
    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ request: "tell me when a parcel ships", compileOnly: true }),
    });
    const body = (await res.json()) as { backtest?: unknown };
    expect(body.backtest).toBeNull();
  });
});

describe("compiling without installing", () => {
  const ask = { request: "tell me when a parcel ships" };

  test("hands back the document and installs nothing", async () => {
    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...ask, compileOnly: true }),
    });

    // 200 rather than 201: nothing was created, and a caller reading only
    // `compiled: true` would otherwise have no way to tell this from an install.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["installed"]).toBe(false);
    expect(body["dsl"]).toEqual({ watch: { name: "a-parcel-shipped" } });
    expect(body["interpretation"]).toBe("tell me when a parcel ships");
    expect(body["compileRunId"]).toBe("run_the_compile");
    expect(definitions.list(), "a preview installed a watch").toHaveLength(0);
  });

  test("goes to the preview rather than the install, which throws if reached", async () => {
    // `author` in this suite's deps throws by name. A route that ignored the
    // flag would 500 here instead of quietly installing, which is the failure
    // worth having.
    await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...ask, compileOnly: true }),
    });

    expect(previewRequests).toHaveLength(1);
    expect(previewRequests[0]?.request).toBe("tell me when a parcel ships");
  });

  test("answers a refusal the same way the installing path does", async () => {
    // One shape per outcome, whichever flag was set: otherwise a measurement of
    // how often the compiler refuses becomes a measurement of which route ran.
    previewResult = {
      status: "refused",
      reasons: ["nothing on this install publishes what that asks about"],
      codes: ["unsupported_condition"],
      compileRunId: "run_the_refusal",
    };

    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...ask, compileOnly: true }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["compiled"]).toBe(false);
    expect(body["codes"]).toEqual(["unsupported_condition"]);
  });

  test("refuses a body that spells the default out", async () => {
    // `compileOnly: false` says exactly what leaving it out says, and two
    // spellings of one default is how a caller comes to believe it set
    // something.
    const res = await app.request("/admin/watch/compile", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...ask, compileOnly: false }),
    });

    expect(res.status).toBe(400);
  });
});

describe("trying a candidate over a span", () => {
  // A DSL the route will actually parse — it validates the candidate before it
  // reaches the probe, so a stub shape never gets far enough to prove anything.
  const dsl = { watch: { name: "a-candidate" } };

  test("passes the span through to the probe", async () => {
    const res = await req("/admin/watch/preflight", {
      method: "POST",
      body: JSON.stringify({ dsl: emailWatch(await fingerprint()), days: 30 }),
    });

    expect(res.status).toBe(200);
    expect(preflightRequests.at(-1)).toMatchObject({ opts: { days: 30 } });
  });

  test("refuses to be asked both questions at once", async () => {
    // They answer different things — what a candidate does with recent traffic,
    // and what it would have done over a span — and a caller that sent both has
    // not decided which it wants.
    const res = await req("/admin/watch/preflight", {
      method: "POST",
      body: JSON.stringify({ dsl, events: 100, days: 30 }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not both");
  });

  test("names the field a caller got wrong", async () => {
    // Round 13's lesson: a 400 whose message names fields the caller supplied
    // correctly sends them to look at the wrong thing.
    const res = await req("/admin/watch/preflight", {
      method: "POST",
      body: JSON.stringify({ dsl, days: 4000 }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("`days`");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import { SyncEngine } from "./sync-engine.js";
import type { RegisteredSource, RegisteredProvider } from "./sync-engine.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";
import type {
  GatewayClient,
  SyncCursor,
  SyncState,
  SyncResult,
  AnalyticsTableSchema,
  SnapshotAbsenceOutcome,
  SourceSyncMeta,
} from "@omnesis/source-sdk";
import type { DocumentInput, SourceId, ProviderId } from "@omnesis/types";

/** In-memory mock gateway for testing */
class MockGateway implements GatewayClient {
  documents: DocumentInput[] = [];
  deletedIds: { providerId: string; sourceId: string; ids: string[] }[] = [];
  reconcileCalls: { providerId: string; sourceId: string; present: string[] }[] = [];
  syncStates = new Map<string, SyncState>();
  metaUpdates: Array<{ sourceId: string; meta: SourceSyncMeta }> = [];
  linkDeclarations: Array<Parameters<GatewayClient["setLinkDeclarations"]>[0]> = [];

  async upsertDocuments(documents: DocumentInput[]) {
    this.documents.push(...documents);
  }

  async transcribe() {
    return null;
  }

  async setWidgetRenderers() {}

  async setLinkDeclarations(input: Parameters<GatewayClient["setLinkDeclarations"]>[0]) {
    this.linkDeclarations.push(input);
  }

  async recomputeSourceUrls() {
    return { scanned: 0, touched: 0 };
  }

  async deleteDocuments(providerId: string, sourceId: string, externalIds: string[]) {
    this.deletedIds.push({
      providerId,
      sourceId: sourceId,
      ids: externalIds,
    });
  }

  async reconcileSnapshot(
    providerId: string,
    sourceId: string,
    presentExternalIds: string[],
  ): Promise<number> {
    this.reconcileCalls.push({
      providerId,
      sourceId,
      present: presentExternalIds,
    });
    // Model the gateway's answer, not its storage: a snapshot records what it
    // omits and deletes nothing, so `documents` is deliberately untouched here
    // (the diff's own unit tests live gateway-side).
    return 0;
  }

  /** The shape the gateway reports back for a snapshot, without applying it. */
  private absenceFor(sourceId: string, presentExternalIds: string[]): SnapshotAbsenceOutcome {
    const present = new Set(presentExternalIds);
    const stored = this.documents.filter((d) => d.sourceId === sourceId);
    const absent = stored.filter((d) => !present.has(d.externalId)).length;
    const held = new Set(stored.map((d) => d.externalId));
    let missing = 0;
    for (const id of present) if (!held.has(id)) missing += 1;
    return {
      marked: absent,
      cleared: 0,
      absent,
      deferred: 0,
      missing,
      stored: stored.length,
      snapshot: present.size,
    };
  }

  async getDocumentCount(): Promise<number> {
    return this.documents.length;
  }

  async getSyncState(sourceId: string): Promise<SyncState | null> {
    return this.syncStates.get(sourceId) ?? null;
  }

  async getWipeEpoch(sourceId: string): Promise<number | undefined> {
    return this.syncStates.get(sourceId)?.wipeEpoch;
  }

  async setSyncState(sourceId: string, cursor: SyncCursor) {
    this.syncStates.set(sourceId, {
      sourceId: sourceId,
      cursor,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  async setSourceMeta(sourceId: SourceId, meta: SourceSyncMeta): Promise<void> {
    this.metaUpdates.push({ sourceId, meta });
  }

  /**
   * Mock implementation of the atomic per-page write (issue #322).
   * Mirrors the production path: documents/tombstones → snapshot
   * reconcile → cursor advance, with the snapshot-on-final-page
   * defence-in-depth check the gateway enforces.
   */
  async upsertWithCursor(args: {
    providerId: string;
    sourceId: string;
    documents?: DocumentInput[];
    deletedExternalIds?: string[];
    presentExternalIds?: string[];
    hasMore: boolean;
    cursor: SyncCursor;
  }) {
    if (args.documents?.length) {
      this.documents.push(...args.documents);
    }
    if (args.deletedExternalIds?.length) {
      this.deletedIds.push({
        providerId: args.providerId,
        sourceId: args.sourceId,
        ids: args.deletedExternalIds,
      });
    }
    let absence: SnapshotAbsenceOutcome | undefined;
    if (args.presentExternalIds !== undefined && !args.hasMore) {
      this.reconcileCalls.push({
        providerId: args.providerId,
        sourceId: args.sourceId,
        present: args.presentExternalIds,
      });
      absence = this.absenceFor(args.sourceId, args.presentExternalIds);
    }
    this.syncStates.set(args.sourceId, {
      sourceId: args.sourceId,
      cursor: args.cursor,
      lastSyncedAt: new Date().toISOString(),
    });
    return { ingested: args.documents?.length ?? 0, absence, indexCleanedRows: 0 };
  }

  analyticsPushes: {
    tableName: string;
    records: Record<string, unknown>[];
    schema?: AnalyticsTableSchema;
    sourceId?: string;
  }[] = [];

  async ingestAnalyticsPage(page: {
    tableName: string;
    records: Record<string, unknown>[];
    schema?: AnalyticsTableSchema;
    sourceId?: string;
  }): Promise<{ ingested: number }> {
    this.analyticsPushes.push({
      tableName: page.tableName,
      records: page.records,
      schema: page.schema,
      sourceId: page.sourceId,
    });
    return { ingested: 0 };
  }

  async ping() {
    return true;
  }

  async getConfig() {
    return {};
  }
}

function makeProvider(
  id: string,
  authenticated = true,
  sources: RegisteredSource[] = [],
): RegisteredProvider {
  return {
    id: id as ProviderId,
    name: id,
    credentialState: async () => ({ status: authenticated ? "connected" : "revoked" }) as const,
    renewableCredential: true,
    sources,
  };
}

function makeSource(
  id: string,
  providerId: string,
  syncFn: (cursor: SyncCursor | null) => Promise<SyncResult>,
  opts?: {
    watchPaths?: string[];
    urlCanonicalizer?: UrlCanonicalizerSpec;
    analyticsSchemas?: AnalyticsTableSchema[];
  },
): RegisteredSource {
  return {
    id: id as SourceId,
    name: id,
    providerId: providerId as ProviderId,
    family: { name: id },
    instance: {
      sync: syncFn,
      ...(opts?.watchPaths ? { watchPaths: opts.watchPaths } : {}),
      ...(opts?.analyticsSchemas ? { analyticsSchemas: opts.analyticsSchemas } : {}),
    },
    ...(opts?.urlCanonicalizer ? { urlCanonicalizer: opts.urlCanonicalizer } : {}),
  };
}

function makeAnalyticsSchema(tableName: string): AnalyticsTableSchema {
  return {
    tableName,
    displayName: tableName,
    description: `${tableName} test table`,
    columns: [
      { name: "id", type: "VARCHAR", description: "id" },
      { name: "occurred_at", type: "TIMESTAMPTZ", description: "event time" },
    ],
    primaryKey: ["id"],
    semanticTimeColumn: "occurred_at",
    record: { titleColumns: ["id"], keyColumns: ["occurred_at", "id"] },
  };
}

function makeDoc(externalId: string): DocumentInput {
  return {
    providerId: "test",
    sourceId: "test-source",
    externalId,
    title: `Doc ${externalId}`,
    content: `Content of ${externalId}`,
    contentHash: `hash-${externalId}`,
    metadata: {},
    sourceCreatedAt: "2024-01-01T00:00:00Z",
    sourceUpdatedAt: "2024-01-01T00:00:00Z",
  };
}

describe("SyncEngine status tracking", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  test("returns idle status for registered sources", () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    const statuses = engine.getStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].sourceId).toBe("test-source");
    expect(statuses[0].state).toBe("idle");
  });

  // Pre-fix, `triggerSync` checked `status.state` then
  // fired `provider.credentialState().then(syncSource)` — a second
  // synchronous call landing before the auth-check resolved would
  // see `state !== "syncing"` and fire a duplicate sync. The fix
  // flips `state = "syncing"` synchronously inside `triggerSync`,
  // so back-to-back calls in the same tick collapse to one
  // dispatched sync; the second goes to `skipped`.
  test("triggerSync claims source synchronously, collapsing back-to-back calls", async () => {
    let syncCallCount = 0;
    let releaseSync: () => void = () => {};
    const releasePromise = new Promise<void>((r) => (releaseSync = r));

    const source = makeSource("test-source", "test", async () => {
      syncCallCount += 1;
      // Hold the in-flight sync open so the second triggerSync call
      // observes the source still mid-flight; without this hold, a
      // sufficiently fast first sync could complete + flip back to
      // idle before the second call lands and the test would race.
      await releasePromise;
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });
    engine.registerProvider(makeProvider("test", true, [source]));

    // Two synchronous calls in the same tick.
    const first = engine.triggerSync("test-source");
    const second = engine.triggerSync("test-source");

    expect(first.triggered).toEqual(["test-source"]);
    expect(first.skipped).toEqual([]);
    // Second call sees `state === "syncing"` from the synchronous
    // claim and returns it under `skipped`, NOT `triggered`.
    expect(second.triggered).toEqual([]);
    expect(second.skipped).toEqual(["test-source"]);

    // Drain the microtask queue so the auth-check's `.then()` runs
    // and `syncSource` (if it's going to fire) gets a chance.
    await new Promise((r) => setImmediate(r));
    expect(syncCallCount).toBe(1);

    // Release the held sync so afterEach cleanup completes.
    releaseSync();
    await new Promise((r) => setTimeout(r, 20));
  });

  // Rollback path — when the optimistic synchronous
  // claim flipped state to "syncing" but the auth-check then
  // resolved to `false` (provider not authenticated), the source
  // must roll back to "idle" so the next tick can retry. Without
  // the rollback the source would stay stuck in "syncing" forever.
  test("triggerSync rolls back to idle when provider.credentialState() resolves false", async () => {
    let syncCallCount = 0;
    const source = makeSource("test-source", "google:a@b.com", async () => {
      syncCallCount += 1;
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });
    // Provider reports unauthenticated — the auth-check arm should
    // see the rejection and roll the optimistic claim back.
    engine.registerProvider(makeProvider("google:a@b.com", false, [source]));

    const result = engine.triggerSync("test-source");
    expect(result.triggered).toEqual(["test-source"]);

    // Drain the microtask queue so `provider.credentialState()`
    // resolves and the rollback arm runs.
    await new Promise((r) => setImmediate(r));

    expect(syncCallCount).toBe(0);
    const status = engine.getStatuses().find((s) => s.sourceId === "test-source");
    expect(status?.state).toBe("idle");
  });

  // Rollback path — when `isAuthenticated()` rejects
  // (provider's auth check threw mid-flight), the optimistic claim
  // must roll back to "error" with the thrown error message, so
  // operators see *why* the source stopped instead of a phantom
  // "syncing" status that never advances.
  test("triggerSync rolls back to error when provider.credentialState() throws", async () => {
    let syncCallCount = 0;
    const source = makeSource("test-source", "google:a@b.com", async () => {
      syncCallCount += 1;
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });
    const throwingProvider: RegisteredProvider = {
      id: "google:a@b.com" as ProviderId,
      name: "google:a@b.com",
      credentialState: async (): Promise<never> => {
        throw new Error("auth-check exploded");
      },
      sources: [source],
    };
    engine.registerProvider(throwingProvider);

    const result = engine.triggerSync("test-source");
    expect(result.triggered).toEqual(["test-source"]);

    // Drain the microtask queue so the rejection lands in the
    // `.catch()` arm and the rollback runs.
    await new Promise((r) => setImmediate(r));

    expect(syncCallCount).toBe(0);
    const status = engine.getStatuses().find((s) => s.sourceId === "test-source");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain("auth-check exploded");
  });

  test("tracks sync state and stats after completion", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [makeDoc("d1"), makeDoc("d2")],
      deletedExternalIds: ["old-1"],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    const statuses = engine.getStatuses();
    expect(statuses[0].state).toBe("idle");
    expect(statuses[0].lastSyncAt).toBeDefined();
    expect(statuses[0].lastSyncStats?.documents).toBe(2);
    expect(statuses[0].lastSyncStats?.deleted).toBe(1);
  });

  test("unregisterSource awaits source.dispose() before removing the instance", async () => {
    const events: string[] = [];
    let resolveDispose: () => void = () => {};
    const disposePromise = new Promise<void>((r) => (resolveDispose = r));

    const source: RegisteredSource = {
      id: "test-source" as SourceId,
      name: "test-source",
      providerId: "test" as ProviderId,
      family: { name: "test-source" },
      instance: {
        sync: async () => ({
          documents: [],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        }),
        dispose: async () => {
          events.push("dispose:start");
          await disposePromise;
          events.push("dispose:end");
        },
      },
    };

    engine.registerProvider(makeProvider("test", true, [source]));

    const unregisterPromise = engine.unregisterSource("test-source");
    // dispose started but hasn't finished — instance must still be in the
    // registry so dispose runs against live resources.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["dispose:start"]);
    expect(engine.getSourcesById("test-source")).toHaveLength(1);

    resolveDispose();
    await unregisterPromise;

    expect(events).toEqual(["dispose:start", "dispose:end"]);
    expect(engine.getSourcesById("test-source")).toHaveLength(0);
    expect(engine.getStatuses()).toHaveLength(0);
  });

  test("an old unregister cannot remove a replacement registered during dispose", async () => {
    let releaseDispose: () => void = () => {};
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const oldSource = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    oldSource.instance.dispose = () => disposeGate;
    const replacement = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    engine.registerProvider(makeProvider("test", true, [oldSource]));

    const unregister = engine.unregisterSource("test-source");
    await new Promise((resolve) => setTimeout(resolve, 10));
    engine.registerProvider(makeProvider("test", true, [replacement]));
    releaseDispose();
    await unregister;

    expect(engine.getSourcesById("test-source")).toEqual([replacement]);
    expect(engine.getStatuses().map((status) => status.sourceId)).toContain("test-source");
  });

  test("unregisterSource catches dispose() errors so a buggy source cannot block removal", async () => {
    const source: RegisteredSource = {
      id: "test-source" as SourceId,
      name: "test-source",
      providerId: "test" as ProviderId,
      family: { name: "test-source" },
      instance: {
        sync: async () => ({
          documents: [],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        }),
        dispose: async () => {
          throw new Error("boom — source's dispose explodes");
        },
      },
    };

    engine.registerProvider(makeProvider("test", true, [source]));
    // Must NOT throw — the engine swallows dispose errors and proceeds.
    await engine.unregisterSource("test-source");
    expect(engine.getSourcesById("test-source")).toHaveLength(0);
  });

  test("unregisterSource still works for sources that don't implement dispose()", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.unregisterSource("test-source");
    expect(engine.getSourcesById("test-source")).toHaveLength(0);
  });

  test("provider.credentialState() === false transitions every source to needs-auth with hint", async () => {
    const source = makeSource("gmail:a@b.com", "google:a@b.com", async () => ({
      documents: [makeDoc("d1")],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    // Provider says NOT authenticated — sync should be skipped AND every
    // source on this provider should be marked needs-auth so the UI
    // surfaces a remediation hint instead of staying idle.
    engine.registerProvider(makeProvider("google:a@b.com", false, [source]));
    await engine.syncAll();

    const status = engine.getStatuses().find((s) => s.sourceId === "gmail:a@b.com");
    expect(status?.state).toBe("needs-auth");
    expect(status?.lastError).toContain("needs reauth: ");
    // Hint references the provider+account so one re-auth heals every
    // sibling source under the same provider — not the source-type alone.
    expect(status?.lastError).toContain("cli -- sources reauth google:a@b.com");

    // The source's sync function must NOT have run.
    // (No documents reached the gateway.)
    expect(gateway.documents).toHaveLength(0);
  });

  test("auth-failure thrown from sync() (e.g. invalid_grant) flips state to needs-auth", async () => {
    const source = makeSource("gmail:a@b.com", "google:a@b.com", async () => {
      // Mimic googleapis throwing invalid_grant after a refresh-token revoke.
      throw new Error("invalid_grant: Token has been expired or revoked.");
    });

    engine.registerProvider(makeProvider("google:a@b.com", true, [source]));
    await engine.syncAll();

    const status = engine.getStatuses().find((s) => s.sourceId === "gmail:a@b.com");
    expect(status?.state).toBe("needs-auth");
    expect(status?.lastError).toContain("needs reauth: ");
  });

  test("auth-failure shaped as Google's bare 'Invalid Credentials' string flips to needs-auth", async () => {
    // Caught live during Tier 5 of sources-qa Phase 4 validation: the
    // `googleapis` SDK throws bare `Invalid Credentials` on every call
    // (Calendar / Contacts / Drive / Gmail) when the user revokes
    // access at myaccount.google.com/permissions. The previous
    // `looksLikeAuthFailure` patterns (invalid_grant, 401, etc.) didn't
    // match this string, so the source landed in generic `error` state
    // instead of `needs-auth`.
    const source = makeSource("google-calendar:a@b.com", "google:a@b.com", async () => {
      throw new Error("Invalid Credentials");
    });

    engine.registerProvider(makeProvider("google:a@b.com", true, [source]));
    await engine.syncAll();

    const status = engine.getStatuses().find((s) => s.sourceId === "google-calendar:a@b.com");
    expect(status?.state).toBe("needs-auth");
    expect(status?.lastError).toContain("needs reauth: ");
  });

  test("non-auth errors stay as generic 'error', not needs-auth", async () => {
    const source = makeSource("gmail:a@b.com", "google:a@b.com", async () => {
      throw new Error("rate limited (429)");
    });

    engine.registerProvider(makeProvider("google:a@b.com", true, [source]));
    await engine.syncAll();

    const status = engine.getStatuses().find((s) => s.sourceId === "gmail:a@b.com");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toBe("rate limited (429)");
  });

  test("registerProvider for an existing provider replaces source instances (covers reauth-without-restart)", async () => {
    let oldSyncCalled = 0;
    let newSyncCalled = 0;
    const oldSource = makeSource("gmail:a@b.com", "google:a@b.com", async () => {
      oldSyncCalled++;
      throw new Error("invalid_grant");
    });
    const newSource = makeSource("gmail:a@b.com", "google:a@b.com", async () => {
      newSyncCalled++;
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });

    engine.registerProvider(makeProvider("google:a@b.com", true, [oldSource]));
    await engine.syncAll();
    expect(oldSyncCalled).toBe(1);

    // Re-register with the same provider id but a fresh source instance —
    // simulates `cli add gmail` writing new tokens and re-registering.
    engine.registerProvider(makeProvider("google:a@b.com", true, [newSource]));
    await engine.syncAll();

    // The OLD instance must NOT have been called again (it was replaced).
    expect(oldSyncCalled).toBe(1);
    expect(newSyncCalled).toBe(1);
    const status = engine.getStatuses().find((s) => s.sourceId === "gmail:a@b.com");
    expect(status?.state).toBe("idle");
    expect(status?.lastError).toBeUndefined();
  });

  test("re-register flips needs-auth → idle so the next sync gets a fresh attempt", async () => {
    const source = makeSource("gmail:a@b.com", "google:a@b.com", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("google:a@b.com", false, [source]));
    await engine.syncAll();
    expect(engine.getStatuses()[0].state).toBe("needs-auth");

    // Re-register with a connected credential (simulating re-auth).
    const newSource = makeSource("gmail:a@b.com", "google:a@b.com", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    engine.registerProvider(makeProvider("google:a@b.com", true, [newSource]));

    const status = engine.getStatuses()[0];
    expect(status.state).toBe("idle");
    expect(status.lastError).toBeUndefined();
  });

  test("re-register broadcasts sync.completed for EVERY reactivated sibling so the gateway clears needs-auth at once", async () => {
    // A single OAuth credential backs all of a provider's sources (Gmail +
    // Calendar + Contacts + Drive share one Google token). When the token
    // expires every sibling lands in needs-auth. The re-auth re-registers
    // the provider with fresh credentials, which must ANNOUNCE the
    // reactivation for all siblings — otherwise the gateway (a pure
    // event-follower) only clears each source's needs-auth pill as that
    // source's own staggered sync happens to run, and the operator watches
    // them recover one by one with the re-auth banner lingering.
    const syncFn = async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    });
    const siblingIds = [
      "gmail:a@b.com",
      "google-calendar:a@b.com",
      "google-contacts:a@b.com",
      "google-drive:a@b.com",
    ];

    // Unauthenticated provider → syncAll marks every sibling needs-auth.
    engine.registerProvider(
      makeProvider(
        "google:a@b.com",
        false,
        siblingIds.map((id) => makeSource(id, "google:a@b.com", syncFn)),
      ),
    );
    await engine.syncAll();
    for (const id of siblingIds) {
      expect(engine.getStatuses().find((s) => s.sourceId === id)?.state).toBe("needs-auth");
    }

    // Start capturing only now, so we observe the re-register's emits and
    // not the needs-auth events from the first (unauthenticated) syncAll.
    const events: {
      event: string;
      sourceId: string;
      status: { state: string; lastError?: string };
    }[] = [];
    engine.onStatusChange((change) => events.push(change));

    // Re-register with a connected credential and fresh instances — the reauth.
    engine.registerProvider(
      makeProvider(
        "google:a@b.com",
        true,
        siblingIds.map((id) => makeSource(id, "google:a@b.com", syncFn)),
      ),
    );

    // Every sibling must have been announced cleared, synchronously, with no
    // sync having run — and the in-memory status must be idle with no error.
    for (const id of siblingIds) {
      const cleared = events.filter((e) => e.event === "sync.completed" && e.sourceId === id);
      expect(cleared).toHaveLength(1);
      expect(cleared[0].status.state).toBe("idle");
      expect(cleared[0].status.lastError).toBeUndefined();
      expect(engine.getStatuses().find((s) => s.sourceId === id)?.state).toBe("idle");
    }
    // Nothing synced as part of the broadcast — the docs are untouched.
    expect(gateway.documents).toHaveLength(0);
  });

  test("calls gateway.reconcileSnapshot when source emits presentExternalIds", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [makeDoc("d1"), makeDoc("d2")],
      deletedExternalIds: [],
      presentExternalIds: ["d1", "d2"],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    expect(gateway.reconcileCalls).toHaveLength(1);
    expect(gateway.reconcileCalls[0].providerId).toBe("test");
    expect(gateway.reconcileCalls[0].sourceId).toBe("test-source");
    expect(gateway.reconcileCalls[0].present.sort()).toEqual(["d1", "d2"]);
  });

  test("does NOT call reconcileSnapshot when presentExternalIds is undefined (incremental sync)", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [makeDoc("d1")],
      deletedExternalIds: [],
      // presentExternalIds intentionally omitted
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    expect(gateway.reconcileCalls).toHaveLength(0);
  });

  test("empty presentExternalIds is meaningful — still reconciles (the source reports nothing left)", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      presentExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    expect(gateway.reconcileCalls).toHaveLength(1);
    expect(gateway.reconcileCalls[0].present).toEqual([]);
  });

  test("tracks error state after failure", async () => {
    const source = makeSource("test-source", "test", async () => {
      throw new Error("boom");
    });

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    const statuses = engine.getStatuses();
    expect(statuses[0].state).toBe("error");
    expect(statuses[0].lastError).toBe("boom");
  });

  test("tracks progress from SyncResult", async () => {
    let resolveSync: () => void;
    const syncPromise = new Promise<void>((r) => (resolveSync = r));
    let capturedProgress: any;

    const source = makeSource("test-source", "test", async () => {
      // Return result with progress
      return {
        documents: [makeDoc("d1")],
        deletedExternalIds: [],
        cursor: {},
        hasMore: false,
        progress: {
          phase: "bootstrap" as const,
          total: 1000,
          processed: 100,
          percentComplete: 10,
        },
      };
    });

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    // After sync completes, progress should be cleared (state is idle)
    const statuses = engine.getStatuses();
    expect(statuses[0].state).toBe("idle");
    expect(statuses[0].progress).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Per-cycle progress E2E: covers the source → SyncEngine → status-listener
  // wire and verifies the collector tracks `processed` against the *current
  // cycle's* queue size, not the lifetime document count. This is the core
  // contract that makes incremental progress bars meaningful — without it, an
  // incremental delta of 5 against a gateway already holding 12000 docs would
  // immediately clamp to 100% because cumulative-processed (12005) overshoots
  // any reasonable cycle total.
  // ---------------------------------------------------------------------------

  test("incremental progress reflects cycle queue, not lifetime totals", async () => {
    // Pre-populate the gateway with 100 docs from a prior bootstrap.
    for (let i = 0; i < 100; i++) gateway.documents.push(makeDoc(`old-${i}`));

    const captured: Array<{ event: string; processed?: number; total?: number; pct?: number }> = [];

    let call = 0;
    const source = makeSource("test-source", "test", async () => {
      call++;
      // 5-doc incremental queue spread over 2 pages (3 + 2). Source pins
      // `total = 5` across pages — the collector should compute processed
      // and percentage *only* against this cycle's work.
      if (call === 1) {
        return {
          documents: [makeDoc("new-1"), makeDoc("new-2"), makeDoc("new-3")],
          deletedExternalIds: [],
          cursor: { pageToken: "p2", cycleQueueTotal: 5 },
          hasMore: true,
          progress: { phase: "incremental" as const, total: 5, processed: 3 },
        };
      }
      return {
        documents: [makeDoc("new-4"), makeDoc("new-5")],
        deletedExternalIds: [],
        cursor: { cycleQueueTotal: undefined },
        hasMore: false,
        progress: { phase: "incremental" as const, total: 5, processed: 5 },
      };
    });

    engine.registerProvider(makeProvider("test", true, [source]));
    engine.onStatusChange((change) => {
      captured.push({
        event: change.event,
        processed: change.status.progress?.processed,
        total: change.status.progress?.total,
        pct: change.status.progress?.percentComplete,
      });
    });

    await engine.syncAll();

    const progressEvents = captured.filter((e) => e.event === "sync.progress");

    // At least one mid-sync progress event landed (page 1 → page 2 transition).
    expect(progressEvents.length).toBeGreaterThan(0);

    // Every emitted progress is bounded by the cycle's 5-doc queue. The
    // pre-existing 100 docs in the gateway must NOT bleed into `processed`
    // (the previous `existingDocs + totalDocs` accounting did exactly that
    // and is what we deliberately removed).
    for (const ev of progressEvents) {
      expect(ev.total).toBe(5);
      expect(ev.processed).toBeGreaterThan(0);
      expect(ev.processed).toBeLessThanOrEqual(5);
      expect(ev.pct).toBeLessThanOrEqual(100);
    }

    // sync.completed clears progress.
    const completed = captured.find((e) => e.event === "sync.completed");
    expect(completed).toBeDefined();
    expect(completed!.processed).toBeUndefined();
  });

  test("bootstrap progress accumulates within the cycle across pages", async () => {
    const captured: Array<{ event: string; processed?: number; total?: number }> = [];

    let call = 0;
    const source = makeSource("test-source", "test", async () => {
      call++;
      // Bootstrap that pages through 8 docs in batches of 3, 3, 2. Source
      // pins total=8; collector should report processed = totalDocs
      // accumulated across pages (cycle-local), reaching 8 at the end.
      if (call === 1) {
        return {
          documents: [makeDoc("a"), makeDoc("b"), makeDoc("c")],
          deletedExternalIds: [],
          cursor: { pageToken: "p2", cycleQueueTotal: 8 },
          hasMore: true,
          progress: { phase: "bootstrap" as const, total: 8, processed: 3 },
        };
      }
      if (call === 2) {
        return {
          documents: [makeDoc("d"), makeDoc("e"), makeDoc("f")],
          deletedExternalIds: [],
          cursor: { pageToken: "p3", cycleQueueTotal: 8 },
          hasMore: true,
          progress: { phase: "bootstrap" as const, total: 8, processed: 6 },
        };
      }
      return {
        documents: [makeDoc("g"), makeDoc("h")],
        deletedExternalIds: [],
        cursor: { cycleQueueTotal: undefined },
        hasMore: false,
        progress: { phase: "bootstrap" as const, total: 8, processed: 8 },
      };
    });

    engine.registerProvider(makeProvider("test", true, [source]));
    engine.onStatusChange((change) => {
      captured.push({
        event: change.event,
        processed: change.status.progress?.processed,
        total: change.status.progress?.total,
      });
    });

    await engine.syncAll();

    const progressEvents = captured.filter((e) => e.event === "sync.progress");
    // Each progress event observed mid-sync should report processed ≤ 8.
    for (const ev of progressEvents) {
      expect(ev.total).toBe(8);
      expect(ev.processed).toBeLessThanOrEqual(8);
    }
  });
});

describe("SyncEngine", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  test("syncs a single source with one page", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [makeDoc("doc-1"), makeDoc("doc-2")],
      deletedExternalIds: [],
      cursor: { offset: 2 },
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    expect(gateway.documents).toHaveLength(2);
    expect(gateway.syncStates.get("test-source")?.cursor).toEqual({
      offset: 2,
    });
  });

  test("refreshes source metadata without reading or rewriting its cursor", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    source.account = { id: "local", subject: { kind: "opaque", value: "discovered-subject" } };
    gateway.syncStates.set("test-source", {
      sourceId: "test-source",
      cursor: { revision: 7 },
      lastSyncedAt: "2026-01-01T00:00:00Z",
    });
    engine.registerProvider(makeProvider("test", true, [source]));

    await engine.startSyncLoop({}, { skipInitialSync: true });
    engine.stopSyncLoop();

    expect(gateway.syncStates.get("test-source")?.cursor).toEqual({ revision: 7 });
    expect(gateway.metaUpdates).toHaveLength(2);
    expect(gateway.metaUpdates.every((update) => update.meta.account === source.account)).toBe(
      true,
    );
    await engine.refreshAllSourceMeta();
    expect(gateway.metaUpdates).toHaveLength(3);
  });

  test("handles multi-page sync", async () => {
    let callCount = 0;
    const source = makeSource("test-source", "test", async (cursor) => {
      callCount++;
      if (callCount === 1) {
        return {
          documents: [makeDoc("doc-1")],
          deletedExternalIds: [],
          cursor: { page: 2 },
          hasMore: true,
        };
      }
      return {
        documents: [makeDoc("doc-2")],
        deletedExternalIds: [],
        cursor: { page: 3 },
        hasMore: false,
      };
    });

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    expect(callCount).toBe(2);
    expect(gateway.documents).toHaveLength(2);
    expect(gateway.syncStates.get("test-source")?.cursor).toEqual({ page: 3 });
  });

  test("passes existing cursor to source on subsequent sync", async () => {
    let receivedCursor: SyncCursor | null = null;
    const source = makeSource("test-source", "test", async (cursor) => {
      receivedCursor = cursor;
      return {
        documents: [],
        deletedExternalIds: [],
        cursor: { historyId: "200" },
        hasMore: false,
      };
    });

    // Pre-set sync state as if we've synced before
    gateway.syncStates.set("test-source", {
      sourceId: "test-source",
      cursor: { historyId: "100" },
      lastSyncedAt: "2024-01-01T00:00:00Z",
    });

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    expect(receivedCursor).toEqual({ historyId: "100" });
  });

  test("sends deletions to gateway", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: ["old-1", "old-2"],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncAll();

    expect(gateway.deletedIds).toHaveLength(1);
    expect(gateway.deletedIds[0].ids).toEqual(["old-1", "old-2"]);
  });

  test("skips unauthenticated providers", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [makeDoc("doc-1")],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", false, [source]));
    await engine.syncAll();

    expect(gateway.documents).toHaveLength(0);
  });

  test("syncs multiple providers independently", async () => {
    const source1 = makeSource("source-a", "provider-a", async () => ({
      documents: [makeDoc("a-1")],
      deletedExternalIds: [],
      cursor: { a: true },
      hasMore: false,
    }));

    const source2 = makeSource("source-b", "provider-b", async () => ({
      documents: [makeDoc("b-1"), makeDoc("b-2")],
      deletedExternalIds: [],
      cursor: { b: true },
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("provider-a", true, [source1]));
    engine.registerProvider(makeProvider("provider-b", true, [source2]));
    await engine.syncAll();

    expect(gateway.documents).toHaveLength(3);
    expect(gateway.syncStates.get("source-a")?.cursor).toEqual({ a: true });
    expect(gateway.syncStates.get("source-b")?.cursor).toEqual({ b: true });
  });

  test("continues syncing other sources when one fails", async () => {
    const failSource = makeSource("fail-source", "test", async () => {
      throw new Error("API error");
    });

    const okSource = makeSource("ok-source", "test", async () => ({
      documents: [makeDoc("doc-1")],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [failSource, okSource]));
    await engine.syncAll();

    // The ok source should still have synced
    expect(gateway.documents).toHaveLength(1);
  });

  test("does not write documents when documents array is empty (cursor still advances)", async () => {
    // Post-#322 the runner calls `upsertWithCursor` on every page (the
    // cursor MUST advance), but the documents body field is empty when
    // there are no docs. Assert: the call happens, the documents field
    // is empty, the cursor lands in syncStates.
    let documentsBatches = 0;
    let cursorWrites = 0;
    const spyGateway = {
      ...gateway,
      upsertWithCursor: async (args: Parameters<typeof gateway.upsertWithCursor>[0]) => {
        if (args.documents && args.documents.length > 0) documentsBatches++;
        cursorWrites++;
        return gateway.upsertWithCursor(args);
      },
      getDocumentCount: gateway.getDocumentCount.bind(gateway),
      getSyncState: gateway.getSyncState.bind(gateway),
      getWipeEpoch: gateway.getWipeEpoch.bind(gateway),
      setSyncState: gateway.setSyncState.bind(gateway),
      deleteDocuments: gateway.deleteDocuments.bind(gateway),
      ping: gateway.ping.bind(gateway),
    };

    const engine2 = new SyncEngine(spyGateway);
    const source = makeSource("test-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine2.registerProvider(makeProvider("test", true, [source]));
    await engine2.syncAll();

    expect(documentsBatches).toBe(0);
    expect(cursorWrites).toBe(1);
  });
});

describe("SyncEngine.pushLinkDeclarations", () => {
  test("preserves snapshot order when the first publication is delayed", async () => {
    const gateway = new MockGateway();
    const engine = new SyncEngine(gateway);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    gateway.setLinkDeclarations = vi.fn(async (input) => {
      calls++;
      if (calls === 1) await firstBlocked;
      gateway.linkDeclarations.push(input);
    });
    const oldSource = {
      ...makeSource("old-source", "test", async () => ({
        documents: [],
        deletedExternalIds: [],
        cursor: {},
        hasMore: false,
      })),
      urlHub: true,
    };
    const newSource = {
      ...makeSource("new-source", "test", async () => ({
        documents: [],
        deletedExternalIds: [],
        cursor: {},
        hasMore: false,
      })),
      urlTargetRole: "reference" as const,
    };

    const first = engine.pushLinkDeclarations(
      [{ regex: "old[.]example" }],
      [{ source: oldSource }],
    );
    const second = engine.pushLinkDeclarations(
      [{ regex: "new[.]example" }],
      [{ source: newSource }],
    );
    await vi.waitFor(() => expect(gateway.setLinkDeclarations).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(gateway.linkDeclarations.map((entry) => entry.patterns)).toEqual([
      [{ regex: "old[.]example" }],
      [{ regex: "new[.]example" }],
    ]);
    expect(gateway.linkDeclarations[1]?.referenceOnlyPrefixes).toEqual(["new-source"]);
  });
});

async function waitForCondition(fn: () => boolean, timeoutMs = 2000, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitForCondition timed out");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

describe("SyncEngine push registrations are released when a source stops", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway, { watchDebounceMs: 10 });
  });

  afterEach(() => {
    engine.stopSyncLoop();
  });

  /** A push source that reports whether it is still registered. */
  function pushSource(id: string): {
    source: RegisteredSource;
    live: () => { push: boolean; error: boolean };
    registrations: () => number;
  } {
    const state = { push: false, error: false };
    let registrations = 0;
    const source = makeSource(id, "push-test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    source.instance.onPushEvent = () => {
      registrations += 1;
      state.push = true;
      return () => {
        state.push = false;
      };
    };
    source.instance.onSourceError = () => {
      state.error = true;
      return () => {
        state.error = false;
      };
    };
    return { source, live: () => ({ ...state }), registrations: () => registrations };
  }

  test("stopping a source unregisters both its push and its error callback", async () => {
    // Without this a registration outlives the source that made it: the
    // callback keeps firing into a host that has stopped listening, and the
    // only thing making that harmless is every source happening to replace
    // its previous callback rather than appending.
    const { source, live } = pushSource("push:one");
    engine.registerProvider(makeProvider("push-test", true, [source]));
    await engine.startSyncLoop();
    expect(live()).toEqual({ push: true, error: true });

    await engine.unregisterSource("push:one");

    expect(live()).toEqual({ push: false, error: false });
  });

  test("a disabled and re-enabled source ends with exactly one live registration", async () => {
    // Disable tears the registration down; re-enable makes a fresh one. Before
    // the handle existed the teardown could not happen, so the guard was the
    // only thing between a re-enable and a second live callback — and the
    // guard it had asked whether a debounce timer existed, which is only true
    // between a push and the sync it triggers.
    const { source, live, registrations } = pushSource("push:cycle");
    engine.registerProvider(makeProvider("push-test", true, [source]));
    await engine.startSyncLoop();
    expect(registrations()).toBe(1);

    await engine.disableSource("push:cycle");
    expect(live().push, "disabling releases the registration").toBe(false);

    await engine.enableSource("push:cycle");
    expect(live().push, "re-enabling makes a new one").toBe(true);
    expect(registrations(), "and only one").toBe(2);
  });

  test("a source that returns no handle still works", async () => {
    // Returning one is optional: a source written before there was anything to
    // return is wired for the process's lifetime, exactly as it was.
    let wired = false;
    const source = makeSource("push:legacy", "push-test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    source.instance.onPushEvent = () => {
      wired = true;
    };
    engine.registerProvider(makeProvider("push-test", true, [source]));
    await engine.startSyncLoop();
    expect(wired).toBe(true);

    await expect(engine.unregisterSource("push:legacy")).resolves.toBeUndefined();
  });
});

describe("SyncEngine file watching", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;
  let tmpDir: string;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway, { watchDebounceMs: 100, filePollIntervalMs: 500 });
    tmpDir = mkdtempSync(join(tmpdir(), "sync-engine-watch-test-"));
  });

  afterEach(() => {
    engine.stopSyncLoop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("sets fileWatchActive for sources with watchPaths", async () => {
    const watchFile = join(tmpDir, "test.db");
    writeFileSync(watchFile, "");

    let syncCount = 0;
    const source = makeSource(
      "watched-source",
      "test",
      async () => {
        syncCount++;
        return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
      },
      { watchPaths: [watchFile] },
    );

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.startSyncLoop();

    const statuses = engine.getStatuses();
    expect(statuses[0].fileWatchActive).toBe(true);
  });

  test("does not set fileWatchActive for sources without watchPaths", async () => {
    const source = makeSource("normal-source", "test", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.startSyncLoop();

    const statuses = engine.getStatuses();
    expect(statuses[0].fileWatchActive).toBeUndefined();
  });

  test("skips non-existent watch paths gracefully", async () => {
    const source = makeSource(
      "watched-source",
      "test",
      async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
      { watchPaths: [join(tmpDir, "missing-parent", "nonexistent.db")] },
    );

    engine.registerProvider(makeProvider("test", true, [source]));
    // Should not throw
    await engine.startSyncLoop();

    const statuses = engine.getStatuses();
    // No watchers were set up, so fileWatchActive should not be set
    expect(statuses[0].fileWatchActive).toBeUndefined();
  });

  test("watches a file path that does not exist yet when the parent directory exists", async () => {
    const watchFile = join(tmpDir, "future-wal.db-wal");

    let syncCount = 0;
    const source = makeSource(
      "watched-source",
      "test",
      async () => {
        syncCount++;
        return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
      },
      { watchPaths: [watchFile] },
    );

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.startSyncLoop();

    const statuses = engine.getStatuses();
    expect(statuses[0].fileWatchActive).toBe(true);

    const initialSyncCount = syncCount;
    writeFileSync(watchFile, "created");
    await waitForCondition(() => syncCount > initialSyncCount, 5000);

    expect(syncCount).toBeGreaterThan(initialSyncCount);
  });

  test("file change triggers debounced sync", async () => {
    const watchFile = join(tmpDir, "test.db");
    writeFileSync(watchFile, "initial");

    let syncCount = 0;
    const source = makeSource(
      "watched-source",
      "test",
      async () => {
        syncCount++;
        return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
      },
      { watchPaths: [watchFile] },
    );

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.startSyncLoop();

    // Initial sync happened
    const initialSyncCount = syncCount;

    // Modify the file
    writeFileSync(watchFile, "changed");

    // Wait for file watcher poll + debounce to trigger sync (longer timeout for full-suite runs)
    await waitForCondition(() => syncCount > initialSyncCount, 5000);

    expect(syncCount).toBeGreaterThan(initialSyncCount);
  });

  test("multiple rapid changes debounce to single sync", async () => {
    const watchFile = join(tmpDir, "test.db");
    writeFileSync(watchFile, "initial");

    let syncCount = 0;
    const source = makeSource(
      "watched-source",
      "test",
      async () => {
        syncCount++;
        return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
      },
      { watchPaths: [watchFile] },
    );

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.startSyncLoop();

    const afterInitial = syncCount;

    // Rapid writes within the debounce window (must be shorter than debounce)
    writeFileSync(watchFile, "change1");
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(watchFile, "change2");
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(watchFile, "change3");

    // Wait for the debounced sync to complete
    await waitForCondition(() => syncCount > afterInitial, 3000);

    // Small extra wait to ensure no additional syncs fire
    await new Promise((r) => setTimeout(r, 300));

    // Should have triggered only one additional sync (debounced)
    expect(syncCount).toBe(afterInitial + 1);
  });

  test("stopSyncLoop cleans up watchers", async () => {
    const watchFile = join(tmpDir, "test.db");
    writeFileSync(watchFile, "initial");

    let syncCount = 0;
    const source = makeSource(
      "watched-source",
      "test",
      async () => {
        syncCount++;
        return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
      },
      { watchPaths: [watchFile] },
    );

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.startSyncLoop();

    const afterInitial = syncCount;
    engine.stopSyncLoop();

    // Modify file after stop — should not trigger sync
    writeFileSync(watchFile, "after-stop");
    await new Promise((r) => setTimeout(r, 300));

    expect(syncCount).toBe(afterInitial);
  });
});

describe("SyncEngine onSourceError", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  afterEach(() => {
    engine.stopSyncLoop();
  });

  test("source error immediately sets status to error and emits event", async () => {
    let errorHandler: ((error: string) => void) | undefined;

    const source = makeSource("wa-source", "whatsapp", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    // Add onSourceError that captures the handler
    (source.instance as any).onSourceError = (cb: (error: string) => void) => {
      errorHandler = cb;
    };

    const events: any[] = [];
    engine.onStatusChange((change) => events.push(change));
    engine.registerProvider(makeProvider("whatsapp", true, [source]));
    await engine.startSyncLoop();

    // Verify source starts as idle
    expect(engine.getStatuses()[0].state).toBe("idle");

    // Simulate connection error (e.g. device unlinked)
    errorHandler!("WhatsApp logged out — device was unlinked");

    // Status should immediately be "error"
    const statuses = engine.getStatuses();
    expect(statuses[0].state).toBe("error");
    expect(statuses[0].lastError).toBe("WhatsApp logged out — device was unlinked");

    // Should have emitted a sync.error event
    const errorEvents = events.filter((e) => e.event === "sync.error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].sourceId).toBe("wa-source");
    expect(errorEvents[0].status.state).toBe("error");
  });

  test("runtime-added source still gets onSourceError wiring (regression)", async () => {
    // Reproduces collector-runtime-added-sources-skip-onSourceError-wiring:
    // setupSourceErrorHandler used to live only in setupFileWatchers, so
    // sources registered after collector startup never wired their error
    // callback. WhatsApp logout / future Baileys-style disconnects then
    // silently dropped instead of surfacing as `sync.error` events.
    let errorHandler: ((error: string) => void) | undefined;

    // Boot the engine with no providers (simulates a freshly started
    // collector with no configured sources).
    await engine.startSyncLoop();

    // Now add a source the runtime way (post-startup) and ensure the
    // error handler still gets wired by startSourceSyncLoops.
    const source = makeSource("late-source", "whatsapp", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    (source.instance as any).onSourceError = (cb: (error: string) => void) => {
      errorHandler = cb;
    };
    const provider = makeProvider("whatsapp", true, [source]);
    engine.registerProvider(provider);
    await engine.startSourceSyncLoops(provider.sources);

    const events: any[] = [];
    engine.onStatusChange((change) => events.push(change));

    expect(errorHandler).toBeDefined();
    errorHandler!("WhatsApp logged out — runtime-add path");

    const statuses = engine.getStatuses();
    const lateSource = statuses.find((s) => s.sourceId === "late-source");
    expect(lateSource?.state).toBe("error");
    expect(lateSource?.lastError).toBe("WhatsApp logged out — runtime-add path");
    expect(
      events.filter((e) => e.event === "sync.error" && e.sourceId === "late-source"),
    ).toHaveLength(1);
  });

  test("source error does not affect disabled sources", async () => {
    let errorHandler: ((error: string) => void) | undefined;

    const source = makeSource("wa-source", "whatsapp", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    (source.instance as any).onSourceError = (cb: (error: string) => void) => {
      errorHandler = cb;
    };

    engine.registerProvider(makeProvider("whatsapp", true, [source]));
    await engine.startSyncLoop();
    engine.disableSource("wa-source");

    // Fire error on disabled source
    errorHandler!("some error");

    // Should still be disabled, not error
    expect(engine.getStatuses()[0].state).toBe("disabled");
  });

  test("disable suspends a push source's connection; re-enable resumes it", async () => {
    let suspended = 0;
    let resumed = 0;
    const source = makeSource("wa-source", "whatsapp", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    // A push source holding a live connection declares suspend/resume; disable
    // must call suspend (stop the socket + reconnect loop), not just stop timers,
    // or loops stack on re-enable. (suspend/resume are invoked for any instance
    // that defines them — the engine does not branch on push-ness.)
    (source.instance as any).suspend = async () => {
      suspended++;
    };
    (source.instance as any).resume = async () => {
      resumed++;
    };

    engine.registerProvider(makeProvider("whatsapp", true, [source]));
    await engine.startSyncLoop();

    await engine.disableSource("wa-source");
    expect(suspended).toBe(1);
    expect(resumed).toBe(0);
    // Instance is retained (kept for re-enable) and the status reads "disabled".
    expect(engine.getSourcesById("wa-source")).toHaveLength(1);
    expect(engine.getStatuses().find((s) => s.sourceId === "wa-source")?.state).toBe("disabled");

    await engine.enableSource("wa-source");
    expect(resumed).toBe(1);
    expect(engine.getStatuses().find((s) => s.sourceId === "wa-source")?.state).not.toBe(
      "disabled",
    );
  });
});

describe("SyncEngine staggered initial sync (boot rush mitigation)", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  test("staggeredInitialSync spreads first-syncs over a window proportional to staggerMs", async () => {
    // 5 sources × 100ms stagger = expected start times: 0, 100, 200, 300, 400ms.
    const startTimes: Record<string, number> = {};
    const t0 = Date.now();

    const makeStaggerSource = (id: string) =>
      makeSource(id, "test", async () => {
        startTimes[id] = Date.now() - t0;
        return { documents: [], cursor: {}, hasMore: false };
      });

    const sources = ["s1", "s2", "s3", "s4", "s5"].map(makeStaggerSource);
    engine.registerProvider(makeProvider("test", true, sources));

    await engine.staggeredInitialSync(100);

    // Every source ran exactly once.
    expect(Object.keys(startTimes).sort()).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    // Each source is armed as its own timer at `i * staggerMs`, and a timer
    // never fires before its due time, so every start lands at or after its
    // own slot however late a busy event loop runs it. That lower bound is
    // the spread the stagger guarantees. The gap between two consecutive
    // starts is not a guarantee: a starved loop runs one slot late and the
    // next on time, so it is deliberately not asserted.
    const times = ["s1", "s2", "s3", "s4", "s5"].map((id) => startTimes[id]);
    times.forEach((startedAt, i) => {
      expect(startedAt).toBeGreaterThanOrEqual(i * 100 - 5);
    });
  });

  test("staggeredInitialSync skips push-based sources (no sync invoked)", async () => {
    let pushSyncCount = 0;
    let pullSyncCount = 0;

    const pushSource: RegisteredSource = {
      ...makeSource("push", "test", async () => {
        pushSyncCount++;
        return { documents: [], cursor: {}, hasMore: false };
      }),
      pushBased: true,
    };
    const pullSource = makeSource("pull", "test", async () => {
      pullSyncCount++;
      return { documents: [], cursor: {}, hasMore: false };
    });

    engine.registerProvider(makeProvider("test", true, [pushSource, pullSource]));
    await engine.staggeredInitialSync(10);

    expect(pushSyncCount).toBe(0);
    expect(pullSyncCount).toBe(1);
  });

  test("staggeredInitialSync waits for ALL sources to complete before resolving", async () => {
    let s1Completed = false;
    let s2Completed = false;

    const s1 = makeSource("s1", "test", async () => {
      await new Promise((r) => setTimeout(r, 50));
      s1Completed = true;
      return { documents: [], cursor: {}, hasMore: false };
    });
    const s2 = makeSource("s2", "test", async () => {
      await new Promise((r) => setTimeout(r, 50));
      s2Completed = true;
      return { documents: [], cursor: {}, hasMore: false };
    });

    engine.registerProvider(makeProvider("test", true, [s1, s2]));
    await engine.staggeredInitialSync(20);

    // Both sources must have completed by the time the promise resolves.
    expect(s1Completed).toBe(true);
    expect(s2Completed).toBe(true);
  });

  test("staggeredInitialSync survives a source whose sync() throws", async () => {
    let s2Ran = false;

    const s1 = makeSource("s1", "test", async () => {
      throw new Error("simulated source crash");
    });
    const s2 = makeSource("s2", "test", async () => {
      s2Ran = true;
      return { documents: [], cursor: {}, hasMore: false };
    });

    engine.registerProvider(makeProvider("test", true, [s1, s2]));

    // Must not reject. s2 still runs after s1 throws.
    await expect(engine.staggeredInitialSync(20)).resolves.toBeUndefined();
    expect(s2Ran).toBe(true);
  });
});

describe("SyncEngine stopSyncLoopAndDrain", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  afterEach(() => {
    engine.stopSyncLoop();
  });

  test("returns immediately when no syncs are in flight", async () => {
    const r = await engine.stopSyncLoopAndDrain(1_000);
    expect(r.inflight).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("waits for an in-flight sync to settle", async () => {
    let resolveSync!: () => void;
    const syncDone = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    let syncFinished = false;

    const source = makeSource("slow", "test", async () => {
      await syncDone;
      syncFinished = true;
      return { documents: [], cursor: {}, hasMore: false };
    });
    engine.registerProvider(makeProvider("test", true, [source]));

    // Kick off sync but don't await — simulate an in-flight timer tick.
    const sp = engine.syncSource(source);

    // Sync hasn't finished yet.
    expect(syncFinished).toBe(false);

    // Drain (with generous timeout); the sync settles when we resolve.
    setTimeout(() => resolveSync(), 20);
    const r = await engine.stopSyncLoopAndDrain(2_000);
    expect(r.inflight).toBe(1);
    expect(r.timedOut).toBe(false);
    expect(syncFinished).toBe(true);
    await sp;
  });

  test("hits the timeout cap on a hung sync without throwing", async () => {
    let resolveSync!: () => void;
    const syncDone = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });

    const source = makeSource("hung", "test", async () => {
      await syncDone;
      return { documents: [], cursor: {}, hasMore: false };
    });
    engine.registerProvider(makeProvider("test", true, [source]));
    const sp = engine.syncSource(source).catch(() => undefined);

    const start = Date.now();
    const r = await engine.stopSyncLoopAndDrain(50);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(r.inflight).toBe(1);
    expect(r.timedOut).toBe(true);

    // Let the hung sync finish so the test exits cleanly.
    resolveSync();
    await sp;
  });

  test("a sync that hits the wall-clock timeout resolves syncSource, never rejects (#554)", async () => {
    // Short sync timeout + a sync that never settles → runOne's timeout wins
    // and re-throws. syncSource must swallow it: a rejection here would reach
    // the dispatcher's fire-and-forget call and crash the whole collector via
    // the process-level unhandledRejection handler.
    const timeoutEngine = new SyncEngine(gateway, { syncTimeoutMs: 50 });
    let resolveSync!: () => void;
    const syncDone = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const source = makeSource("hung-timeout", "test", async () => {
      await syncDone;
      return { documents: [], cursor: {}, hasMore: false };
    });
    timeoutEngine.registerProvider(makeProvider("test", true, [source]));

    await expect(timeoutEngine.syncSource(source)).resolves.toBeUndefined();

    resolveSync();
    timeoutEngine.stopSyncLoop();
  });
});

describe("SyncEngine forwards metadata.sourceUrl verbatim", () => {
  // The collector no longer rewrites `metadata.sourceUrl` even when a
  // source declares a `urlCanonicalizer`. Sources are responsible for
  // emitting an openable user-facing URL; the gateway separately
  // canonicalizes into the `documents.source_url` column for dedup.
  // This split keeps "Open in source" links pointing at a real
  // navigable URL while preserving stable lookup keys.
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  test("forwards sourceUrl verbatim when source declares a canonicalizer", async () => {
    // Shape-only canonicalizer to prove the collector does NOT apply it
    // to `metadata.sourceUrl`. The regex here is illustrative — see
    // `packages/providers/google/src/index.ts` for the production rule.
    const gmailLike: UrlCanonicalizerSpec = {
      hosts: ["mail.google.com"],
      rules: [
        {
          match:
            "^https://mail\\.google\\.com/mail(?:/u/[^/]+)?/?#(?:[^/]+/)*([0-9a-fA-F]{6,})(?:[?#].*)?$",
          replacement: "https://mail.google.com/mail/#message/$1",
        },
      ],
    };

    const source = makeSource(
      "gmail:test@example.com",
      "google:test@example.com",
      async () => ({
        documents: [
          {
            providerId: "google:test@example.com",
            sourceId: "gmail:test@example.com",
            externalId: "msg-1",
            title: "test",
            content: "body",
            contentHash: "h1",
            metadata: {
              sourceUrl: "https://mail.google.com/mail/u/0/#all/19e1ceef94bbacb5",
            },
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
        ],
        deletedExternalIds: [],
        cursor: {},
        hasMore: false,
      }),
      { urlCanonicalizer: gmailLike },
    );

    engine.registerProvider(makeProvider("google:test@example.com", true, [source]));
    await engine.syncSource(source);

    expect(gateway.documents).toHaveLength(1);
    expect(gateway.documents[0].metadata.sourceUrl).toBe(
      "https://mail.google.com/mail/u/0/#all/19e1ceef94bbacb5",
    );
  });

  test("forwards sourceUrl untouched when source declares no canonicalizer", async () => {
    const source = makeSource("test-source", "test", async () => ({
      documents: [
        {
          providerId: "test",
          sourceId: "test-source",
          externalId: "d1",
          title: "test",
          content: "body",
          contentHash: "h1",
          metadata: { sourceUrl: "https://example.com/raw/path?with=junk" },
          sourceCreatedAt: "2024-01-01T00:00:00Z",
          sourceUpdatedAt: "2024-01-01T00:00:00Z",
        },
      ],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));

    engine.registerProvider(makeProvider("test", true, [source]));
    await engine.syncSource(source);

    expect(gateway.documents).toHaveLength(1);
    expect(gateway.documents[0].metadata.sourceUrl).toBe("https://example.com/raw/path?with=junk");
  });
});

describe("SyncEngine rate-limit scheduler deferral (#616)", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
    vi.useFakeTimers();
    // Pin jitter to 0 so the first scheduled tick lands exactly at `interval`.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    engine.stopSyncLoop();
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  const INTERVAL = 60_000; // `defaultSyncInterval: "1m"` below

  test("a scheduled tick that rate-limits defers the next tick to max(interval, retryAfterMs)", async () => {
    // retryAfterMs (10m) > interval (1m) → next tick deferred to 10m, NOT 1m.
    const RETRY_AFTER = 10 * 60_000;
    let syncCount = 0;
    const source = makeSource("eb:acct1", "enable-banking:acct1", async () => {
      syncCount += 1;
      throw new SyncError("rate-limit", "ASPSP cap reached", { retryAfterMs: RETRY_AFTER });
    });
    engine.registerProvider(makeProvider("enable-banking:acct1", true, [source]));

    // Arm the per-source timer without the boot-time initial sync.
    await engine.startSyncLoop({ defaultSyncInterval: "1m" }, { skipInitialSync: true });

    // First scheduled tick fires at exactly `interval` (jitter pinned to 0).
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(syncCount).toBe(1);
    expect(engine.getStatuses().find((s) => s.sourceId === "eb:acct1")?.state).toBe("rate-limited");

    // Through several NORMAL intervals the source must NOT be retried — it's
    // deferred until the back-off elapses (no retry storm).
    await vi.advanceTimersByTimeAsync(INTERVAL * 8);
    expect(syncCount).toBe(1);

    // Crossing the retryAfter deadline fires exactly one deferred tick.
    await vi.advanceTimersByTimeAsync(RETRY_AFTER - INTERVAL * 8);
    expect(syncCount).toBe(2);
  });

  test("retryAfterMs < interval → next tick lands at the normal interval (the max)", async () => {
    // retryAfterMs (5s) < interval (1m) → defer to max = 1m, i.e. unchanged
    // cadence. A short back-off must never pull the next tick EARLIER.
    const RETRY_AFTER = 5_000;
    let syncCount = 0;
    const source = makeSource("eb:acct3", "enable-banking:acct3", async () => {
      syncCount += 1;
      throw new SyncError("rate-limit", "429", { retryAfterMs: RETRY_AFTER });
    });
    engine.registerProvider(makeProvider("enable-banking:acct3", true, [source]));

    await engine.startSyncLoop({ defaultSyncInterval: "1m" }, { skipInitialSync: true });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(syncCount).toBe(1);

    // The 5s back-off must NOT fire a retry before the normal interval.
    await vi.advanceTimersByTimeAsync(RETRY_AFTER + 1);
    expect(syncCount).toBe(1);

    // …it lands at the normal 1m cadence instead.
    await vi.advanceTimersByTimeAsync(INTERVAL - (RETRY_AFTER + 1));
    expect(syncCount).toBe(2);
  });

  test("after the deferred tick succeeds, cadence returns to the normal interval (deferral is one-shot)", async () => {
    const RETRY_AFTER = 10 * 60_000;
    let syncCount = 0;
    const source = makeSource("eb:acct2", "enable-banking:acct2", async () => {
      syncCount += 1;
      // Rate-limit only on the very first call; succeed forever after.
      if (syncCount === 1) {
        throw new SyncError("rate-limit", "cap reached", { retryAfterMs: RETRY_AFTER });
      }
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });
    engine.registerProvider(makeProvider("enable-banking:acct2", true, [source]));

    await engine.startSyncLoop({ defaultSyncInterval: "1m" }, { skipInitialSync: true });

    await vi.advanceTimersByTimeAsync(INTERVAL); // tick 1 → rate-limited
    expect(syncCount).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_AFTER); // deferred tick 2 → succeeds
    expect(syncCount).toBe(2);
    expect(engine.getStatuses().find((s) => s.sourceId === "eb:acct2")?.state).toBe("idle");

    // Steady cadence resumed: the next tick lands one normal interval later.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(syncCount).toBe(3);
  });

  test("a non-rate-limit error keeps the normal interval (no deferral, regression guard)", async () => {
    let syncCount = 0;
    const source = makeSource("plain:acct", "plain:acct", async () => {
      syncCount += 1;
      throw new Error("boom");
    });
    engine.registerProvider(makeProvider("plain:acct", true, [source]));

    await engine.startSyncLoop({ defaultSyncInterval: "1m" }, { skipInitialSync: true });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(syncCount).toBe(1);
    expect(engine.getStatuses().find((s) => s.sourceId === "plain:acct")?.state).toBe("error");

    // No deferral — the steady interval keeps ticking on the normal cadence.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(syncCount).toBe(2);
  });
});

describe("SyncEngine.pushAnalyticsSchemas", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  test("registers each declared analytics schema with the gateway (empty records, schema, sourceId)", async () => {
    const noop = async (): Promise<SyncResult> => ({ documents: [], hasMore: false, cursor: {} });
    const balances = makeAnalyticsSchema("coinbase_balances");
    const fills = makeAnalyticsSchema("coinbase_fills");
    const source = makeSource("coinbase:portfolio-1", "coinbase", noop, {
      analyticsSchemas: [balances, fills],
    });
    engine.registerProvider(makeProvider("coinbase", true, [source]));

    await engine.pushAnalyticsSchemas();

    expect(gateway.analyticsPushes).toHaveLength(2);
    for (const push of gateway.analyticsPushes) {
      // Schema-only registration: no rows, but the schema + sourceId travel so
      // the gateway refreshes its catalog row (incl. the #757 record contract).
      expect(push.records).toEqual([]);
      expect(push.sourceId).toBe("coinbase:portfolio-1");
      expect(push.schema?.semanticTimeColumn).toBe("occurred_at");
      expect(push.schema?.record).toBeDefined();
    }
    expect(gateway.analyticsPushes.map((p) => p.tableName).sort()).toEqual([
      "coinbase_balances",
      "coinbase_fills",
    ]);
  });

  test("skips sources that declare no analytics schemas", async () => {
    const noop = async (): Promise<SyncResult> => ({ documents: [], hasMore: false, cursor: {} });
    const plain = makeSource("gmail:user@example.com", "google", noop);
    engine.registerProvider(makeProvider("google", true, [plain]));

    await engine.pushAnalyticsSchemas();

    expect(gateway.analyticsPushes).toHaveLength(0);
  });
});

describe("SyncEngine startSourceSyncLoops scheduling order", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
    vi.useFakeTimers();
    // Pin jitter to 0 so the first scheduled tick lands exactly at `interval`.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    engine.stopSyncLoop();
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  test("a slow source's initial sync does not hold back the sources behind it", async () => {
    // A collector start — and every `add` — hands its sources over in one
    // call. Running their initial syncs one after another puts everything
    // behind the slowest: add a calendar next to a mailbox bootstrapping a
    // hundred thousand messages and the calendar does not sync until its
    // interval comes round, looking idle for minutes with nothing to show the
    // operator why. Both the timer and the initial sync have to be per-source.
    const INTERVAL = 60_000; // `defaultSyncInterval: "1m"` below
    let releaseSlow: (() => void) | undefined;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowSyncs = 0;
    let laterSyncs = 0;

    const slow = makeSource("slow:acct", "slow", async () => {
      slowSyncs += 1;
      await slowDone;
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });
    const later = makeSource("later:acct", "later", async () => {
      laterSyncs += 1;
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });
    engine.registerProvider(makeProvider("slow", true, [slow]));
    engine.registerProvider(makeProvider("later", true, [later]));

    // Not awaited: the call parks on the first source's initial sync, exactly
    // as it does on a real collector start.
    const loops = engine.startSourceSyncLoops([slow, later], { defaultSyncInterval: "1m" });

    // No timer has fired yet: this is the initial sync alone.
    await vi.advanceTimersByTimeAsync(0);
    expect(slowSyncs, "the slow source's initial sync is in flight").toBe(1);
    expect(
      laterSyncs,
      "the later source syncs straight away rather than queueing behind the slow one",
    ).toBe(1);

    // And its timer is armed independently, so it keeps ticking regardless.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(slowSyncs, "the slow source is still parked on its initial sync").toBe(1);
    expect(laterSyncs, "the later source's own timer fired").toBe(2);

    releaseSlow!();
    await loops;
  });

  test("an armed timer does not double-run a source's initial sync", async () => {
    // Arming up front means a tick can land while the initial sync of that
    // same source is still running. The dispatcher's state guard has to be
    // what keeps the two from overlapping.
    const INTERVAL = 60_000;
    let releaseSlow: (() => void) | undefined;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let syncs = 0;
    const slow = makeSource("slow:acct", "slow", async () => {
      syncs += 1;
      await slowDone;
      return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
    });
    engine.registerProvider(makeProvider("slow", true, [slow]));

    const loops = engine.startSourceSyncLoops([slow], { defaultSyncInterval: "1m" });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(syncs, "ticks during an in-flight sync are skipped, not stacked").toBe(1);

    releaseSlow!();
    await loops;
  });
});

describe("SyncEngine restart", () => {
  let gateway: MockGateway;
  let engine: SyncEngine;

  beforeEach(() => {
    gateway = new MockGateway();
    engine = new SyncEngine(gateway);
  });

  afterEach(() => {
    engine.stopSyncLoop();
  });

  /** A source whose first sync stays open until its signal aborts, recording every call. */
  function abortableSource(onResync: () => void) {
    const runs: Array<{ aborted: boolean }> = [];
    const source = makeSource("chat-synth:acct", "test", async () => {
      throw new Error("replaced below");
    });
    source.instance = {
      onResync,
      sync: async (_cursor: SyncCursor | null, opts?: { signal?: AbortSignal }) => {
        const run = { aborted: false };
        runs.push(run);
        if (runs.length === 1) {
          await new Promise<never>((_, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              run.aborted = true;
              reject(new Error("sync aborted"));
            });
          });
        }
        return {
          documents: [makeDoc(`run-${runs.length}`)],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        };
      },
    };
    return { source, runs };
  }

  test("a restart aborts the run in flight and starts over once it has stopped, after onResync", async () => {
    const events: string[] = [];
    const { source, runs } = abortableSource(() => events.push("onResync"));
    engine.registerProvider(makeProvider("test", true, [source]));

    const first = engine.syncSource(source);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(engine.getStatuses()[0]!.state).toBe("syncing");

    const result = engine.triggerSync("chat-synth:acct", { restart: true });
    expect(result.restarting).toEqual(["chat-synth:acct"]);
    expect(result.skipped).toEqual([]);

    await first;
    expect(runs[0]!.aborted).toBe(true);
    // The fresh run starts from the aborted run's terminal transition, with
    // the source's state reset first; the aborted run is never reported as
    // an error.
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(events).toEqual(["onResync"]);
    await vi.waitFor(() => expect(engine.getStatuses()[0]!.state).toBe("idle"));
    expect(engine.getStatuses()[0]!.lastError).toBeUndefined();
    expect(gateway.documents.map((d) => d.externalId)).toEqual(["run-2"]);
  });

  test("a restart is consumed before the fresh run fires, so a failing fresh run does not loop", async () => {
    let calls = 0;
    const source = makeSource("flaky-synth:acct", "test", async () => {
      calls += 1;
      throw new Error("upstream down");
    });
    source.instance.onResync = () => {};
    engine.registerProvider(makeProvider("test", true, [source]));
    // Claim the source as syncing the way a run in flight would, then restart it.
    engine.getStatuses()[0]!.state = "syncing";
    const restart = engine.triggerSync("flaky-synth:acct", { restart: true });
    expect(restart.restarting).toEqual(["flaky-synth:acct"]);
    // The claimed run's terminal transition fires the restart once.
    await engine.syncSource(source);
    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    expect(engine.getStatuses()[0]!.state).toBe("error");
  });

  test("a restart pending while the collector stops is dropped, so the drain leaks no fresh run", async () => {
    const { source, runs } = abortableSource(() => {});
    engine.registerProvider(makeProvider("test", true, [source]));
    const first = engine.syncSource(source);
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    // The restart aborts the run in flight; the drain begins before that
    // run has unwound, so the restart is still owed when it does.
    const restart = engine.triggerSync("chat-synth:acct", { restart: true });
    expect(restart.restarting).toEqual(["chat-synth:acct"]);
    const drained = await engine.stopSyncLoopAndDrain(2_000);
    await first;
    await new Promise((r) => setTimeout(r, 50));

    expect(drained).toEqual({ inflight: 1, timedOut: false });
    expect(runs, "no run may start once the collector is stopping").toHaveLength(1);
  });

  test("an aborted run whose restart starts nothing reports the state the source is left in", async () => {
    let authenticated = true;
    const { source, runs } = abortableSource(() => {});
    engine.registerProvider({
      id: "test" as ProviderId,
      name: "test",
      credentialState: async () => ({ status: authenticated ? "connected" : "revoked" }) as const,
      renewableCredential: true,
      sources: [source],
    });
    const reported: string[] = [];
    engine.onStatusChange((change) => reported.push(change.status.state));
    const first = engine.syncSource(source);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(reported.at(-1)).toBe("syncing");

    // The credential lapses under the run: the restart's fresh sync cannot
    // start, and the aborted run's own exit reports nothing.
    authenticated = false;
    engine.triggerSync("chat-synth:acct", { restart: true });
    await first;
    await vi.waitFor(() => expect(engine.getStatuses()[0]!.state).toBe("needs-auth"));
    await new Promise((r) => setTimeout(r, 20));

    expect(runs).toHaveLength(1);
    // What reached the gateway after the run it saw start: the aborted run's
    // release, then the cause the restart found.
    expect(reported.slice(reported.lastIndexOf("syncing") + 1)).toEqual(["idle", "needs-auth"]);
  });

  test("a restart pending on a source that is disabled meanwhile never fires", async () => {
    const { source, runs } = abortableSource(() => {});
    engine.registerProvider(makeProvider("test", true, [source]));
    const first = engine.syncSource(source);
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    engine.triggerSync("chat-synth:acct", { restart: true });
    await engine.disableSource("chat-synth:acct");
    await first;
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toHaveLength(1);
    expect(engine.getStatuses()[0]!.state).toBe("disabled");
  });
});

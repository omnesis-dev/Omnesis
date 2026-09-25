// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the TTL-cleanup periodic tasks. We exercise the
 * tasks' `run()` directly with a stub WriteGate + the real
 * AuthFlowRegistry so the test stays focused on task semantics
 * (idle/active toggling, swallow on error, calls into the gate).
 *
 * End-to-end scheduling is covered by the existing scheduler test
 * suite — periodic-task wiring is identical to the other bundles.
 */

import { describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { DeviceId, SourceType } from "@omnesis/types";
import { Scheduler } from "../scheduler.js";
import { MainTaskRunner } from "../runners/main.js";
import { AuthFlowRegistry } from "../../auth-flows.js";
import { ImportFlowRegistry } from "../../import-flows.js";
import { createCleanupTasks } from "./cleanup.js";
import type { WriteGate } from "../../write-gate.js";
import type {
  AccessCleanupPhase,
  AccessCleanupResult,
  OAuthClientCleanupCursor,
} from "../../access/store-cleanup.js";

const log = createLogger("test:cleanup");

// Fake but well-formed UUIDs — DeviceId() now validates UUID-v4 shape.
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";

function makeStubWriteGate(opts: {
  pairings?: number | (() => number);
  sessions?: number | (() => number);
  tokens?: number | (() => number);
  notifications?: number | (() => number);
  access?: (
    phase: AccessCleanupPhase,
    now: number,
    limit: number,
    cursor?: OAuthClientCleanupCursor,
  ) => AccessCleanupResult;
  pairingsThrows?: boolean;
  sessionsThrows?: boolean;
  tokensThrows?: boolean;
  notificationsThrows?: boolean;
}): {
  gate: WriteGate;
  pairingCalls: number;
  sessionCalls: number;
  tokenCalls: number;
  notificationCalls: number[];
  accessCalls: Array<{
    phase: AccessCleanupPhase;
    now: number;
    limit: number;
    cursor?: OAuthClientCleanupCursor;
  }>;
} {
  const state = {
    pairingCalls: 0,
    sessionCalls: 0,
    tokenCalls: 0,
    notificationCalls: [] as number[],
    accessCalls: [] as Array<{
      phase: AccessCleanupPhase;
      now: number;
      limit: number;
      cursor?: OAuthClientCleanupCursor;
    }>,
  };
  // We only need cleanup* methods; use Proxy to surface the rest as
  // stubs that throw if accidentally called.
  const handler: ProxyHandler<WriteGate> = {
    get(_t, prop) {
      if (prop === "cleanupExpiredPairings") {
        return async () => {
          state.pairingCalls += 1;
          if (opts.pairingsThrows) throw new Error("simulated pairings failure");
          return typeof opts.pairings === "function" ? opts.pairings() : (opts.pairings ?? 0);
        };
      }
      if (prop === "cleanupExpiredSessions") {
        return async () => {
          state.sessionCalls += 1;
          if (opts.sessionsThrows) throw new Error("simulated sessions failure");
          return typeof opts.sessions === "function" ? opts.sessions() : (opts.sessions ?? 0);
        };
      }
      if (prop === "cleanupExpiredTokens") {
        return async () => {
          state.tokenCalls += 1;
          if (opts.tokensThrows) throw new Error("simulated tokens failure");
          return typeof opts.tokens === "function" ? opts.tokens() : (opts.tokens ?? 0);
        };
      }
      if (prop === "cleanupExpiredNotifications") {
        return async (now: number) => {
          state.notificationCalls.push(now);
          if (opts.notificationsThrows) throw new Error("simulated notifications failure");
          return typeof opts.notifications === "function"
            ? opts.notifications()
            : (opts.notifications ?? 0);
        };
      }
      if (prop === "cleanupExpiredAccessStateBatch") {
        return async (
          phase: AccessCleanupPhase,
          now: number,
          limit: number,
          cursor?: OAuthClientCleanupCursor,
        ) => {
          state.accessCalls.push({ phase, now, limit, ...(cursor ? { cursor } : {}) });
          return (
            opts.access?.(phase, now, limit, cursor) ?? {
              phase,
              deleted: 0,
              hasMore: false,
            }
          );
        };
      }
      return () => {
        throw new Error(`unexpected WriteGate.${String(prop)}() call`);
      };
    },
  };
  return {
    gate: new Proxy({} as WriteGate, handler),
    get pairingCalls() {
      return state.pairingCalls;
    },
    get sessionCalls() {
      return state.sessionCalls;
    },
    get tokenCalls() {
      return state.tokenCalls;
    },
    get notificationCalls() {
      return state.notificationCalls;
    },
    get accessCalls() {
      return state.accessCalls;
    },
  };
}

function makeScheduler(): { scheduler: Scheduler } {
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(new MainTaskRunner({ concurrency: 4 }));
  return { scheduler };
}

describe("createCleanupTasks", () => {
  test("schedules seven periodic tasks with the expected names", () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({ pairings: 0, sessions: 0, tokens: 0 });
    const authFlows = new AuthFlowRegistry({ ttlMs: 5_000 });
    const bundle = createCleanupTasks(
      { writeGate: stub.gate, authFlows, importFlows: new ImportFlowRegistry(), log },
      scheduler,
    );
    expect(bundle.tasks.map((t) => t.name)).toEqual([
      "devices.cleanupExpiredPairings.tick",
      "tokens.cleanupExpiredSessions.tick",
      "tokens.cleanupExpiredTokens.tick",
      "notifications.cleanupExpired.tick",
      "access.cleanupExpired.tick",
      "authFlows.cleanup.tick",
      "importFlows.cleanup.tick",
    ]);
    expect(bundle.jobs).toHaveLength(7);
    expect(bundle.tasks[3]?.startDelayMs).toBe(0);
  });

  test("access cleanup stays on a phase until its bounded batches converge", async () => {
    const { scheduler } = makeScheduler();
    let authorizationRequestCalls = 0;
    const stub = makeStubWriteGate({
      access: (phase) => {
        if (phase === "authorizationRequests") {
          authorizationRequestCalls += 1;
          return {
            phase,
            deleted: authorizationRequestCalls === 1 ? 2 : 1,
            hasMore: authorizationRequestCalls === 1,
          };
        }
        return { phase, deleted: 0, hasMore: false };
      },
    });
    const bundle = createCleanupTasks(
      {
        writeGate: stub.gate,
        authFlows: new AuthFlowRegistry(),
        importFlows: new ImportFlowRegistry(),
        log,
        now: () => 12_345,
        accessBatchSize: 2,
      },
      scheduler,
    );
    const accessTask = bundle.tasks[4]!;
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };

    for (let tick = 0; tick < 7; tick += 1) {
      const out = await accessTask.run(undefined, ctx);
      expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
    }

    expect(stub.accessCalls).toEqual([
      { phase: "executionBindings", now: 12_345, limit: 2 },
      { phase: "authorizationRequests", now: 12_345, limit: 2 },
      { phase: "authorizationRequests", now: 12_345, limit: 2 },
      { phase: "accessTokens", now: 12_345, limit: 2 },
      { phase: "refreshTokens", now: 12_345, limit: 2 },
      { phase: "auditEvents", now: 12_345, limit: 2 },
      { phase: "oauthClients", now: 12_345, limit: 2 },
    ]);
  });

  test("a clean access sweep asks to wake for the soonest pending request", async () => {
    // Nothing to delete now, but a request falls due 30s out: the sweep asks
    // for that moment plus a second, not its idle period.
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({
      access: (phase) =>
        phase === "authorizationRequests"
          ? { phase, deleted: 0, hasMore: false, nextDueAt: 12_345 + 30_000 }
          : { phase, deleted: 0, hasMore: false },
    });
    const bundle = createCleanupTasks(
      {
        writeGate: stub.gate,
        authFlows: new AuthFlowRegistry(),
        importFlows: new ImportFlowRegistry(),
        log,
        now: () => 12_345,
        accessIntervalMs: 1_000,
        accessIdleMs: 6 * 60 * 60_000,
      },
      scheduler,
    );
    const accessTask = bundle.tasks[4]!;
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };

    let last: unknown;
    for (let tick = 0; tick < 6; tick += 1) last = await accessTask.run(undefined, ctx);
    const value = (last as { kind: "done"; value: { idle: boolean; nextDueAt?: number } }).value;
    expect(value).toEqual({ idle: true, nextDueAt: 42_345 });
    expect(accessTask.nextDelayMs!(value)).toBe(31_000);

    // An active sweep keeps its period; a clean one with nothing pending keeps its idle.
    expect(accessTask.nextDelayMs!({ idle: false, nextDueAt: 42_345 })).toBeUndefined();
    expect(accessTask.nextDelayMs!({ idle: true })).toBeUndefined();
    // A due moment already behind the clock still waits at least one period.
    expect(accessTask.nextDelayMs!({ idle: true, nextDueAt: 12_000 })).toBe(1_000);
  });

  test("access cleanup backs off only after a complete clean sweep", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({});
    const bundle = createCleanupTasks(
      {
        writeGate: stub.gate,
        authFlows: new AuthFlowRegistry(),
        importFlows: new ImportFlowRegistry(),
        log,
      },
      scheduler,
    );
    const accessTask = bundle.tasks[4]!;
    const ctx = {
      shouldYield: () => true,
      elapsedMs: () => 2_000,
      signal: new AbortController().signal,
      log,
    };
    let idle = false;
    for (let tick = 0; tick < 6; tick += 1) {
      const out = await accessTask.run(undefined, ctx);
      idle = (out as { kind: "done"; value: { idle: boolean } }).value.idle;
    }
    expect(idle).toBe(true);
    expect(stub.accessCalls.map((call) => call.phase)).toEqual([
      "executionBindings",
      "authorizationRequests",
      "accessTokens",
      "refreshTokens",
      "auditEvents",
      "oauthClients",
    ]);
  });

  test("carries the OAuth-client keyset cursor between bounded writer ticks", async () => {
    const { scheduler } = makeScheduler();
    let oauthCalls = 0;
    const stub = makeStubWriteGate({
      access: (phase, _now, _limit, cursor) => {
        if (phase !== "oauthClients") return { phase, deleted: 0, hasMore: false };
        oauthCalls += 1;
        if (oauthCalls === 1) {
          expect(cursor).toBeUndefined();
          return {
            phase,
            deleted: 0,
            hasMore: true,
            cursor: { createdAt: 1_234, clientId: "client-cursor" },
          };
        }
        expect(cursor).toEqual({ createdAt: 1_234, clientId: "client-cursor" });
        return { phase, deleted: 1, hasMore: false };
      },
    });
    const bundle = createCleanupTasks(
      {
        writeGate: stub.gate,
        authFlows: new AuthFlowRegistry(),
        importFlows: new ImportFlowRegistry(),
        log,
      },
      scheduler,
    );
    const task = bundle.tasks[4]!;
    const context = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };
    for (let tick = 0; tick < 7; tick += 1) await task.run(undefined, context);
    expect(oauthCalls).toBe(2);
  });

  test("tokens tick: returns active when expired callback tokens deleted", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({ tokens: 3 });
    const authFlows = new AuthFlowRegistry();
    const bundle = createCleanupTasks(
      { writeGate: stub.gate, authFlows, importFlows: new ImportFlowRegistry(), log },
      scheduler,
    );
    const tokensTask = bundle.tasks[2];
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };
    const out = await tokensTask.run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
    expect(stub.tokenCalls).toBe(1);
  });

  test("pairings tick: returns idle when zero rows deleted", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({ pairings: 0 });
    const authFlows = new AuthFlowRegistry();
    const bundle = createCleanupTasks(
      { writeGate: stub.gate, authFlows, importFlows: new ImportFlowRegistry(), log },
      scheduler,
    );
    const pairingsTask = bundle.tasks[0];
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };
    const out = await pairingsTask.run(undefined, ctx);
    expect(out.kind).toBe("done");
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);
    expect(stub.pairingCalls).toBe(1);
  });

  test("notifications tick globally expires content at the supplied clock time", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({ notifications: 2 });
    const bundle = createCleanupTasks(
      {
        writeGate: stub.gate,
        authFlows: new AuthFlowRegistry(),
        importFlows: new ImportFlowRegistry(),
        log,
        now: () => 12_345,
      },
      scheduler,
    );
    const out = await bundle.tasks[3]!.run(undefined, {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    });
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
    expect(stub.notificationCalls).toEqual([12_345]);
  });

  test("sessions tick: returns active when rows deleted", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({ sessions: 7 });
    const authFlows = new AuthFlowRegistry();
    const bundle = createCleanupTasks(
      { writeGate: stub.gate, authFlows, importFlows: new ImportFlowRegistry(), log },
      scheduler,
    );
    const sessionsTask = bundle.tasks[1];
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };
    const out = await sessionsTask.run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
  });

  test("a writeGate failure is swallowed; tick still returns idle (not throw)", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({ pairingsThrows: true });
    const authFlows = new AuthFlowRegistry();
    const bundle = createCleanupTasks(
      { writeGate: stub.gate, authFlows, importFlows: new ImportFlowRegistry(), log },
      scheduler,
    );
    const pairingsTask = bundle.tasks[0];
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };
    const out = await pairingsTask.run(undefined, ctx);
    expect(out.kind).toBe("done");
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);
  });

  test("authFlows tick: removes expired flows", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({});
    const authFlows = new AuthFlowRegistry({ ttlMs: 1 });
    authFlows.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(D1) });
    authFlows.start({ sourceType: SourceType("notion"), deviceId: DeviceId(D2) });
    const bundle = createCleanupTasks(
      { writeGate: stub.gate, authFlows, importFlows: new ImportFlowRegistry(), log },
      scheduler,
    );
    await new Promise((r) => setTimeout(r, 5));
    const authTask = bundle.tasks[5];
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };
    const out = await authTask.run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(false);
    expect(authFlows.list()).toHaveLength(0);
  });

  test("authFlows tick: idle when nothing expired", async () => {
    const { scheduler } = makeScheduler();
    const stub = makeStubWriteGate({});
    const authFlows = new AuthFlowRegistry({ ttlMs: 60_000 });
    authFlows.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(D1) });
    const bundle = createCleanupTasks(
      { writeGate: stub.gate, authFlows, importFlows: new ImportFlowRegistry(), log },
      scheduler,
    );
    const authTask = bundle.tasks[5];
    const ctx = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };
    const out = await authTask.run(undefined, ctx);
    expect((out as { kind: "done"; value: { idle: boolean } }).value.idle).toBe(true);
    expect(authFlows.list()).toHaveLength(1);
  });
});

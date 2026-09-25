// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent route dependency composition, tested where it is actually wired.
 *
 * `withCallerResolver` has unit tests, and they were green through the whole
 * life of a bug that made the rule it exists to enforce unreachable in
 * production: the resolver sat in a branch a real gateway never takes, so every
 * off-host integration resolved as the operator and could enumerate every watch
 * on the install. A test that hands the routes a resolver cannot notice that
 * nobody else does.
 *
 * So this boots the real `createServer`, through the same `agentRouteDeps`
 * branch `index.ts` takes, and asserts the caller a request is attributed to.
 * Delete the `withCallerResolver` call in `server.ts` and these redden.
 * It also asserts that composition preserves the lifecycle-owned object's
 * identity, because model recovery replaces its service after routes mount.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, type Scope } from "@omnesis/types";

import { createDatabase } from "./db.js";
import { createServer } from "./server.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { createToken } from "./data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";
import type { ToolCaller } from "@omnesis/agent";
import type { AgentRoutesDeps } from "./http/routes/agent.js";

type Db = Database.Database;

let db: Db;
let dbPath: string;

/** The caller the last `POST /agent/sessions` was attributed to. */
let seenCaller: ToolCaller | undefined;

/**
 * The narrowest stand-in for `AgentService` the session route will accept: it
 * records who the route said is asking and returns a minimal session. The
 * question under test is the attribution, not what the harness then does.
 */
function recordingAgentService(): AgentRoutesDeps["agentService"] {
  return {
    createSession(_ownerId: string, opts: { caller?: ToolCaller }) {
      seenCaller = opts.caller;
      return Promise.resolve({
        sessionId: "session-under-test",
        backend: "recording",
        model: "recording",
        messages: [],
        origin: "portal",
      });
    },
  } as unknown as AgentRoutesDeps["agentService"];
}

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/**
 * A real gateway, wired the way `index.ts` wires one: the agent lifecycle hands
 * `createServer` its own `agentRouteDeps`, carrying no resolver of its own.
 */
function bootGateway(agentRouteDeps: AgentRoutesDeps = { agentService: recordingAgentService() }) {
  return createServer(db, dbPath, {
    agentRouteDeps,
  });
}

/** A paired device and an admin token on it, as any caller of the API holds. */
function pairedCaller(capabilities?: { agentIntegration: { harness: string } }): string {
  const device = createDevice(db, {
    name: `caller-${randomUUID()}`,
    kind: capabilities ? "agent" : "cli",
    ...(capabilities ? { capabilities } : {}),
  });
  return createToken(db, device.id, [SCOPE_ADMIN] as Scope[]).token;
}

async function openSession(app: ReturnType<typeof createServer>, token: string) {
  const res = await app.request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  seenCaller = undefined;
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("the assembled gateway attributes a caller", () => {
  test("a device declaring an integration speaks for that integration", async () => {
    const token = pairedCaller({ agentIntegration: { harness: "openclaw" } });

    await openSession(bootGateway(), token);

    expect(seenCaller).toEqual({ kind: "integration", slug: "openclaw" });
  });

  test("a device declaring none is the operator's own surface", async () => {
    const token = pairedCaller();

    await openSession(bootGateway(), token);

    expect(seenCaller).toEqual({ kind: "operator" });
  });

  // Two integrations must not collapse into one audience: the slug is read per
  // device, so a second harness on the same gateway is a different caller.
  test("a second integration is a different caller, not the first", async () => {
    const app = bootGateway();

    await openSession(app, pairedCaller({ agentIntegration: { harness: "hermes" } }));

    expect(seenCaller).toEqual({ kind: "integration", slug: "hermes" });
  });

  test("agent lifecycle changes remain visible after the routes are mounted", async () => {
    const bootDeps = {
      disabledReason: "Backend probe pending.",
      agentConfig: {
        backend: "http",
        enabled: false,
        disabledReason: "Backend probe pending.",
      },
    } satisfies AgentRoutesDeps;
    const agentRouteDeps: AgentRoutesDeps = bootDeps;
    const app = bootGateway(agentRouteDeps);
    const token = pairedCaller();

    const unavailable = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(unavailable.status).toBe(503);

    agentRouteDeps.agentService = recordingAgentService();
    agentRouteDeps.disabledReason = undefined;
    agentRouteDeps.agentConfig = { backend: "http", enabled: true };

    await openSession(app, token);
    const config = await app.request("/admin/agent/config", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ backend: "http", enabled: true });
  });
});

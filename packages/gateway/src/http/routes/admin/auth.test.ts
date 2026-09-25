// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the code-delivery half of the auth-flow routes:
 * POST /admin/auth-flows/:id/code and GET /oauth/callback. Pins the
 * single-use latch contract — a code is accepted only while the flow is
 * awaiting one, the flow flips to `completing` BEFORE the forward, and a
 * second delivery is rejected — plus the `?error=` branch's
 * awaiting-state guard and collector `auth.cancel` reap. Also covers
 * POST /admin/auth-flows forwarding the optional re-auth `accountId`
 * into the collector's `auth.begin` command.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, DeviceId, SourceType, type Scope } from "@omnesis/types";
import { friendlyOauthError } from "../../oauth-callback.js";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../../../write-gate.js";
import { AuthFlowRegistry, type AuthFlow } from "../../../auth-flows.js";
import type { DeviceWsServer } from "../../../ws.js";
import type { WireChallenge } from "@omnesis/source-sdk";

type Db = ReturnType<typeof createDatabase>;

const COLLECTOR_DEVICE_ID = "11111111-1111-4111-8111-111111111111";

let db: Db;
let dbPath: string;
let authFlows: AuthFlowRegistry;
let sendCommand: ReturnType<typeof vi.fn>;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function startFlow(state: AuthFlow["state"]): AuthFlow {
  const flow = authFlows.start({
    sourceType: SourceType("test-oauth-source"),
    deviceId: DeviceId(COLLECTOR_DEVICE_ID),
  });
  if (state !== "starting") authFlows.update(flow.id, { state });
  return flow;
}

function postCode(flowId: string, code: string): Promise<Response> {
  return app.request(`/admin/auth-flows/${encodeURIComponent(flowId)}/code`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
}

function getCallback(query: string): Promise<Response> {
  // /oauth/callback is scope.public() — no token on purpose.
  return app.request(`/oauth/callback?${query}`);
}

describe("typed challenge answers", () => {
  function answer(flowId: string, challengeId = "c1") {
    return app.request(`/admin/auth-flows/${flowId}/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ challengeId, answer: { code: "123456" } }),
    });
  }
  test.each([
    [{ kind: "code", title: "Shown code" }, false],
    [{ kind: "qr", title: "Scan", data: "payload" }, true],
    [
      { kind: "redirect", title: "Connect", via: "gateway", url: "https://example.org/connect" },
      true,
    ],
    [{ kind: "widget", title: "Connect", renderer: "example", payload: {} }, true],
  ] satisfies Array<[WireChallenge, boolean]>)(
    "refuses an answer on the wrong channel %j",
    async (challenge, expectsAnswer) => {
      const flow = startFlow("awaiting-user");
      authFlows.ingestEvent(flow.id, { type: "challenge", id: "c1", challenge, expectsAnswer });
      expect((await answer(flow.id)).status).toBe(409);
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );
  test("accepts a question once and lets the next question be answered", async () => {
    const flow = startFlow("awaiting-user");
    authFlows.ingestEvent(flow.id, {
      type: "challenge",
      id: "c1",
      challenge: { kind: "code", title: "Enter" },
      expectsAnswer: true,
    });
    expect((await answer(flow.id)).status).toBe(200);
    expect((await answer(flow.id)).status).toBe(409);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    authFlows.ingestEvent(flow.id, {
      type: "challenge",
      id: "c2",
      challenge: { kind: "code", title: "Enter next" },
      expectsAnswer: true,
    });
    expect((await answer(flow.id)).status).toBe(409);
    expect((await answer(flow.id, "c2")).status).toBe(200);
  });
  test("rejects a retained question on a nonawaiting flow", async () => {
    const flow = startFlow("awaiting-user");
    authFlows.ingestEvent(flow.id, {
      type: "challenge",
      id: "c1",
      challenge: { kind: "code", title: "Enter" },
      expectsAnswer: true,
    });
    authFlows.update(flow.id, { state: "completing" });
    expect((await answer(flow.id)).status).toBe(409);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  dbPath = `/tmp/omnesis-auth-code-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  authFlows = new AuthFlowRegistry();
  sendCommand = vi.fn().mockResolvedValue({ ok: true });
  // `isConnected` always-true so the collector-device resolver treats any
  // collector created by a test as online.
  app = createServer(db, dbPath, {
    writeGate: directWriteGate(db),
    authFlows,
    wsServer: { sendCommand, isConnected: () => true } as unknown as DeviceWsServer,
  });
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("POST /admin/auth-flows", () => {
  test("cancellation wins over success arriving while its collector command is in flight", async () => {
    const flow = startFlow("awaiting-user");
    sendCommand.mockImplementationOnce(async () => {
      expect(authFlows.get(flow.id)?.errorDetail?.code).toBe("user-cancelled");
      authFlows.ingestEvent(flow.id, { type: "complete", ok: true, accountId: "late-account" });
      return { ok: true };
    });
    const response = await app.request(`/admin/auth-flows/${flow.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(authFlows.get(flow.id)?.state).toBe("error");
    expect(authFlows.get(flow.id)?.resolvedAccountId).toBeUndefined();
  });

  test("cancelling an already completed flow leaves its successful result alone", async () => {
    const flow = startFlow("awaiting-user");
    authFlows.ingestEvent(flow.id, { type: "complete", ok: true, accountId: "local" });
    const response = await app.request(`/admin/auth-flows/${flow.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(authFlows.get(flow.id)?.resolvedAccountId).toBe("local");
  });
  test("user cancellation emits its typed outcome and clears the pending question", async () => {
    const flow = startFlow("awaiting-user");
    authFlows.ingestEvent(flow.id, {
      type: "challenge",
      id: "question",
      challenge: { kind: "code", title: "Code" },
      expectsAnswer: true,
    });
    const events: unknown[] = [];
    authFlows.subscribe(flow.id, (event) => events.push(event));
    const response = await app.request(`/admin/auth-flows/${flow.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(events).toContainEqual({
      type: "complete",
      ok: false,
      error: "cancelled",
      code: "user-cancelled",
    });
    expect(authFlows.get(flow.id)?.errorDetail?.code).toBe("user-cancelled");
    expect(authFlows.get(flow.id)?.pendingChallenge).toBeUndefined();
  });

  function startFlowRequest(body: Record<string, unknown>): Promise<Response> {
    return app.request("/admin/auth-flows", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  test("re-auth: forwards accountId in auth.begin and stores it on the flow record", async () => {
    const collector = createDevice(db, { name: `collector-${randomUUID()}`, kind: "collector" });
    const res = await startFlowRequest({
      sourceType: "test-oauth-source",
      accountId: "maya@example.com",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flowId: string; deviceId: string };
    expect(body.deviceId).toBe(collector.id);
    expect(sendCommand).toHaveBeenCalledWith(
      collector.id,
      "auth.begin",
      {
        flowId: body.flowId,
        sourceType: "test-oauth-source",
        params: undefined,
        accountId: "maya@example.com",
      },
      30_000,
    );
    expect(authFlows.get(body.flowId)?.accountId).toBe("maya@example.com");
  });

  test("first-time add: accountId stays absent in the auth.begin command", async () => {
    createDevice(db, { name: `collector-${randomUUID()}`, kind: "collector" });
    const res = await startFlowRequest({ sourceType: "test-oauth-source" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flowId: string };
    expect(sendCommand).toHaveBeenCalledTimes(1);
    const [, command, payload] = sendCommand.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(command).toBe("auth.begin");
    expect(payload.flowId).toBe(body.flowId);
    expect(payload.accountId).toBeUndefined();
    expect(authFlows.get(body.flowId)?.accountId).toBeUndefined();
  });

  test("forwards the configured publicBaseUrl in the auth.begin command", async () => {
    // A server wired with gateway.publicBaseUrl forwards it so the
    // provider's authFlow can build ${publicBaseUrl}/oauth/callback.
    app = createServer(db, dbPath, {
      writeGate: directWriteGate(db),
      authFlows,
      wsServer: { sendCommand, isConnected: () => true } as unknown as DeviceWsServer,
      publicBaseUrl: "https://gw.example.com:7600",
    });
    createDevice(db, { name: `collector-${randomUUID()}`, kind: "collector" });
    const res = await startFlowRequest({ sourceType: "test-oauth-source" });
    expect(res.status).toBe(200);
    const [, command, payload] = sendCommand.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(command).toBe("auth.begin");
    expect(payload.publicBaseUrl).toBe("https://gw.example.com:7600");
  });

  test("publicBaseUrl is undefined in auth.begin when the gateway has none configured", async () => {
    createDevice(db, { name: `collector-${randomUUID()}`, kind: "collector" });
    const res = await startFlowRequest({ sourceType: "test-oauth-source" });
    expect(res.status).toBe(200);
    const [, , payload] = sendCommand.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(payload.publicBaseUrl).toBeUndefined();
  });
});

describe("POST /admin/auth-flows/:id/code", () => {
  test("awaiting-user flow: forwards auth.code over WS and flips state to completing", async () => {
    const flow = startFlow("awaiting-user");
    const res = await postCode(flow.id, "decoded@code");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(
      COLLECTOR_DEVICE_ID,
      "auth.code",
      { flowId: flow.id, code: "decoded@code" },
      30_000,
    );
    expect(authFlows.get(flow.id)?.state).toBe("completing");
  });

  test("awaiting-callback flow is also accepted", async () => {
    const flow = startFlow("awaiting-callback");
    const res = await postCode(flow.id, "cb-code");
    expect(res.status).toBe(200);
    expect(authFlows.get(flow.id)?.state).toBe("completing");
  });

  test("second delivery is rejected with 409 and not forwarded twice", async () => {
    const flow = startFlow("awaiting-user");
    expect((await postCode(flow.id, "first")).status).toBe(200);
    const second = await postCode(flow.id, "second");
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("CONFLICT");
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(authFlows.get(flow.id)?.state).toBe("completing");
  });

  test("delivery in a non-awaiting state is rejected with 409, nothing forwarded", async () => {
    for (const state of ["starting", "completing", "completed", "error"] as const) {
      const flow = startFlow(state);
      const res = await postCode(flow.id, "early-code");
      expect(res.status).toBe(409);
      expect(authFlows.get(flow.id)?.state).toBe(state);
    }
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("unknown flow id is a 404", async () => {
    expect((await postCode("no-such-flow", "abc")).status).toBe(404);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("WS forward failure flips the flow to error and returns 502", async () => {
    sendCommand.mockRejectedValueOnce(new Error("handler_error: collector offline"));
    const flow = startFlow("awaiting-user");
    const res = await postCode(flow.id, "lost-code");
    expect(res.status).toBe(502);
    expect(authFlows.get(flow.id)?.state).toBe("error");
  });
});

describe("POST /admin/auth-flows/:id/widget-result", () => {
  function postWidgetResult(
    flowId: string,
    token: string,
    metadata?: Record<string, unknown>,
  ): Promise<Response> {
    return app.request(`/admin/auth-flows/${encodeURIComponent(flowId)}/widget-result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token, metadata }),
    });
  }

  test("awaiting flow: forwards auth.widget-result over WS and leaves the flow awaiting", async () => {
    const flow = startFlow("awaiting-user");
    const res = await postWidgetResult(flow.id, "public-sandbox-1", {
      institution: "Example Bank",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendCommand).toHaveBeenCalledWith(
      COLLECTOR_DEVICE_ID,
      "auth.widget-result",
      { flowId: flow.id, token: "public-sandbox-1", metadata: { institution: "Example Bank" } },
      30_000,
    );
    // Not a single-use latch — the flow stays awaiting for the next institution.
    expect(authFlows.get(flow.id)?.state).toBe("awaiting-user");
  });

  test("multiple deliveries are all accepted (one per institution)", async () => {
    const flow = startFlow("awaiting-user");
    expect((await postWidgetResult(flow.id, "public-1")).status).toBe(200);
    expect((await postWidgetResult(flow.id, "public-2")).status).toBe(200);
    expect((await postWidgetResult(flow.id, "public-3")).status).toBe(200);
    expect(sendCommand).toHaveBeenCalledTimes(3);
    expect(authFlows.get(flow.id)?.state).toBe("awaiting-user");
  });

  test("delivery in a non-awaiting state is rejected with 409, nothing forwarded", async () => {
    for (const state of ["starting", "completing", "completed", "error"] as const) {
      const flow = startFlow(state);
      const res = await postWidgetResult(flow.id, "early-token");
      expect(res.status).toBe(409);
      expect(authFlows.get(flow.id)?.state).toBe(state);
    }
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("unknown flow id is a 404", async () => {
    expect((await postWidgetResult("no-such-flow", "tok")).status).toBe(404);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("WS forward failure flips the flow to error and returns 502", async () => {
    sendCommand.mockRejectedValueOnce(new Error("handler_error: collector offline"));
    const flow = startFlow("awaiting-user");
    const res = await postWidgetResult(flow.id, "lost-token");
    expect(res.status).toBe(502);
    expect(authFlows.get(flow.id)?.state).toBe("error");
  });

  test("empty token is rejected by the body validator", async () => {
    const flow = startFlow("awaiting-user");
    const res = await postWidgetResult(flow.id, "");
    expect(res.status).toBe(400);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe("GET /oauth/callback", () => {
  test("code delivery via callback: success page, auth.code forwarded, state completing", async () => {
    const flow = startFlow("awaiting-user");
    const res = await getCallback(`state=${flow.id}&code=cb%40code`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Authorization received");
    // Hono decodes the query param — the collector gets the decoded code.
    expect(sendCommand).toHaveBeenCalledWith(
      COLLECTOR_DEVICE_ID,
      "auth.code",
      { flowId: flow.id, code: "cb@code" },
      30_000,
    );
    expect(authFlows.get(flow.id)?.state).toBe("completing");
  });

  test("second redirect with a code is rejected (single-use), not forwarded again", async () => {
    const flow = startFlow("awaiting-user");
    expect((await getCallback(`state=${flow.id}&code=one`)).status).toBe(200);
    const replay = await getCallback(`state=${flow.id}&code=two`);
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("already used");
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  test("?error= on an awaiting flow flips it to error AND tells the collector someone refused", async () => {
    const flow = startFlow("awaiting-user");
    sendCommand.mockImplementationOnce(async () => {
      expect(authFlows.get(flow.id)?.errorDetail?.code).toBe("denied");
      authFlows.ingestEvent(flow.id, { type: "complete", ok: true, accountId: "late-account" });
      return { ok: true };
    });
    const res = await getCallback(`state=${flow.id}&error=access_denied`);
    expect(res.status).toBe(400);
    expect(authFlows.get(flow.id)?.state).toBe("error");
    expect(authFlows.get(flow.id)?.resolvedAccountId).toBeUndefined();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    // Not merely that the flow is over: the provider is waiting on this
    // answer, and a refusal it can classify is what runs its own failure path
    // — the one chance a provider that has just created something upstream
    // gets to undo it. The detail is the mapped sentence, never the
    // platform's own error string.
    expect(sendCommand).toHaveBeenCalledWith(
      COLLECTOR_DEVICE_ID,
      "auth.cancel",
      { flowId: flow.id, reason: "denied", detail: friendlyOauthError("access_denied") },
      5_000,
    );
  });

  test("an unrecognised provider error is still a refusal, with the generic sentence", async () => {
    const flow = startFlow("awaiting-user");
    await getCallback(`state=${flow.id}&error=${encodeURIComponent("<script>oops</script>")}`);
    const detail = sendCommand.mock.calls[0]?.[2]?.detail as string;
    expect(detail).toBe(friendlyOauthError("anything-unmapped"));
    expect(detail).not.toContain("script");
  });

  test("?error= on a non-awaiting flow leaves the flow untouched and sends nothing", async () => {
    const flow = startFlow("completing");
    const res = await getCallback(`state=${flow.id}&error=access_denied`);
    expect(res.status).toBe(400);
    expect(authFlows.get(flow.id)?.state).toBe("completing");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("unknown flow id renders the not-found page", async () => {
    const res = await getCallback(`state=ghost-flow&code=abc`);
    expect(res.status).toBe(404);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("missing code and missing state are 400s", async () => {
    const flow = startFlow("awaiting-user");
    expect((await getCallback(`state=${flow.id}`)).status).toBe(400);
    expect((await getCallback(`code=abc`)).status).toBe(400);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("code values never reach the console on the failure path", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      sendCommand.mockRejectedValueOnce(new Error("collector offline"));
      const flow = startFlow("awaiting-user");
      const secret = `super-secret-code-${randomUUID()}`;
      const res = await getCallback(`state=${flow.id}&code=${secret}`);
      expect(res.status).toBe(502);
      const allOutput = spies
        .flatMap((s) => s.mock.calls)
        .flat()
        .map(String)
        .join("\n");
      expect(allOutput).not.toContain(secret);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

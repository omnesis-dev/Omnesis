// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every field a flow's events carry, across the hop that rebuilds them.
 *
 * This handler does not forward an auth event whole — it constructs a new
 * object from a fixed list of fields. That is a hop where a field is dropped
 * by being forgotten rather than by being renamed, and it is invisible from
 * either side: a test on the producer reads what the producer wrote, a test on
 * the consumer hands it a payload built by hand, and both stay green while the
 * middle silently discards the field they agree about.
 *
 * It has happened. `expectsAnswer` — the field that tells a client whether an
 * answer is wanted at all — reached this handler and went no further, so every
 * challenge looked like a question, both clients offered a way to answer one
 * that nothing was reading, and the gateway's refusal to deliver a code to a
 * flow that is only showing could never fire.
 *
 * So this suite asserts the crossing itself, field by field, and any field
 * added to an auth event belongs in it.
 */

import { describe, expect, test } from "vitest";

import { SyncStatusRegistry } from "../../sync-status.js";
import { AuthFlowRegistry } from "../../auth-flows.js";
import { WsEventHandler } from "./WsEventHandler.js";
import type { AuthFlowEvent } from "../../auth-flows.js";
import type { WriteGate } from "../../write-gate.js";
import type { DeviceConnection } from "../../ws.js";

const DEVICE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function harness() {
  const authFlows = new AuthFlowRegistry();
  const handler = new WsEventHandler({
    db: {} as ConstructorParameters<typeof WsEventHandler>[0]["db"],
    writeGate: {} as WriteGate,
    syncStatus: new SyncStatusRegistry(),
    authFlows,
  });
  const flow = authFlows.start({
    sourceType: "gmail" as Parameters<AuthFlowRegistry["start"]>[0]["sourceType"],
    deviceId: DEVICE_ID as Parameters<AuthFlowRegistry["start"]>[0]["deviceId"],
  });
  const seen: AuthFlowEvent[] = [];
  authFlows.subscribe(flow.id, (event) => void seen.push(event));
  const conn = { deviceId: DEVICE_ID, scopes: [] } as unknown as DeviceConnection;
  const send = (type: "auth.update" | "auth.complete", payload: Record<string, unknown>) =>
    handler.handleEvent(conn, {
      type,
      payload: { flowId: flow.id, ...payload },
    } as Parameters<WsEventHandler["handleEvent"]>[1]);
  return { authFlows, flow, seen, send };
}

const redirect = {
  kind: "redirect",
  via: "loopback",
  title: "Sign in",
  url: "https://example.org/authorize",
};

describe("a challenge crossing into the gateway", () => {
  test("keeps whether an answer is wanted, in both directions", () => {
    for (const expectsAnswer of [true, false]) {
      const { authFlows, flow, send } = harness();
      send("auth.update", { type: "challenge", id: "c1", challenge: redirect, expectsAnswer });
      expect(authFlows.get(flow.id)?.pendingChallenge?.expectsAnswer).toBe(expectsAnswer);
    }
  });

  test("and a code is refused for one the flow is only showing", () => {
    const { authFlows, flow, send } = harness();
    send("auth.update", {
      type: "challenge",
      id: "c1",
      challenge: redirect,
      expectsAnswer: false,
    });
    const latch = authFlows.acceptCodeDelivery(flow.id);
    expect(latch.ok).toBe(false);
    expect(latch.ok === false && latch.reason).toBe("not-a-question");
  });

  test("assumes an answer is wanted when a collector predates the field", () => {
    const { authFlows, flow, send } = harness();
    send("auth.update", { type: "challenge", id: "c1", challenge: redirect });
    expect(authFlows.get(flow.id)?.pendingChallenge?.expectsAnswer).toBe(true);
  });

  test("carries the challenge itself, under the id an answer will name", () => {
    const { authFlows, flow, send } = harness();
    send("auth.update", { type: "challenge", id: "c7", challenge: redirect, expectsAnswer: true });
    expect(authFlows.get(flow.id)?.pendingChallenge).toMatchObject({
      id: "c7",
      challenge: { kind: "redirect", url: "https://example.org/authorize" },
    });
  });
});

describe("a terminal event crossing into the gateway", () => {
  test("keeps what the flow said about each credential, and what it could not do", () => {
    const { authFlows, flow, send } = harness();
    send("auth.complete", {
      ok: true,
      accountId: "acct-1",
      accountIds: ["acct-1"],
      accountStates: { "acct-1": { status: "connected", expiresAt: "2027-03-12T00:00:00.000Z" } },
      notices: [{ title: "Only the last 90 days were captured." }],
    });
    const stored = authFlows.get(flow.id);
    expect(stored?.resolvedAccountStates).toEqual({
      "acct-1": { status: "connected", expiresAt: "2027-03-12T00:00:00.000Z" },
    });
    expect(stored?.resolvedNotices).toEqual([{ title: "Only the last 90 days were captured." }]);
  });

  test("keeps the code, the credential to route to, and the sentence saying what to do", () => {
    const { authFlows, flow, send } = harness();
    send("auth.complete", {
      ok: false,
      error: "No application credential is configured",
      code: "missing-credentials",
      fileKey: "example-cloud",
      providerName: "example-cloud provider",
      remedy: "Run the credentials wizard for this provider.",
    });
    expect(authFlows.get(flow.id)?.errorDetail).toEqual({
      code: "missing-credentials",
      fileKey: "example-cloud",
      providerName: "example-cloud provider",
      remedy: "Run the credentials wizard for this provider.",
      retryAfterMs: undefined,
    });
  });

  test("keeps how long to wait, which is a different instruction from waiting", () => {
    const { authFlows, flow, send } = harness();
    send("auth.complete", {
      ok: false,
      error: "The bank is refusing further requests for now",
      code: "unavailable",
      retryAfterMs: 6 * 60 * 60 * 1000,
    });
    expect(authFlows.get(flow.id)?.errorDetail?.retryAfterMs).toBe(6 * 60 * 60 * 1000);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A typed challenge, from the collector to a client and back.
 *
 * This exists because of what it caught. The challenge vocabulary had unit
 * coverage at both ends — a fake session on one side, a hand-written event fed
 * to the portal reducer on the other — and both were green while the middle
 * was broken in two independent ways: a provider entry's challenge was dropped
 * on the way to the descriptor, and the gateway renamed the field a client
 * answers with. Every test asserted the shape it had itself written down, so
 * nothing compared the two.
 *
 * So this asserts the hand-offs rather than the ends: what the gateway stores
 * when a collector emits a challenge, what a subscriber actually receives, and
 * what reaches the collector when a client answers.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const harness = new MultiCollectorHarness();
let collector: PairedCollector;

/**
 * Read the SSE stream until `count` `auth` events arrive, or the deadline.
 *
 * The deadline has to bound the read itself, not just the loop around it: a
 * stream that goes quiet leaves `read()` pending forever, and a test waiting
 * for an event that is never coming would then fail as a timeout with nothing
 * said about what it was waiting for.
 */
async function readAuthEvents(flowId: string, count: number, timeoutMs = 10_000) {
  const res = await fetch(`${harness.gatewayUrl}/admin/auth-flows/${flowId}/events`, {
    headers: { Authorization: `Bearer ${harness.bootstrapToken}` },
  });
  if (!res.ok || !res.body) throw new Error(`events stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  let name = "";
  try {
    while (events.length < count && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
      ]);
      if (next === null) break;
      const { value, done } = next;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:") && name === "auth") {
          events.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

async function startFlow(): Promise<string> {
  const started = await harness.json<{ flowId: string }>("/admin/auth-flows", {
    method: "POST",
    body: JSON.stringify({ deviceId: collector.deviceId, sourceType: "synth-chat" }),
  });
  return started.flowId;
}

/** What a collector emits when a source shows or asks something. */
function challengeEvent(
  flowId: string,
  id: string,
  challenge: Record<string, unknown>,
  expectsAnswer?: boolean,
) {
  // Omitted by default on purpose: that is what a collector one version behind
  // sends, and the gateway's reading of silence is part of what is under test.
  return {
    flowId,
    type: "challenge",
    id,
    challenge,
    ...(expectsAnswer === undefined ? {} : { expectsAnswer }),
  };
}

beforeAll(async () => {
  await harness.start();
  collector = await harness.addCollector({
    name: "one",
    hostableSourceTypes: ["synth-chat"],
    descriptors: [
      {
        id: "synth-chat",
        name: "Synth chat",
        description: "A source that connects through the typed session",
        provider: { id: "synth-chat", name: "Synth chat" },
        authType: "qr",
        hasAuthFlow: true,
      },
    ],
  });
}, 120_000);

afterAll(async () => {
  await harness.destroy();
});

describe("a challenge reaches a client with the field it is answered by", () => {
  test("what the collector emits is what a subscriber receives", async () => {
    const flowId = await startFlow();
    const events = readAuthEvents(flowId, 1);
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(flowId, "c1", {
        kind: "qr",
        title: "Scan this from your phone",
        instructions: "Open the app, then Settings, then Linked devices.",
        data: "pairing-payload",
      }),
    );

    const [event] = await events;

    // The whole point. `id` is what an answer names, and a rename anywhere on
    // this path leaves a client with a challenge it cannot answer.
    expect(event).toMatchObject({
      type: "challenge",
      id: "c1",
      challenge: { kind: "qr", title: "Scan this from your phone", data: "pairing-payload" },
    });
  });

  test("the flow records it, so a client that reconnects is not left blank", async () => {
    const flowId = await startFlow();
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(flowId, "c1", { kind: "code", title: "Paste the code" }),
    );

    // A second subscriber — or the same one after a dropped connection — gets
    // the pending question replayed rather than an awaiting-user flow with
    // nothing on screen.
    const replayed = await readAuthEvents(flowId, 1);
    expect(replayed[0]).toMatchObject({ type: "challenge", id: "c1" });

    const flow = await harness.json<{ state: string; pendingChallenge?: { id: string } }>(
      `/admin/auth-flows/${flowId}`,
    );
    expect(flow.state).toBe("awaiting-user");
    expect(flow.pendingChallenge?.id).toBe("c1");
  });

  test("a notice updates the message and leaves the question alone", async () => {
    const flowId = await startFlow();
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(flowId, "c1", { kind: "fields", title: "Choose your bank", fields: [] }),
    );
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(flowId, "c2", { kind: "wait", title: "Contacting your bank" }),
    );
    // One event, not two: a notice is not stored as the pending question, so
    // there is nothing of it to replay to a subscriber that arrives after it.
    // That is the behaviour under test, seen from the other side.
    const replayed = await readAuthEvents(flowId, 1);
    expect(replayed[0]).toMatchObject({ type: "challenge", id: "c1" });

    const flow = await harness.json<{
      message?: string;
      pendingChallenge?: { id: string };
    }>(`/admin/auth-flows/${flowId}`);

    // Erasing the question would leave the operator holding an answer for a
    // challenge the flow is no longer on, which the answer route then refuses.
    expect(flow.message).toBe("Contacting your bank");
    expect(flow.pendingChallenge?.id).toBe("c1");
  });
});

describe("an answer reaches the collector that asked", () => {
  test.each([
    { kind: "qr", title: "Scan", data: "payload" },
    { kind: "redirect", title: "Connect", url: "https://example.org/connect", via: "elsewhere" },
    { kind: "widget", title: "Choose", renderer: "example", payload: {} },
  ])(
    "generic answers cannot target a shown or dedicated-channel challenge %j",
    async (challenge) => {
      const flowId = await startFlow();
      collector.ws.emitEvent(
        "auth.update",
        challengeEvent(flowId, "c1", challenge, challenge.kind === "widget"),
      );
      const events = await readAuthEvents(flowId, 1);
      expect(events[0]).toMatchObject({ type: "challenge", challenge });
      const before = collector.receivedCommands.length;
      const res = await fetch(`${harness.gatewayUrl}/admin/auth-flows/${flowId}/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.bootstrapToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ challengeId: "c1", answer: { code: "123456" } }),
      });
      expect(res.status).toBe(409);
      expect(
        collector.receivedCommands.slice(before).some((command) => command.type === "auth.answer"),
      ).toBe(false);
    },
  );
  test("addressed by the id the challenge carried", async () => {
    const flowId = await startFlow();
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(flowId, "c7", { kind: "code", title: "Paste the code" }),
    );
    await readAuthEvents(flowId, 1);

    const before = collector.receivedCommands.length;
    await harness.json(`/admin/auth-flows/${flowId}/answer`, {
      method: "POST",
      body: JSON.stringify({ challengeId: "c7", answer: { code: "123456" } }),
    });

    const delivered = collector.receivedCommands
      .slice(before)
      .find((c) => c.type === "auth.answer");
    expect(delivered?.payload).toMatchObject({
      flowId,
      challengeId: "c7",
      answer: { code: "123456" },
    });
  });

  test("an answer to a question the flow is not on is refused", async () => {
    const flowId = await startFlow();
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(flowId, "c1", { kind: "code", title: "Paste the code" }),
    );
    await readAuthEvents(flowId, 1);

    const res = await fetch(`${harness.gatewayUrl}/admin/auth-flows/${flowId}/answer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.bootstrapToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ challengeId: "stale", answer: { code: "1" } }),
    });

    // Accepting it would resolve a wait that belongs to a different question.
    expect(res.status).toBe(409);
  });

  test("a code is refused for a challenge the flow is showing rather than asking", async () => {
    const flowId = await startFlow();
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(
        flowId,
        "c1",
        {
          kind: "redirect",
          via: "loopback",
          title: "Sign in",
          url: "https://example.org/authorize",
        },
        false,
      ),
    );
    await readAuthEvents(flowId, 1);

    const before = collector.receivedCommands.length;
    const res = await fetch(`${harness.gatewayUrl}/admin/auth-flows/${flowId}/code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.bootstrapToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "123456" }),
    });

    // The provider is reading its own callback; nothing is waiting on this
    // channel. Accepting it would latch the flow to `completing` while the code
    // landed in a receiver nobody reads and the provider's listener went on
    // waiting — an operator watching a page that will time out.
    expect(res.status).toBe(409);
    expect(collector.receivedCommands.slice(before).some((c) => c.type === "auth.code")).toBe(
      false,
    );

    const flow = await harness.json<{ state: string }>(`/admin/auth-flows/${flowId}`);
    expect(flow.state).toBe("awaiting-user");
  });

  test("and accepted for one it is asking", async () => {
    const flowId = await startFlow();
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(
        flowId,
        "c1",
        {
          kind: "redirect",
          via: "loopback",
          title: "Sign in",
          url: "https://example.org/authorize",
        },
        true,
      ),
    );
    await readAuthEvents(flowId, 1);

    const before = collector.receivedCommands.length;
    await harness.json(`/admin/auth-flows/${flowId}/code`, {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });

    const delivered = collector.receivedCommands.slice(before).find((c) => c.type === "auth.code");
    expect(delivered?.payload).toMatchObject({ flowId, code: "123456" });
  });

  test("what a flow reports about the credential reaches a client", async () => {
    const flowId = await startFlow();
    const events = readAuthEvents(flowId, 1);
    collector.ws.emitEvent("auth.complete", {
      flowId,
      ok: true,
      accountId: "acct-1",
      accountIds: ["acct-1"],
      accountStates: { "acct-1": { status: "connected", expiresAt: "2027-03-12T00:00:00.000Z" } },
    });

    // Some platforms state how long a grant lasts once, during the exchange,
    // and never again. Dropping it here made the contract's promise that the
    // deadline is not lost untrue.
    const [event] = await events;
    expect(event).toMatchObject({
      type: "complete",
      accountStates: { "acct-1": { status: "connected", expiresAt: "2027-03-12T00:00:00.000Z" } },
    });
  });

  test("something that went wrong without stopping it reaches the client too", async () => {
    const flowId = await startFlow();
    const events = readAuthEvents(flowId, 1);
    collector.ws.emitEvent("auth.complete", {
      flowId,
      ok: true,
      accountId: "acct-1",
      accountIds: ["acct-1"],
      notices: [
        {
          title: "Only the last 90 days of history were captured.",
          detail:
            "The full archive is offered for a few minutes after sign-in. Connect again to retry.",
        },
      ],
    });

    // A flow returns or it throws. Without this there is nowhere to put a step
    // that could only be taken once and was not, on an account that is
    // otherwise connected — and the operator hears only "connected".
    const [event] = await events;
    expect(event).toMatchObject({
      type: "complete",
      ok: true,
      notices: [{ title: "Only the last 90 days of history were captured." }],
    });
  });

  test("a failure carries the sentence saying what to do about it", async () => {
    const flowId = await startFlow();
    const events = readAuthEvents(flowId, 1);
    collector.ws.emitEvent("auth.complete", {
      flowId,
      ok: false,
      error: "Signed in as someone else",
      code: "identity-mismatch",
      remedy: "Sign out in your browser, then try again.",
    });

    const [event] = await events;
    expect(event).toMatchObject({
      type: "complete",
      ok: false,
      code: "identity-mismatch",
      remedy: "Sign out in your browser, then try again.",
    });

    // And a client that arrives after the failure is told the same thing.
    const replayed = await readAuthEvents(flowId, 1);
    expect(replayed[0]).toMatchObject({
      ok: false,
      code: "identity-mismatch",
      remedy: "Sign out in your browser, then try again.",
    });
  });

  test("a completed flow keeps no pairing payload", async () => {
    const flowId = await startFlow();
    collector.ws.emitEvent(
      "auth.update",
      challengeEvent(flowId, "c1", { kind: "qr", title: "Scan this", data: "secret-payload" }),
    );
    await readAuthEvents(flowId, 1);
    collector.ws.emitEvent("auth.complete", { flowId, ok: true, accountId: "someone" });

    await expect
      .poll(async () => {
        const flow = await harness.json<{ state: string }>(`/admin/auth-flows/${flowId}`);
        return flow.state;
      })
      .toBe("completed");

    // The admin listing hands every flow to every caller, so what a flow keeps
    // after it ends is what an unrelated caller can read.
    const flow = await harness.json<{ pendingChallenge?: unknown }>(`/admin/auth-flows/${flowId}`);
    expect(flow.pendingChallenge).toBeUndefined();
  });
});

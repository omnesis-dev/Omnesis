// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DeviceId, Scope, TokenId } from "@omnesis/types";
import { HttpError, errorResponse } from "../http/errors.js";
import { callError } from "./call-error.js";
import { LiveVoiceService } from "./live-service.js";
import { mountLiveVoiceRoutes } from "./live-route.js";
import type { AppEnv } from "../http/routes/types.js";
import type { LiveProvider, LiveProviderCallbacks } from "./live-provider.js";
import type { VoiceAgentSession, VoiceTurnResult } from "../agent/voice-session.js";

const owner = "token:00000000-0000-4000-8000-000000000002";
const token = "fixture-token";
const offer = { sdp: "v=0\r\n", clientSessionId: "00000000-0000-4000-8000-000000000003" };
const services: LiveVoiceService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  vi.useRealTimers();
});

function harness() {
  let authorized = true;
  let agentAvailable = true;
  let backend: string | undefined = "voice-provider";
  let apiKey: string | undefined = "PRIVATE_PROVIDER_KEY";
  let callbacks!: LiveProviderCallbacks;
  const agent: VoiceAgentSession = {
    sessionId: "conversation-fixture",
    model: "owner-selected-model",
    backend: "owner-selected-backend",
    history: [],
    visibleHistory: [],
    subscribe: () => () => {},
    submit: vi.fn(() =>
      Promise.resolve({
        messageId: "answer-one",
        text: "The lookup found two appointments.",
        stopReason: "end_turn" as const,
      }),
    ),
    cancel: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const send = vi.fn();
  const close = vi.fn(() => Promise.resolve({ usageConfirmed: true, seconds: 45 }));
  const provider: LiveProvider = {
    create: vi.fn((_input, hooks) => {
      callbacks = hooks;
      return Promise.resolve({ id: "PRIVATE_PROVIDER_ID", sdp: "v=0\r\nanswer", send, close });
    }),
  };
  const openVoiceSession = vi.fn(() => Promise.resolve(agent));
  const recordUsage = vi.fn(() => Promise.resolve());
  const agentService = { openVoiceSession };
  const service: LiveVoiceService = new LiveVoiceService({
    backend: () => backend,
    getApiKey: () => apiKey,
    getAgent: () => (agentAvailable ? agentService : undefined),
    isAuthorized: (candidate, caller) => authorized && candidate === token && caller === owner,
    hasCapacity: () => service.activeCount < 4,
    provider: () => provider,
    recordUsage,
    warn: vi.fn(),
  });
  services.push(service);
  return {
    service,
    agent,
    provider,
    openVoiceSession,
    recordUsage,
    send,
    close,
    events: () => callbacks,
    setBackend: (value: string | undefined) => {
      backend = value;
    },
    setApiKey: (value: string | undefined) => {
      apiKey = value;
    },
    disableAgent: () => {
      agentAvailable = false;
    },
    revoke: () => {
      authorized = false;
    },
  };
}
async function drain() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("Live configured-agent lifecycle", () => {
  it("shares concurrent creation retries and preserves configured model identity", async () => {
    const h = harness();
    const first = h.service.create(owner, token, offer);
    const duplicate = h.service.create(owner, token, offer);
    expect(first).toBe(duplicate);
    const answer = await first;
    expect(answer).toMatchObject({
      model: "owner-selected-model",
      backend: "owner-selected-backend",
      voice: { model: "gpt-live-1" },
    });
    expect(h.openVoiceSession).toHaveBeenCalledExactlyOnceWith(
      owner,
      expect.objectContaining({ authorized: expect.any(Function) }),
    );
    expect(h.service.capability()).toMatchObject({
      version: 1,
      protocol: { min: 1, max: 1 },
      transport: "webrtc",
      configuredAgent: true,
    });
    expect(h.provider.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(answer)).not.toContain("PRIVATE_PROVIDER_ID");
    expect(JSON.stringify(answer)).not.toContain("PRIVATE_PROVIDER_KEY");
    expect(() => h.service.create(owner, token, { ...offer, sdp: "different" })).toThrow();
    await h.service.end(owner, token, answer.id);
    expect(() => h.service.create(owner, token, offer)).toThrow();
  });

  it("never executes research before canonical/media readiness, and never installs tools in voice", async () => {
    const h = harness();
    const answer = await h.service.create(owner, token, offer);
    h.events().onEvent({
      type: "session.delegation.created",
      delegation: { id: "request-one", target: "client" },
      offset_ms: 1000,
    });
    h.events().onEvent({
      type: "session.input_transcript.delta",
      event_id: "text-one",
      delta: "Find today's appointments.",
      start_ms: 0,
      end_ms: 900,
    });
    await drain();
    expect(h.agent.submit).not.toHaveBeenCalled();
    h.service.ready(owner, token, answer.id);
    await drain();
    expect(h.agent.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Find today's appointments." }),
    );
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.commentary.append",
        content: "The lookup found two appointments.",
      }),
    );
    expect(vi.mocked(h.provider.create).mock.calls[0]![0]).not.toHaveProperty("tools");
  });

  it("pushes fatal gateway state even while the direct media peer remains connected", async () => {
    const h = harness();
    const answer = await h.service.create(owner, token, offer);
    const states: unknown[] = [];
    const unsubscribe = h.service.subscribe(owner, token, answer.id, (state) => states.push(state));
    h.service.ready(owner, token, answer.id);
    h.events().onFailure(callError("project_spend_limit_exceeded"));
    expect(states).toContainEqual(
      expect.objectContaining({
        status: "ending",
        failure: expect.objectContaining({ code: "project_spend_limit_exceeded" }),
      }),
    );
    await h.service.end(owner, token, answer.id);
    expect(states).toContainEqual(expect.objectContaining({ status: "failed" }));
    expect(h.agent.cancel).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("revokes media and explicitly cancels owned work when the bearer is revoked", async () => {
    vi.useFakeTimers();
    const h = harness();
    const answer = await h.service.create(owner, token, offer);
    const states: unknown[] = [];
    h.service.subscribe(owner, token, answer.id, (state) => states.push(state));
    h.service.ready(owner, token, answer.id);
    h.revoke();
    await vi.advanceTimersByTimeAsync(5001);
    expect(h.agent.cancel).toHaveBeenCalledTimes(1);
    expect(states).toContainEqual(
      expect.objectContaining({ failure: expect.objectContaining({ code: "pairing_rejected" }) }),
    );
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("closes unanswered offers and keeps final cumulative seconds distinct from token spend", async () => {
    vi.useFakeTimers();
    const h = harness();
    const answer = await h.service.create(owner, token, offer);
    h.events().onEvent({ type: "session.usage.updated", usage: { seconds: 31 } });
    h.events().onEvent({ type: "session.usage.updated", usage: { seconds: 32 } });
    expect(h.recordUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(h.service.status(owner, token, answer.id)).toMatchObject({
      status: "failed",
      usage: { seconds: 45, confirmed: true },
      failure: { code: "timeout" },
    });
    expect(h.recordUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callId: answer.id,
        seconds: 45,
        confirmed: true,
        model: "gpt-live-1",
      }),
    );
    expect(h.agent.cancel).not.toHaveBeenCalled();
  });

  it("detaches accepted work without holding the end acknowledgment behind background accounting", async () => {
    const h = harness();
    h.recordUsage.mockImplementation(() => new Promise<void>(() => {}));
    const answer = await h.service.create(owner, token, offer);
    h.service.ready(owner, token, answer.id);
    expect(await h.service.end(owner, token, answer.id)).toEqual({
      ended: true,
      usageConfirmed: true,
    });
    expect(h.agent.close).toHaveBeenCalledTimes(1);
    expect(h.agent.cancel).not.toHaveBeenCalled();
    expect(h.recordUsage).toHaveBeenCalled();
  });

  it("checks fresh authority before disclosing an answer, without waiting for its poll interval", async () => {
    const h = harness();
    let finish!: (value: { messageId: string; text: string; stopReason: "end_turn" }) => void;
    h.agent.submit = vi.fn(
      () =>
        new Promise<VoiceTurnResult>((resolve) => {
          finish = resolve;
        }),
    );
    const answer = await h.service.create(owner, token, offer);
    const statuses: unknown[] = [];
    h.service.subscribe(owner, token, answer.id, (status) => statuses.push(status));
    h.service.ready(owner, token, answer.id);
    h.events().onEvent({
      type: "session.input_transcript.delta",
      event_id: "caller",
      delta: "Check the schedule.",
      start_ms: 0,
      end_ms: 800,
    });
    h.events().onEvent({
      type: "session.delegation.created",
      delegation: { id: "lookup", target: "client" },
      offset_ms: 1000,
    });
    await drain();
    h.revoke();
    finish({ messageId: "answer", text: "PRIVATE_RESULT", stopReason: "end_turn" });
    await drain();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.agent.cancel).toHaveBeenCalledTimes(1);
    expect(statuses).toContainEqual(
      expect.objectContaining({ failure: expect.objectContaining({ code: "pairing_rejected" }) }),
    );
  });

  it("ends a stale configured-agent lease with an availability error", async () => {
    vi.useFakeTimers();
    const h = harness();
    const answer = await h.service.create(owner, token, offer);
    h.service.ready(owner, token, answer.id);
    h.disableAgent();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.service.status(owner, token, answer.id)).toMatchObject({
      status: "failed",
      failure: { code: "unavailable" },
    });
    expect(h.agent.cancel).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it.each(["unassign", "reassign", "remove-key", "rotate-key"])(
    "ends a Live call when its selected speech assignment loses authority: %s",
    async (change) => {
      vi.useFakeTimers();
      const h = harness();
      const answer = await h.service.create(owner, token, offer);
      h.service.ready(owner, token, answer.id);
      if (change === "unassign") h.setBackend(undefined);
      if (change === "reassign") h.setBackend("other-voice-provider");
      if (change === "remove-key") h.setApiKey(undefined);
      if (change === "rotate-key") h.setApiKey("replacement-key");
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.service.status(owner, token, answer.id)).toMatchObject({
        status: "failed",
        failure: { code: "unavailable" },
      });
      expect(h.agent.cancel).toHaveBeenCalledTimes(1);
      expect(h.close).toHaveBeenCalledTimes(1);
    },
  );

  it("makes teardown idempotent even when observers synchronously reenter it", async () => {
    const h = harness();
    const answer = await h.service.create(owner, token, offer);
    h.service.subscribe(owner, token, answer.id, (status) => {
      if (status.status === "ending") {
        void h.service.end(owner, token, answer.id);
        throw new Error("broken observer");
      }
    });
    expect(await h.service.end(owner, token, answer.id)).toEqual({
      ended: true,
      usageConfirmed: true,
    });
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.agent.close).toHaveBeenCalledTimes(1);
  });

  it("retries a transient idempotent duration write without delaying media detachment", async () => {
    const h = harness();
    h.recordUsage.mockRejectedValueOnce(new Error("temporary writer failure"));
    const answer = await h.service.create(owner, token, offer);
    await h.service.end(owner, token, answer.id);
    await drain();
    expect(h.recordUsage).toHaveBeenCalledTimes(2);
    expect(h.recordUsage.mock.calls[0]).toEqual(h.recordUsage.mock.calls[1]);
  });
});

describe("Live signaling authority", () => {
  function appFixture(admin = true) {
    const h = harness();
    const app = new Hono<AppEnv>();
    app.onError((error, c) =>
      error instanceof HttpError ? errorResponse(c, error) : c.json({ error: "unexpected" }, 500),
    );
    app.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "bearer",
        tokenId: TokenId("00000000-0000-4000-8000-000000000002"),
        deviceId: DeviceId("00000000-0000-4000-8000-000000000001"),
        scopes: [Scope(admin ? "admin" : "read")],
      });
      await next();
    });
    mountLiveVoiceRoutes(app, h.service);
    return { ...h, app };
  }

  it("rejects unauthorized signaling, invalid offers and invalid call identifiers", async () => {
    const h = appFixture(false);
    expect((await h.app.request("/agent/realtime/sessions", { method: "POST" })).status).toBe(403);
    const allowed = appFixture();
    expect(
      (
        await allowed.app.request("/agent/realtime/sessions/not-a-uuid", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    const invalid = await allowed.app.request("/agent/realtime/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...offer, extra: "not accepted" }),
    });
    expect(invalid.status).toBe(400);
    expect(allowed.provider.create).not.toHaveBeenCalled();
  });

  it("reports shutdown as safe service-unavailable signaling before provider allocation", async () => {
    const h = appFixture();
    await h.service.dispose();
    const response = await h.app.request("/agent/realtime/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      failure: { code: "server_shutdown", retryable: true, fatal: true },
    });
    expect(h.openVoiceSession).not.toHaveBeenCalled();
    expect(h.provider.create).not.toHaveBeenCalled();
  });
  it("provides current lifecycle snapshots on the authenticated SSE control plane", async () => {
    const h = appFixture();
    const answer = await h.service.create(owner, token, offer);
    const response = await h.app.request(`/agent/realtime/sessions/${answer.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"status":"connecting"');
    h.service.ready(owner, token, answer.id);
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain('"status":"connected"');
    await reader.cancel();
    await h.service.end(owner, token, answer.id);
  });

  it("rejects excess lifecycle listeners before committing an SSE response", async () => {
    const h = appFixture();
    const answer = await h.service.create(owner, token, offer);
    const subscriptions = Array.from({ length: 4 }, () =>
      h.service.subscribe(owner, token, answer.id, () => {}),
    );
    const response = await h.app.request(`/agent/realtime/sessions/${answer.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(409);
    for (const unsubscribe of subscriptions) unsubscribe();
  });
});

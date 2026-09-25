// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal view helpers.
import { describe, expect, it, vi } from "vitest";

import {
  activatePendingSession,
  agentComposerDisabled,
  loadPersistedConversation,
  resumedConversationAction,
  scheduleReplayGapReconcile,
  subscribeToSessionEvents,
  dispatchSessionReplay,
} from "./agent.js";

describe("portal agent offline conversation flow", () => {
  it("loads saved history without creating an inference session", async () => {
    const client = {
      listConversationMessages: vi.fn(async () => ({ messages: [] })),
      createSession: vi.fn(),
    };

    await loadPersistedConversation(client, "saved-conversation");

    expect(client.listConversationMessages).toHaveBeenCalledWith("saved-conversation", {
      limit: 25,
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("resumes lazily on send and preserves a recovered backend path", async () => {
    const client = {
      createSession: vi.fn(async () => ({ sessionId: "saved-conversation" })),
    };

    await expect(
      activatePendingSession(client, { resumeFromId: "saved-conversation" }),
    ).resolves.toMatchObject({ sessionId: "saved-conversation" });
    expect(client.createSession).toHaveBeenCalledWith({
      resumeFromId: "saved-conversation",
      transcriptLimit: 25,
    });
  });

  it("surfaces the backend failure only when the pending session is activated", async () => {
    const failure = Object.assign(new Error("Backend probe failed."), { status: 503 });
    const client = { createSession: vi.fn(async () => Promise.reject(failure)) };

    await expect(activatePendingSession(client, {})).rejects.toMatchObject({
      status: 503,
      message: "Backend probe failed.",
    });
  });

  it("keeps the fresh composer enabled for a disabled backend", () => {
    expect(agentComposerDisabled(null, { enabled: false })).toBe(false);
    expect(agentComposerDisabled(null, { enabled: true })).toBe(true);
  });

  it("reconciles the authoritative resume snapshot before a recovered send", () => {
    expect(
      resumedConversationAction({
        sessionId: "saved-conversation",
        model: "fictional-model",
        backend: "replay",
        messages: [{ role: "user", parts: [] }],
        messageCount: 3,
        busy: false,
        messagesAreVisible: true,
        messagePageInfo: { hasMore: true, nextCursor: "older" },
      }),
    ).toMatchObject({
      kind: "load-conversation",
      sessionId: "saved-conversation",
      messageCount: 3,
      messages: [{ role: "user" }],
      messagePageInfo: { nextCursor: "older" },
    });
  });

  it("attaches every resume path with the snapshot event cursor", () => {
    const off = vi.fn();
    const client = { onEvent: vi.fn(() => off) };
    const onEvent = vi.fn();
    const onGap = vi.fn();

    expect(subscribeToSessionEvents(client, "saved-conversation", 42, onEvent, onGap)).toBe(off);
    expect(client.onEvent).toHaveBeenCalledWith(
      "saved-conversation",
      onEvent,
      { afterEventId: 42, onGap },
    );
    client.onEvent.mock.calls[0][2].onGap();
    expect(onGap).toHaveBeenCalledOnce();
  });

  it("dispatches every server-projected active-turn replay event", () => {
    const dispatch = vi.fn();
    dispatchSessionReplay(dispatch, [
      { type: "agent.tool.result", payload: { result: { kind: "plan.updated" } } },
      { type: "agent.tool.child.result", payload: { childIndex: 0 } },
      { type: "agent.subagent.spawned", payload: { subagentId: "sub-1" } },
    ]);

    expect(dispatch.mock.calls.map(([action]) => action.kind)).toEqual([
      "agent.tool.result",
      "agent.tool.child.result",
      "agent.subagent.spawned",
    ]);
  });

  it("coalesces replay gaps into an active-session resnapshot", () => {
    const pending = new Set<string>();
    const scheduled: Array<() => void> = [];
    const reconcile = vi.fn();

    scheduleReplayGapReconcile(
      pending,
      "saved-conversation",
      () => "saved-conversation",
      reconcile,
      (fn) => scheduled.push(fn),
    );
    scheduleReplayGapReconcile(
      pending,
      "saved-conversation",
      () => "saved-conversation",
      reconcile,
      (fn) => scheduled.push(fn),
    );

    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith("saved-conversation");
  });
});

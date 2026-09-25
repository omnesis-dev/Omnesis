// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Notifying the operator that a conversation has something new in it.
 *
 * Two properties carry this file. One banner per unread episode, however many
 * messages the agent writes into it — the operator is told a conversation has
 * news, not told once per sentence. And content whose producer already
 * announced it opens the episode without ringing: a watch firing pushes its
 * own notification and then has the agent open a thread about the same event,
 * and two banners for one event is the phone telling them twice.
 *
 * The second property is declared on the thread-creation path, not inferred
 * here from what the conversation looks like, so these tests drive it through
 * `openWatchFiringThread` rather than asserting the shape of a branch.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReplayBackend, type DocumentPort, type SearchPort } from "@omnesis/agent";

import { directWriteGate } from "../write-gate.js";
import { AgentService } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import { createConversationReadStateTables } from "./conversation-read-state.js";
import { ConversationReadStateService } from "./conversation-read-state-service.js";
import { clipNotificationBody, conversationCollapseId } from "./conversation-notifier.js";
import type { ConversationNotification } from "./conversation-notifier.js";
import type { Db } from "../data/types.js";
import type { AgentEvent } from "@omnesis/core";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

const tempDirs: string[] = [];
const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const db of openDbs.splice(0)) db.close();
});

function textDelta(delta: string): AgentEvent {
  return {
    type: "agent.text.delta",
    payload: { sessionId: "S", messageId: "M", delta },
  } as AgentEvent;
}

function messageEnd(stopReason: string): AgentEvent {
  return {
    type: "agent.message.end",
    payload: { sessionId: "S", messageId: "M", stopReason },
  } as AgentEvent;
}

const FIRING = {
  firingId: "sfiring_permit_decision",
  watchId: "sub_permit_decision",
  watchName: "Permit decisions",
  condition: "the planning office decides on the workshop permit",
  firedAt: Date.parse("2026-05-04T09:15:00.000Z"),
  evidenceDocumentIds: ["doc_permit_letter"],
};

const ANSWER = "The planning office approved the workshop permit, effective the 1st.";
const FOLLOW_UP = "One more thing: the fee is due Friday.";

function makeService(
  turns: AgentEvent[][],
  sessionIds: string[] = ["S_chat"],
  opts: { withSlowAnswerPush?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-notify-"));
  tempDirs.push(dir);
  const db = new Database(":memory:");
  openDbs.push(db);
  createConversationReadStateTables(db);
  const readState = new ConversationReadStateService({
    db,
    writer: directWriteGate(db as unknown as Db),
  });
  const notifications: ConversationNotification[] = [];
  const slowAnswerPushes: string[] = [];
  const persistWaiters = new Map<string, Array<() => void>>();
  const waitForPersist = (id: string) =>
    new Promise<void>((resolve) => {
      const waiting = persistWaiters.get(id) ?? [];
      waiting.push(resolve);
      persistWaiters.set(id, waiting);
    });
  let nextId = 0;
  const backend = new ReplayBackend({
    fixtures: turns.map((events) => ({
      entries: events.map((event) => ({ afterMs: 0, event })),
    })),
  });
  const service = new AgentService({
    backendFactory: () => backend,
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    sessionIdGen: () => sessionIds[nextId++] ?? `S_extra_${nextId}`,
    idleTimeoutMs: 60_000,
    store: new FsConversationStore(dir),
    readState,
    notifyConversation: (notification) => {
      notifications.push(notification);
    },
    ...(opts.withSlowAnswerPush
      ? {
          notifyAnswer: (notification: { conversationId: string }) => {
            slowAnswerPushes.push(notification.conversationId);
          },
        }
      : {}),
    onTurnComplete: (sessionId) => {
      for (const resolve of persistWaiters.get(sessionId) ?? []) resolve();
      persistWaiters.delete(sessionId);
    },
  });
  return { service, readState, notifications, slowAnswerPushes, waitForPersist };
}

async function chatTurn(
  service: AgentService,
  waitForPersist: (id: string) => Promise<void>,
  text: string,
): Promise<string> {
  const created = await service.createSession("token:operator");
  const persisted = waitForPersist(created.sessionId);
  service.sendMessage("token:operator", created.sessionId, text);
  await persisted;
  return created.sessionId;
}

describe("a turn nobody was watching", () => {
  it("notifies once, deep-linked to the conversation", async () => {
    const { service, notifications, waitForPersist } = makeService([
      [textDelta(ANSWER), messageEnd("end_turn")],
    ]);
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    expect(notifications).toEqual([
      { conversationId: id, title: expect.any(String), body: ANSWER },
    ]);
  });

  it("stays silent for a turn the operator was watching arrive", async () => {
    const { service, readState, notifications, waitForPersist } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_live"],
    );
    await readState.markSeen("S_live", { viewing: true });
    await chatTurn(service, waitForPersist, "Did the permit come through?");
    expect(notifications).toEqual([]);
  });
});

describe("more content while the conversation is already unread", () => {
  it("stays silent until the operator reads it", async () => {
    const { service, readState, notifications, waitForPersist } = makeService(
      [
        [textDelta(ANSWER), messageEnd("end_turn")],
        [textDelta(FOLLOW_UP), messageEnd("end_turn")],
      ],
      ["S_chat"],
    );
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    expect(notifications).toHaveLength(1);

    const resumed = await service.createSession("token:operator", { resumeFromId: id });
    const persisted = waitForPersist(resumed.sessionId);
    service.sendMessage("token:operator", resumed.sessionId, "And the fee?");
    await persisted;

    // The operator already knows this conversation has news; saying so again
    // is the phone repeating itself.
    expect(notifications).toHaveLength(1);
    expect(readState.unreadAmong([id])).toEqual(new Set([id]));
  });

  it("notifies again once the conversation has been read", async () => {
    const { service, readState, notifications, waitForPersist } = makeService(
      [
        [textDelta(ANSWER), messageEnd("end_turn")],
        [textDelta(FOLLOW_UP), messageEnd("end_turn")],
      ],
      ["S_chat"],
    );
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    await readState.markSeen(id, { viewing: false });

    const resumed = await service.createSession("token:operator", { resumeFromId: id });
    const persisted = waitForPersist(resumed.sessionId);
    service.sendMessage("token:operator", resumed.sessionId, "And the fee?");
    await persisted;

    expect(notifications).toHaveLength(2);
    expect(notifications[1]?.body).toBe(FOLLOW_UP);
  });
});

describe("a turn that already owes the caller its own push", () => {
  it("stays silent, leaving the slow-answer push to speak", async () => {
    const { service, readState, notifications, waitForPersist } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_chat"],
      { withSlowAnswerPush: true },
    );
    const created = await service.createSession("token:operator");
    const persisted = waitForPersist(created.sessionId);
    // `notifyAfterMs` promises the caller a push carrying this answer, and both
    // pushes collapse onto the same banner — so only the promised one is sent.
    service.sendMessage("token:operator", created.sessionId, "Did the permit come through?", {
      notifyAfterMs: 1_000,
    });
    await persisted;

    expect(notifications).toEqual([]);
    // Still unread: the operator has not seen it, whichever push told them.
    expect(readState.unreadAmong([created.sessionId])).toEqual(new Set([created.sessionId]));
  });
});

describe("a thread whose producer already notified", () => {
  it("shows the dot but never rings", async () => {
    const { service, readState, notifications } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_watch"],
    );
    const result = await service.openWatchFiringThread("device:test", FIRING);
    // The firing pushed its own notification carrying this same message.
    expect(notifications).toEqual([]);
    expect(readState.unreadAmong([result.conversationId])).toEqual(
      new Set([result.conversationId]),
    );
  });

  it("notifies for a reply typed in that same thread", async () => {
    const { service, readState, notifications } = makeService(
      [
        [textDelta(ANSWER), messageEnd("end_turn")],
        [textDelta(FOLLOW_UP), messageEnd("end_turn")],
      ],
      ["S_watch"],
    );
    const result = await service.openWatchFiringThread("device:test", FIRING);
    expect(notifications).toEqual([]);
    await readState.markSeen(result.conversationId, { viewing: false });

    // The declaration covers the opening turn only: an answer to something the
    // operator asked here is ordinary content.
    const resumed = await service.createSession("token:operator", {
      resumeFromId: result.conversationId,
    });
    service.sendMessage("token:operator", resumed.sessionId, "What are the conditions?");
    // An origin-anchored thread never writes back into the corpus, so it does
    // not fire the turn-complete hook the other tests wait on. Wait on the
    // thing under test instead.
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.body).toBe(FOLLOW_UP);
  });
});

describe("banner copy", () => {
  it("collapses one conversation onto itself rather than stacking", () => {
    expect(conversationCollapseId("conv-a")).toBe("agent-answer:conv-a");
  });

  it("passes short prose through untouched", () => {
    expect(clipNotificationBody("  The permit was   approved. ")).toBe("The permit was approved.");
  });

  it("clips long prose to banner length and marks the cut", () => {
    const clipped = clipNotificationBody("word ".repeat(200));
    expect(clipped.length).toBeLessThanOrEqual(175);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("cuts mid-word rather than losing most of the banner to one long token", () => {
    const clipped = clipNotificationBody("x".repeat(400));
    expect(clipped.length).toBe(175);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

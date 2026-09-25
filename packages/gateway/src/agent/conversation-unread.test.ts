// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unread conversations, end to end through the agent service.
 *
 * The property under test is that "the agent said something the operator has
 * not seen" is decided at the one place every turn is persisted, and therefore
 * holds for conversations the operator never started. A thread the agent
 * opened for itself when a watch fired is the case that matters: nothing in
 * this file's expectations is watch-aware, and nothing in the code path that
 * satisfies them is either.
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

function makeService(turns: AgentEvent[][], sessionIds: string[] = ["S_chat"]) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-unread-"));
  tempDirs.push(dir);
  const db = new Database(":memory:");
  openDbs.push(db);
  createConversationReadStateTables(db);
  let clock = 1_000;
  const readState = new ConversationReadStateService({
    db,
    writer: directWriteGate(db as never),
    now: () => clock,
  });
  let nextId = 0;
  // `onTurnComplete` fires once `persistConversation` has resolved, which is
  // the moment read state has been updated — so it is the barrier the
  // assertions wait on rather than a fixed number of event-loop ticks.
  const persistWaiters = new Map<string, Array<() => void>>();
  const waitForPersist = (id: string) =>
    new Promise<void>((resolve) => {
      const waiting = persistWaiters.get(id) ?? [];
      waiting.push(resolve);
      persistWaiters.set(id, waiting);
    });
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
    onTurnComplete: (sessionId) => {
      for (const resolve of persistWaiters.get(sessionId) ?? []) resolve();
      persistWaiters.delete(sessionId);
    },
  });
  return { service, readState, waitForPersist, advance: (ms: number) => (clock += ms) };
}

/** Run one ordinary chat turn and wait for its transcript to be persisted. */
async function chatTurn(
  service: AgentService,
  waitForPersist: (id: string) => Promise<void>,
  text: string,
): Promise<string> {
  const created = await service.createSession("token:operator");
  // `waitForPersist` is the barrier, not the send: the transcript — and with
  // it the read-state decision — is written after the turn settles.
  const persisted = waitForPersist(created.sessionId);
  service.sendMessage("token:operator", created.sessionId, text);
  await persisted;
  return created.sessionId;
}

describe("a turn the operator was not watching", () => {
  it("leaves the conversation unread", async () => {
    const { service, readState, waitForPersist } = makeService([
      [textDelta(ANSWER), messageEnd("end_turn")],
    ]);
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    expect(readState.unreadAmong([id])).toEqual(new Set([id]));
  });

  it("is cleared by any surface opening the conversation", async () => {
    const { service, readState, waitForPersist } = makeService([
      [textDelta(ANSWER), messageEnd("end_turn")],
    ]);
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    await readState.markSeen(id, { viewing: true });
    expect(readState.unreadAmong([id])).toEqual(new Set());
  });
});

describe("a turn the operator was watching", () => {
  it("leaves nothing unread, because the answer arrived in front of them", async () => {
    const { service, readState, waitForPersist } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_live"],
    );
    // The client says it is rendering the conversation before the turn lands,
    // exactly as a chat surface does when the operator hits send.
    await readState.markSeen("S_live", { viewing: true });
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    expect(id).toBe("S_live");
    expect(readState.unreadAmong([id])).toEqual(new Set());
  });

  it("marks unread again once the client stops rendering it", async () => {
    const { service, readState, waitForPersist } = makeService(
      [
        [textDelta(ANSWER), messageEnd("end_turn")],
        [textDelta("One more thing: the fee is due Friday."), messageEnd("end_turn")],
      ],
      ["S_live"],
    );
    await readState.markSeen("S_live", { viewing: true });
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    expect(readState.unreadAmong([id])).toEqual(new Set());

    await readState.markSeen(id, { viewing: false });
    const resumed = await service.createSession("token:operator", { resumeFromId: id });
    const persisted = waitForPersist(resumed.sessionId);
    service.sendMessage("token:operator", resumed.sessionId, "Anything else?");
    await persisted;
    expect(readState.unreadAmong([id])).toEqual(new Set([id]));
  });
});

describe("a turn presented on a bounded voice surface", () => {
  it("stays read when it settles while the Watch is presenting it", async () => {
    const { service, readState, waitForPersist } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_voice"],
    );
    const created = await service.createSession("token:operator");
    const persisted = waitForPersist(created.sessionId);
    const sent = service.sendMessage(
      "token:operator",
      created.sessionId,
      "Did the permit come through?",
    );
    readState.expectContentViewed(created.sessionId, sent.messageId, 45_000);
    await persisted;
    expect(readState.unreadAmong([created.sessionId])).toEqual(new Set());
  });

  it("becomes unread when the answer outlives the Watch presentation", async () => {
    const { service, readState, waitForPersist, advance } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_voice"],
    );
    const created = await service.createSession("token:operator");
    const persisted = waitForPersist(created.sessionId);
    const sent = service.sendMessage(
      "token:operator",
      created.sessionId,
      "Did the permit come through?",
    );
    readState.expectContentViewed(created.sessionId, sent.messageId, 45_000);
    advance(45_000);
    await persisted;
    expect(readState.unreadAmong([created.sessionId])).toEqual(new Set([created.sessionId]));
  });
});

describe("a turn that produced no answer", () => {
  it("leaves the conversation as it was, with nothing new to read", async () => {
    const { service, readState, waitForPersist } = makeService([[messageEnd("end_turn")]]);
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    // The operator's own unanswered message is not something to notify them
    // about — they wrote it.
    expect(readState.unreadAmong([id])).toEqual(new Set());
  });
});

describe("a turn that failed in a conversation that already has answers", () => {
  it("leaves it read, rather than reviving every past reply as news", async () => {
    const { service, readState, waitForPersist } = makeService(
      [
        [textDelta(ANSWER), messageEnd("end_turn")],
        // A turn that ends without the agent saying anything: a refusal before
        // output, or a failure on the operator's own message.
        [messageEnd("end_turn")],
      ],
      ["S_chat"],
    );
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    await readState.markSeen(id, { viewing: false });
    expect(readState.unreadAmong([id])).toEqual(new Set());

    const resumed = await service.createSession("token:operator", { resumeFromId: id });
    const persisted = waitForPersist(resumed.sessionId);
    service.sendMessage("token:operator", resumed.sessionId, "And the fee?");
    await persisted;

    // Asking whether the agent has *ever* spoken here would answer yes — it
    // answered the first question — and dot a conversation holding nothing new.
    expect(readState.unreadAmong([id])).toEqual(new Set());
  });
});

describe("a thread the agent opened itself", () => {
  it("is unread on arrival, through the same path as any other turn", async () => {
    const { service, readState } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_watch"],
    );
    const result = await service.openWatchFiringThread("device:test", FIRING);
    expect(result.conversationId).toBe("S_watch");
    expect(readState.unreadAmong([result.conversationId])).toEqual(
      new Set([result.conversationId]),
    );
  });

  it("clears like any other conversation once it is opened", async () => {
    const { service, readState } = makeService(
      [[textDelta(ANSWER), messageEnd("end_turn")]],
      ["S_watch"],
    );
    const result = await service.openWatchFiringThread("device:test", FIRING);
    await readState.markSeen(result.conversationId, { viewing: true });
    expect(readState.unreadAmong([result.conversationId])).toEqual(new Set());
  });
});

describe("a conversation retired by retention", () => {
  it("takes its read state with it, in one write for the batch", async () => {
    const { service, readState, waitForPersist } = makeService([
      [textDelta(ANSWER), messageEnd("end_turn")],
      [textDelta(ANSWER), messageEnd("end_turn")],
    ]);
    const first = await chatTurn(service, waitForPersist, "Did the permit come through?");
    const second = await chatTurn(service, waitForPersist, "And the fee?");
    expect(readState.unreadAmong([first, second])).toEqual(new Set([first, second]));

    // Retention runs against transcripts nobody is holding, so let the turns'
    // sessions go before sweeping — the sweep skips anything still live.
    await vi.waitFor(async () => {
      await service.evictSession(first);
      await service.evictSession(second);
    });
    const swept = await vi.waitFor(async () => {
      const result = await service.pruneConversations(Date.now() + 60_000, 10);
      expect(result.deleted).toBe(2);
      return result;
    });
    expect(swept.deleted).toBe(2);
    expect(readState.unreadAmong([first, second])).toEqual(new Set());
  });
});

describe("a deleted conversation", () => {
  it("takes its read state with it", async () => {
    const { service, readState, waitForPersist } = makeService([
      [textDelta(ANSWER), messageEnd("end_turn")],
    ]);
    const id = await chatTurn(service, waitForPersist, "Did the permit come through?");
    expect(readState.unreadAmong([id])).toEqual(new Set([id]));

    // `sendMessage` is fire-and-forget — the public API exposes no settle
    // barrier — and a delete is refused while the turn's bookkeeping is still
    // unwinding. Retry until it is admitted rather than guessing a tick count.
    await vi.waitFor(() => service.deleteConversation(id));
    expect(readState.unreadAmong([id])).toEqual(new Set());
    expect(readState.unreadAmong([id])).toEqual(new Set());
  });
});

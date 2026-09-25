// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent-initiated watch-firing threads: a firing opens a conversation
 * whose first visible message the agent wrote, the operator can reply in
 * it and get an ordinary answer, and an opening turn that fails leaves
 * nothing behind for the caller to fall back from.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReplayBackend, type DocumentPort, type SearchPort } from "@omnesis/agent";

import { AgentService } from "./service.js";
import {
  FsConversationStore,
  usesAnchoredThreadProfile,
  type ConversationStore,
} from "./conversation-store.js";
import { WATCH_FIRING_OPENING_SPEND_MECHANISM } from "./spend-recorder.js";
import {
  buildWatchFiringBriefing,
  watchFiringPushCopy,
  watchFiringThreadTitle,
} from "./watch-firing-thread.js";
import type { AgentError } from "./service.js";
import type { AgentSpendSample } from "./spend-recorder.js";
import type { AgentEvent } from "@omnesis/core";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function toolUse(name: string): AgentEvent {
  return {
    type: "agent.tool.result",
    payload: {
      sessionId: "S",
      messageId: "M",
      toolCallId: "t1",
      name,
      result: { kind: "text", text: "stub tool output" },
    },
  } as AgentEvent;
}

const FIRING = {
  firingId: "sfiring_venue_hold",
  watchId: "sub_venue_hold",
  watchName: "Venue booking confirmations",
  condition: "the events team confirms a booked date for the launch party",
  firedAt: Date.parse("2026-05-04T09:15:00.000Z"),
  evidenceDocumentIds: ["doc_maya_email", "doc_maya_email_attachment"],
};

function textDelta(delta: string): AgentEvent {
  return {
    type: "agent.text.delta",
    payload: { sessionId: "S", messageId: "M", delta },
  } as AgentEvent;
}

function messageEnd(stopReason: string, usage?: Record<string, number>): AgentEvent {
  return {
    type: "agent.message.end",
    payload: { sessionId: "S", messageId: "M", stopReason, ...(usage ? { usage } : {}) },
  } as AgentEvent;
}

/**
 * A service whose backend replays one scripted turn per fixture, with a
 * real on-disk conversation store so persistence can be asserted.
 */
function makeService(turns: AgentEvent[][], sessionIds: string[] = ["S_watch"]) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-watch-thread-"));
  tempDirs.push(dir);
  const samples: AgentSpendSample[] = [];
  let nextId = 0;
  // One backend across sessions, so a resumed thread's turn draws the NEXT
  // fixture rather than replaying the opening one.
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
    recordSpend: (sample) => samples.push(sample),
  });
  return { service, samples, dir };
}

function assistantTextOf(message: { role: string; parts: ReadonlyArray<unknown> }): string {
  return (message.parts as ReadonlyArray<{ kind: string; text?: string }>)
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join("");
}

const OPENING =
  "The events team confirmed the riverside room for the 12th, and the deposit is due Friday.";

describe("the briefing that produces the opening message", () => {
  it("names the condition, the watch and every evidence document", () => {
    const briefing = buildWatchFiringBriefing(FIRING);
    expect(briefing).toContain(FIRING.condition);
    expect(briefing).toContain(FIRING.watchName);
    for (const id of FIRING.evidenceDocumentIds) expect(briefing).toContain(id);
  });

  it("survives a firing with no recorded evidence", () => {
    const briefing = buildWatchFiringBriefing({ ...FIRING, evidenceDocumentIds: [] });
    expect(briefing).toContain("(none recorded)");
  });

  it("forbids ownership and relationship guesses from corpus presence", () => {
    const briefing = buildWatchFiringBriefing(FIRING);
    expect(briefing).toContain("does not make the operator its owner");
    expect(briefing).toContain("State uncertainty instead of guessing");
  });
});

describe("conversation titling", () => {
  it("titles the thread after the watch, so the list stays scannable", () => {
    expect(watchFiringThreadTitle("Venue booking confirmations")).toBe(
      "Venue booking confirmations",
    );
  });

  it("collapses whitespace and truncates to the ordinary chat title cap", () => {
    const title = watchFiringThreadTitle(`${"a".repeat(90)}\n  b`);
    expect(title.length).toBe(70);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to a label rather than an empty title", () => {
    expect(watchFiringThreadTitle("   ")).toBe("Watch fired");
  });
});

describe("notification copy", () => {
  it("uses the agent's actual message as the body, not a template", () => {
    const copy = watchFiringPushCopy(FIRING.watchName, OPENING);
    expect(copy.title).toBe("Venue booking confirmations");
    expect(copy.body).toBe(OPENING);
  });

  it("clips a long message to banner length and marks the cut", () => {
    const copy = watchFiringPushCopy(FIRING.watchName, "x".repeat(400));
    expect(copy.body.length).toBe(175);
    expect(copy.body.endsWith("…")).toBe(true);
  });
});

describe("openWatchFiringThread", () => {
  it("creates a conversation whose first visible message the agent wrote", async () => {
    const { service } = makeService([[textDelta(OPENING), messageEnd("end_turn")]]);
    const result = await service.openWatchFiringThread("device:test", FIRING);

    expect(result.conversationId).toBe("S_watch");
    expect(result.openingMessage).toBe(OPENING);

    const record = await service.loadConversation("S_watch");
    expect(record).not.toBeNull();
    // Index 0 is the hidden briefing; the agent's message follows it and is
    // what `seedMessageCount` leaves visible.
    expect(record!.origin).toMatchObject({
      kind: "watch_firing",
      firingId: FIRING.firingId,
      watchId: FIRING.watchId,
      seedMessageCount: 1,
    });
    const visible = record!.messages.slice(record!.origin!.seedMessageCount!);
    expect(visible[0]!.role).toBe("assistant");
    expect(JSON.stringify(visible[0])).toContain("riverside room");
  });

  it("references the matched evidence in the turn it sends the model", async () => {
    const { service } = makeService([[textDelta(OPENING), messageEnd("end_turn")]]);
    await service.openWatchFiringThread("device:test", FIRING);
    const record = await service.loadConversation("S_watch");
    const briefing = JSON.stringify(record!.messages[0]);
    for (const id of FIRING.evidenceDocumentIds) expect(briefing).toContain(id);
  });

  it("titles the thread after the watch and keeps the anchor snapshot", async () => {
    const { service } = makeService([[textDelta(OPENING), messageEnd("end_turn")]]);
    await service.openWatchFiringThread("device:test", FIRING);
    const record = await service.loadConversation("S_watch");
    expect(record!.title).toBe("Venue booking confirmations");
    expect(record!.origin).toMatchObject({
      watch: { name: FIRING.watchName, condition: FIRING.condition, firedAt: FIRING.firedAt },
    });
  });

  it("attributes the opening turn's spend to its own mechanism", async () => {
    const { service, samples } = makeService([
      [textDelta(OPENING), messageEnd("end_turn", { inputTokens: 800, outputTokens: 60 })],
    ]);
    await service.openWatchFiringThread("device:test", FIRING);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.mechanism).toBe(WATCH_FIRING_OPENING_SPEND_MECHANISM);
    expect(samples[0]!.usage.inputTokens).toBe(800);
  });

  it("runs on the ordinary profile, so the thread is continuable with normal tools", async () => {
    const { service, samples } = makeService(
      [
        [textDelta(OPENING), messageEnd("end_turn", { inputTokens: 900, outputTokens: 40 })],
        [
          textDelta("She also asked about parking."),
          messageEnd("end_turn", { inputTokens: 120, outputTokens: 12 }),
        ],
      ],
      ["S_watch"],
    );
    await service.openWatchFiringThread("device:test", FIRING);

    // No anchored-thread profile is installed on this service. A brief
    // thread would refuse to resume here; a watch thread must not.
    const resumed = await service.createSession("device:test", { resumeFromId: "S_watch" });
    expect(resumed.sessionId).toBe("S_watch");
    service.sendMessage("device:test", resumed.sessionId, "What else did she say?");

    let record = await service.loadConversation("S_watch");
    // Transcript persistence completes just before the turn's spend recorder
    // runs, so wait for both independently observable effects.
    for (let i = 0; i < 200 && ((record?.messages.length ?? 0) < 4 || samples.length < 2); i++) {
      await new Promise((r) => setTimeout(r, 5));
      record = await service.loadConversation("S_watch");
    }
    expect(JSON.stringify(record!.messages)).toContain("parking");
    // The operator's own reply is ordinary interactive chat, not watch spend.
    expect(samples.map((s) => s.mechanism)).toEqual([
      WATCH_FIRING_OPENING_SPEND_MECHANISM,
      "interactive",
    ]);
  });

  it("returns only the final message when the opening turn used tools", async () => {
    // The briefing tells the agent to read the evidence, so a tool round is
    // the DESIGNED path, not an edge case. Any preamble it writes before
    // reaching for a tool must not end up in the message or the banner.
    const { service } = makeService([
      [
        textDelta("Let me pull those up."),
        messageEnd("tool_use"),
        toolUse("fetch"),
        textDelta(OPENING),
        messageEnd("end_turn"),
      ],
    ]);
    const result = await service.openWatchFiringThread("device:test", FIRING);
    expect(result.openingMessage).toBe(OPENING);
    expect(result.openingMessage).not.toContain("Let me pull those up.");

    // ...and the operator opens the thread on that message, not on the
    // preamble or the tool scaffolding that produced it.
    const record = await service.loadConversation("S_watch");
    const visible = record!.messages.slice(record!.origin!.seedMessageCount!);
    expect(visible).toHaveLength(1);
    expect(assistantTextOf(visible[0]!)).toBe(OPENING);
  });

  it("survives a gateway restart: a cold resume runs on the ordinary profile", async () => {
    // The live-session fast path would hide the resume dispatch entirely, so
    // resume from a SECOND service over the same store — the restart case,
    // and the only one that exercises parseOrigin + the profile branch.
    const { service, dir } = makeService([[textDelta(OPENING), messageEnd("end_turn")]]);
    await service.openWatchFiringThread("device:test", FIRING);

    const cold = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          fixtures: [
            {
              entries: [textDelta("She also asked about parking."), messageEnd("end_turn")].map(
                (event) => ({ afterMs: 0, event }),
              ),
            },
          ],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_cold",
      idleTimeoutMs: 60_000,
      store: new FsConversationStore(dir),
    });

    // No anchored-thread profile is installed. A brief thread would refuse
    // to resume here; a watch thread must not.
    const resumed = await cold.createSession("device:test", { resumeFromId: "S_watch" });
    expect(resumed.sessionId).toBe("S_watch");
    expect(resumed.origin).toMatchObject({ kind: "watch_firing" });

    cold.sendMessage("device:test", "S_watch", "What else did she say?");
    let record = await cold.loadConversation("S_watch");
    for (let i = 0; i < 200 && (record?.messages.length ?? 0) < 4; i++) {
      await new Promise((r) => setTimeout(r, 5));
      record = await cold.loadConversation("S_watch");
    }
    expect(JSON.stringify(record!.messages)).toContain("parking");
    // The fixed title survived the operator's reply.
    expect(record!.title).toBe("Venue booking confirmations");
  });

  it("withholds write tools from the unattended opening turn", async () => {
    // The turn reads documents the operator did not author, with nobody
    // watching the stream, so it must not be able to act. Experimental mode
    // is what puts the mutating tools on the interactive table at all, so
    // that is the mode in which the withholding is worth asserting.
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const seen: string[][] = [];
    const dir = mkdtempSync(join(tmpdir(), "omnesis-watch-thread-"));
    tempDirs.push(dir);
    const backend = new ReplayBackend({
      fixtures: [
        [textDelta(OPENING), messageEnd("end_turn")],
        [textDelta("Done."), messageEnd("end_turn")],
      ].map((events) => ({ entries: events.map((event) => ({ afterMs: 0, event })) })),
    });
    const original = backend.runTurn.bind(backend);
    backend.runTurn = ((input: { tools?: { name: string }[] }, signal?: AbortSignal) => {
      seen.push((input.tools ?? []).map((t) => t.name));
      return original(input as never, signal as never);
    }) as typeof backend.runTurn;

    const service = new AgentService({
      backendFactory: () => backend,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_watch",
      idleTimeoutMs: 60_000,
      store: new FsConversationStore(dir),
    });
    await service.openWatchFiringThread("device:test", FIRING);

    // A human resuming the thread gets the ordinary toolset back — the
    // constraint is on the turn nobody is watching, not on the thread.
    await service.createSession("device:test", { resumeFromId: "S_watch" });
    service.sendMessage("device:test", "S_watch", "Change it then.");
    for (let i = 0; i < 200 && seen.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const [unattended, resumed] = seen;
    expect(unattended).toBeDefined();
    expect(resumed).toBeDefined();
    // Every tool the unattended turn kept is one the resumed turn also has:
    // it is a withholding, never a different toolset.
    for (const name of unattended!) expect(resumed).toContain(name);
    // Nothing that writes reaches the unattended turn. This service installs
    // no interactive write profile, so the two lists coincide here; the
    // guarantee this pins is that the unattended list is drawn from the
    // read-only selector, which is what keeps the mutating tools out once a
    // real gateway does install that profile.
    for (const name of unattended!) {
      expect(name).not.toMatch(
        /_create$|_update$|_delete$|_append$|_rewrite$|adjudicate|schedule_/,
      );
    }
  });

  it("persists the compat runId so an older gateway refuses the thread", async () => {
    // Every build detects an origin kind it does not know as "a string kind
    // plus a string runId that parseOrigin rejected", and refuses to resume
    // it. A watch-firing origin without runId would slip that check, and an
    // older gateway would run it as a plain chat — exposing the hidden
    // briefing and re-ingesting the thread into the corpus.
    const { service } = makeService([[textDelta(OPENING), messageEnd("end_turn")]]);
    await service.openWatchFiringThread("device:test", FIRING);
    const record = await service.loadConversation("S_watch");
    const origin = record!.origin as { runId?: string; firingId?: string };
    expect(origin.runId).toBe(FIRING.firingId);
    expect(origin.firingId).toBe(FIRING.firingId);
  });

  it("refuses deletion while the settled opening metadata is still being saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-watch-thread-delete-"));
    tempDirs.push(dir);
    const base = new FsConversationStore(dir);
    let saveCount = 0;
    let markMetadataSave!: () => void;
    let releaseMetadataSave!: () => void;
    const metadataSaving = new Promise<void>((resolve) => {
      markMetadataSave = resolve;
    });
    const metadataSaveGate = new Promise<void>((resolve) => {
      releaseMetadataSave = resolve;
    });
    const store: ConversationStore = {
      save: async (record) => {
        saveCount += 1;
        if (saveCount === 2) {
          markMetadataSave();
          await metadataSaveGate;
        }
        await base.save(record);
      },
      load: (id) => base.load(id),
      list: () => base.list(),
      delete: (id) => base.delete(id),
      setPinned: (id, pinned) => base.setPinned(id, pinned),
    };
    const backend = new ReplayBackend({
      fixtures: [
        {
          entries: [textDelta(OPENING), messageEnd("end_turn")].map((event) => ({
            afterMs: 0,
            event,
          })),
        },
      ],
    });
    const service = new AgentService({
      backendFactory: () => backend,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_watch_delete",
      idleTimeoutMs: 60_000,
      store,
    });

    const opening = service.openWatchFiringThread("device:test", FIRING);
    await metadataSaving;
    await expect(service.deleteConversation("S_watch_delete")).rejects.toMatchObject<AgentError>({
      code: "session_busy",
    });

    releaseMetadataSave();
    await opening;
    await expect(service.deleteConversation("S_watch_delete")).resolves.toBe(true);
    expect(await base.load("S_watch_delete")).toBeNull();
  });

  it("discards the conversation when the opening turn produces no message", async () => {
    const { service } = makeService([[messageEnd("error")]]);
    await expect(service.openWatchFiringThread("device:test", FIRING)).rejects.toThrow(
      /produced no message/,
    );
    // Nothing half-written is left in the operator's list to fall back from.
    expect(await service.loadConversation("S_watch")).toBeNull();
  });

  it("discards the conversation when the turn is cancelled rather than ended", async () => {
    const { service } = makeService([[textDelta("half a thought"), messageEnd("canceled")]]);
    await expect(service.openWatchFiringThread("device:test", FIRING)).rejects.toThrow(
      /produced no message/,
    );
    expect(await service.loadConversation("S_watch")).toBeNull();
  });
});

describe("findWatchFiringThread", () => {
  it("finds the thread a firing already opened, and its opening message", async () => {
    const { service } = makeService([[textDelta(OPENING), messageEnd("end_turn")]]);
    await service.openWatchFiringThread("device:test", FIRING);

    expect(await service.findWatchFiringThread(FIRING.firingId)).toEqual({
      conversationId: "S_watch",
      openingMessage: OPENING,
    });
  });

  it("still returns the opening message after the operator has replied", async () => {
    // A redelivery lands after the operator answered. The notification is
    // still about the firing, so it must quote the message the firing
    // produced — not the newest thing in the thread.
    const { service } = makeService([
      [textDelta(OPENING), messageEnd("end_turn")],
      [textDelta("Booked — I put the deposit on Thursday."), messageEnd("end_turn")],
    ]);
    await service.openWatchFiringThread("device:test", FIRING);
    service.sendMessage("device:test", "S_watch", "Can you confirm the deposit?");
    for (let i = 0; i < 200; i++) {
      const record = await service.loadConversation("S_watch");
      if ((record?.messages.length ?? 0) >= 4) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    const found = await service.findWatchFiringThread(FIRING.firingId);
    expect(found).toEqual({ conversationId: "S_watch", openingMessage: OPENING });
  });

  it("is null for a firing that never opened one", async () => {
    const { service } = makeService([[textDelta(OPENING), messageEnd("end_turn")]]);
    await service.openWatchFiringThread("device:test", FIRING);
    expect(await service.findWatchFiringThread("sfiring_never_happened")).toBeNull();
  });
});

describe("origin classification", () => {
  it("keeps a watch-firing thread off the Briefs anchored-thread profile", () => {
    expect(
      usesAnchoredThreadProfile({
        kind: "watch_firing",
        firingId: FIRING.firingId,
        watchId: FIRING.watchId,
      }),
    ).toBe(false);
  });

  it("leaves the brief origin on it", () => {
    expect(usesAnchoredThreadProfile({ kind: "brief", briefId: "b1", runId: "r1" })).toBe(true);
  });
});

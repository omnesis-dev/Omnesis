// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentService,
  composeAgentPromptForProfile,
  type AgentAnswerNotification,
  type AgentPromptProfile,
} from "./service.js";
import { FsConversationStore, type ConversationStore } from "./conversation-store.js";
import type { ChatBackend, DocumentPort, SearchPort, TurnInput } from "@omnesis/agent";
import type { AgentEvent } from "@omnesis/core";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Records every TurnInput so tests can inspect the effective system prompt. */
class RecordingBackend implements ChatBackend {
  readonly name = "recording";
  readonly model = "recording";
  readonly turns: TurnInput[] = [];

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.turns.push(input);
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "ok" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/**
 * Streams a fixed answer after `delayMs`, then ends the turn. `text: null`
 * ends without any delta; `stopReason` defaults to a clean end.
 */
class SlowBackend implements ChatBackend {
  readonly name = "slow";
  readonly model = "slow";

  constructor(
    private readonly delayMs: number,
    private readonly text: string | null = "The meeting is at noon tomorrow.",
    private readonly stopReason: "end_turn" | "max_tokens" = "end_turn",
  ) {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    await sleep(this.delayMs);
    if (this.text !== null) {
      yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: this.text } };
    }
    yield {
      type: "agent.message.end",
      payload: { sessionId, messageId, stopReason: this.stopReason },
    };
  }
}

/**
 * Records every TurnInput like RecordingBackend, but the FIRST turn blocks
 * until `open()` is called — for tests that need a genuinely busy session.
 */
class GatedRecordingBackend implements ChatBackend {
  readonly name = "gated-recording";
  readonly model = "gated-recording";
  readonly turns: TurnInput[] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  open(): void {
    this.release();
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.turns.push(input);
    const { sessionId, messageId } = input;
    if (this.turns.length === 1) await this.gate;
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "ok" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** Fails the turn after `delayMs` without emitting any terminal event. */
class SlowFailingBackend implements ChatBackend {
  readonly name = "slow-failing";
  readonly model = "slow-failing";

  constructor(private readonly delayMs: number) {}

  // eslint-disable-next-line require-yield
  async *runTurn(_input: TurnInput): AsyncIterable<AgentEvent> {
    await sleep(this.delayMs);
    throw new Error("model unavailable");
  }
}

/** Blocks until the turn's abort signal fires, then exits without events. */
class CancelableBackend implements ChatBackend {
  readonly name = "cancelable";
  readonly model = "cancelable";

  async *runTurn(_input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return;
    yield undefined as never;
  }
}

function makeService(
  backend: ChatBackend,
  extra: {
    systemPrompt?: (profile: AgentPromptProfile) => string;
    notifyAnswer?: (notification: AgentAnswerNotification) => void | Promise<void>;
    store?: ConversationStore;
  } = {},
): AgentService {
  let n = 0;
  return new AgentService({
    backendFactory: () => backend,
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: extra.systemPrompt ?? "test",
    notifyAnswer: extra.notifyAnswer,
    store: extra.store,
    sessionIdGen: () => `S_voice_${++n}`,
    idleTimeoutMs: 60_000,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

describe("voice prompt profile", () => {
  it("appends a voice-only fragment without changing the interactive base", () => {
    const base = "invented base prompt";
    expect(composeAgentPromptForProfile(base, "interactive")).toBe(base);
    const voice = composeAgentPromptForProfile(base, "voice");
    expect(voice.startsWith(base)).toBe(true);
    expect(voice.length).toBeGreaterThan(base.length);
  });

  it("resolves the system prompt with the voice profile", async () => {
    const backend = new RecordingBackend();
    const profiles: AgentPromptProfile[] = [];
    const service = makeService(backend, {
      systemPrompt: (profile) => {
        profiles.push(profile);
        return `base prompt for ${profile}`;
      },
    });

    const created = await service.createSession("device:A", { profile: "voice" });
    service.sendMessage("device:A", created.sessionId, "when is the meeting?");
    await settle();

    expect(profiles).toEqual(["voice"]);
    const prompt = backend.turns[0]?.systemPrompt ?? "";
    expect(prompt).toContain("base prompt for voice");
    await service.dispose();
  });

  it("uses the interactive profile by default", async () => {
    const backend = new RecordingBackend();
    const profiles: AgentPromptProfile[] = [];
    const service = makeService(backend, {
      systemPrompt: (profile) => {
        profiles.push(profile);
        return `base prompt for ${profile}`;
      },
    });

    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hello");
    await settle();

    expect(profiles).toEqual(["interactive"]);
    expect(backend.turns[0]?.systemPrompt).toContain("base prompt for interactive");
    await service.dispose();
  });
});

describe("voice toolset", () => {
  /**
   * A spoken answer is never rendered, so the Timeline the citation tools
   * populate has no viewer — and each of their calls costs a model round the
   * user waits through. They must not be offered on the voice surface.
   */
  it("withholds the citation tools from a voice turn but keeps retrieval", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend);
    const created = await service.createSession("device:A", { profile: "voice" });
    await service.sendMessage("device:A", created.sessionId, "when do I check out");
    await settle();

    const names = (backend.turns.at(-1)?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("annotate_many");
    expect(names).not.toContain("cite_record");
    // The tools that actually answer the question are untouched.
    expect(names).toContain("search_many");
    expect(names).toContain("fetch_many");
    await service.dispose();
  });

  it("an interactive turn still gets the citation tools", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend);
    const created = await service.createSession("device:A");
    await service.sendMessage("device:A", created.sessionId, "when do I check out");
    await settle();

    const names = (backend.turns.at(-1)?.tools ?? []).map((t) => t.name);
    expect(names).toContain("annotate_many");
    await service.dispose();
  });

  /** A session switched onto the voice prompt must also lose the tools. */
  it("resuming onto the voice profile drops the citation tools too", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend);
    const created = await service.createSession("device:A");
    await service.createSession("device:A", {
      resumeFromId: created.sessionId,
      profile: "voice",
    });
    await service.sendMessage("device:A", created.sessionId, "and the train");
    await settle();

    const names = (backend.turns.at(-1)?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("annotate_many");
    await service.dispose();
  });

  /**
   * The reverse swap matters just as much: a voice thread tapped open in the
   * app becomes an interactive session, which does render a Timeline and must
   * get its citation tools back.
   */
  it("swapping a voice session back to interactive restores the citation tools", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend);
    const created = await service.createSession("device:A", { profile: "voice" });
    await service.createSession("device:A", {
      resumeFromId: created.sessionId,
      profile: "interactive",
    });
    await service.sendMessage("device:A", created.sessionId, "show me the sources");
    await settle();

    const names = (backend.turns.at(-1)?.tools ?? []).map((t) => t.name);
    expect(names).toContain("annotate_many");
    await service.dispose();
  });
});

describe("prompt profile on resume", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("live resume keeps the voice profile when none is requested and switches on an explicit interactive", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend, {
      systemPrompt: (profile) => `base prompt for ${profile}`,
    });

    const created = await service.createSession("device:A", { profile: "voice" });
    service.sendMessage("device:A", created.sessionId, "when is the meeting?");
    await settle();

    // No profile on resume — the session keeps speaking for TTS.
    await service.createSession("device:B", { resumeFromId: created.sessionId });
    service.sendMessage("device:B", created.sessionId, "and where?");
    await settle();

    // Explicit interactive resume (the conversation tapped open in the app)
    // switches follow-up turns off the voice prompt.
    await service.createSession("device:B", {
      resumeFromId: created.sessionId,
      profile: "interactive",
    });
    service.sendMessage("device:B", created.sessionId, "show me the invite");
    await settle();

    const prompts = backend.turns.map((t) => t.systemPrompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("base prompt for voice");
    expect(prompts[1]).toContain("base prompt for voice");
    expect(prompts[2]).toContain("base prompt for interactive");
    await service.dispose();
  });

  it("live resume with profile voice puts an interactive session onto the spoken prompt", async () => {
    const backend = new RecordingBackend();
    const service = makeService(backend, {
      systemPrompt: (profile) => `base prompt for ${profile}`,
    });

    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hello");
    await settle();

    // A Siri follow-up live-resumes the conversation as voice.
    await service.createSession("device:A", { resumeFromId: created.sessionId, profile: "voice" });
    service.sendMessage("device:A", created.sessionId, "when is the meeting?");
    await settle();

    expect(backend.turns[0]?.systemPrompt).toContain("base prompt for interactive");
    expect(backend.turns[1]?.systemPrompt).toContain("base prompt for voice");
    // The switched session kept the conversation history.
    expect(backend.turns[1]?.history.length).toBeGreaterThan(1);
    await service.dispose();
  });

  it("a profile switch requested while a turn is in flight applies to the next turn", async () => {
    const backend = new GatedRecordingBackend();
    const service = makeService(backend, {
      systemPrompt: (profile) => `base prompt for ${profile}`,
    });

    const created = await service.createSession("device:A", { profile: "voice" });
    service.sendMessage("device:A", created.sessionId, "slow question");
    // The first turn is blocked inside the backend — the session is busy.
    const resumed = await service.createSession("device:A", {
      resumeFromId: created.sessionId,
      profile: "interactive",
    });
    expect(resumed.busy).toBe(true);

    backend.open();
    await sleep(20);
    await settle();
    service.sendMessage("device:A", created.sessionId, "follow-up");
    await settle();

    expect(backend.turns).toHaveLength(2);
    expect(backend.turns[0]?.systemPrompt).toContain("base prompt for voice");
    expect(backend.turns[1]?.systemPrompt).toContain("base prompt for interactive");
    await service.dispose();
  });

  it("disk resume with profile voice rebuilds the stored conversation on the spoken prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-voice-resume-test-"));
    tempDirs.push(dir);
    const backend = new RecordingBackend();

    const first = makeService(backend, {
      systemPrompt: (profile) => `base prompt for ${profile}`,
      store: new FsConversationStore(dir),
    });
    const created = await first.createSession("device:A", { profile: "voice" });
    first.sendMessage("device:A", created.sessionId, "when is the meeting?");
    await sleep(20);
    await settle();
    await first.dispose();

    const second = makeService(backend, {
      systemPrompt: (profile) => `base prompt for ${profile}`,
      store: new FsConversationStore(dir),
    });
    const resumed = await second.createSession("device:A", {
      resumeFromId: created.sessionId,
      profile: "voice",
    });
    expect(resumed.messageCount).toBeGreaterThan(0);
    second.sendMessage("device:A", created.sessionId, "and where?");
    await settle();

    const resumedTurn = backend.turns.at(-1);
    expect(resumedTurn?.systemPrompt).toContain("base prompt for voice");
    await second.dispose();
  });
});

describe("sendMessage notifyAfterMs", () => {
  it("sends no notification when the turn settles within the budget", async () => {
    const notifications: AgentAnswerNotification[] = [];
    const service = makeService(new SlowBackend(0), {
      notifyAnswer: (n) => {
        notifications.push(n);
      },
    });
    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 60_000 });
    await sleep(20);
    await settle();
    expect(notifications).toHaveLength(0);
    await service.dispose();
  });

  it("sends exactly one notification with the final text when the turn outlives the budget", async () => {
    const notifications: AgentAnswerNotification[] = [];
    const service = makeService(new SlowBackend(20), {
      notifyAnswer: (n) => {
        notifications.push(n);
      },
    });
    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "when is the meeting?", {
      notifyAfterMs: 1,
    });
    await sleep(40);
    await settle();
    expect(notifications).toEqual([
      { conversationId: created.sessionId, answer: "The meeting is at noon tomorrow." },
    ]);
    await service.dispose();
  });

  it("a turn past the budget that ends cleanly with no visible text notifies answer: null", async () => {
    const notifications: AgentAnswerNotification[] = [];
    const service = makeService(new SlowBackend(20, null), {
      notifyAnswer: (n) => {
        notifications.push(n);
      },
    });
    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 1 });
    await sleep(40);
    await settle();
    expect(notifications).toEqual([{ conversationId: created.sessionId, answer: null }]);
    await service.dispose();
  });

  it("a whitespace-only answer past the budget notifies answer: null", async () => {
    const notifications: AgentAnswerNotification[] = [];
    const service = makeService(new SlowBackend(20, " \n\t "), {
      notifyAnswer: (n) => {
        notifications.push(n);
      },
    });
    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 1 });
    await sleep(40);
    await settle();
    expect(notifications).toEqual([{ conversationId: created.sessionId, answer: null }]);
    await service.dispose();
  });

  it("a turn truncated by max_tokens past the budget notifies answer: null", async () => {
    const notifications: AgentAnswerNotification[] = [];
    const service = makeService(new SlowBackend(20, "Partial answer text", "max_tokens"), {
      notifyAnswer: (n) => {
        notifications.push(n);
      },
    });
    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 1 });
    await sleep(40);
    await settle();
    expect(notifications).toEqual([{ conversationId: created.sessionId, answer: null }]);
    await service.dispose();
  });

  it("sends a null-answer notification when the turn fails after the budget", async () => {
    const notifications: AgentAnswerNotification[] = [];
    const service = makeService(new SlowFailingBackend(20), {
      notifyAnswer: (n) => {
        notifications.push(n);
      },
    });
    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 1 });
    await sleep(40);
    await settle();
    expect(notifications).toEqual([{ conversationId: created.sessionId, answer: null }]);
    await service.dispose();
  });

  it("sends nothing for a turn the user cancelled, even past the budget", async () => {
    const notifications: AgentAnswerNotification[] = [];
    const service = makeService(new CancelableBackend(), {
      notifyAnswer: (n) => {
        notifications.push(n);
      },
    });
    const created = await service.createSession("device:A");
    service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 1 });
    await sleep(20);
    service.cancelSession("device:A", created.sessionId);
    await sleep(20);
    await settle();
    expect(notifications).toHaveLength(0);
    await service.dispose();
  });

  it("a throwing notifier never fails the turn", async () => {
    const service = makeService(new SlowBackend(20), {
      notifyAnswer: () => Promise.reject(new Error("push transport down")),
    });
    const created = await service.createSession("device:A");
    expect(() =>
      service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 1 }),
    ).not.toThrow();
    await sleep(40);
    await settle();
    // The turn committed despite the notifier rejection.
    const record = await service.createSession("device:A", { resumeFromId: created.sessionId });
    expect(record.messageCount).toBeGreaterThan(0);
    await service.dispose();
  });

  it("is inert when no notifier is wired", async () => {
    const service = makeService(new SlowBackend(0));
    const created = await service.createSession("device:A");
    expect(() =>
      service.sendMessage("device:A", created.sessionId, "hi", { notifyAfterMs: 1 }),
    ).not.toThrow();
    await sleep(20);
    await settle();
    await service.dispose();
  });
});

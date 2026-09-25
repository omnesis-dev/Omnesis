// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import {
  parseBriefJudgeVerdict,
  briefJudgeGateSet,
  buildBriefJudgeUserPrompt,
  runBriefJudgeGate,
  LlmBriefJudge,
  type BriefJudge,
  type BriefJudgeCandidate,
} from "./brief-judge.js";
import type { ChatBackend, TurnInput } from "@omnesis/agent";
import type { AgentEvent } from "@omnesis/core";

const log = createLogger("test").child("brief-judge");

const candidate: BriefJudgeCandidate = {
  kind: "info",
  lane: "reactive",
  title: "Checking account projected negative after mortgage payment",
  description: "A new charge plus the upcoming debit takes the balance below zero.",
  citationCount: 2,
  relatedLoopCount: 1,
  scheduledForLater: false,
  hasEventAt: true,
};

/** A stub judge that returns a fixed verdict, or throws / hangs on demand. */
function stubJudge(behaviour: BriefJudge["judge"]): BriefJudge {
  return { judge: behaviour };
}

describe("parseBriefJudgeVerdict", () => {
  it("parses a SHIP verdict and keeps the reasoning as the reason", () => {
    const v = parseBriefJudgeVerdict(
      "Clears all four gates — timely and consequential.\nVERDICT: SHIP",
    );
    expect(v).toEqual({
      decision: "ship",
      reason: "Clears all four gates — timely and consequential.",
    });
  });

  it("parses a HOLD verdict (case-insensitive)", () => {
    const v = parseBriefJudgeVerdict("Echoes an action the user just took.\nverdict: hold");
    expect(v?.decision).toBe("hold");
    expect(v?.reason).toBe("Echoes an action the user just took.");
  });

  it("takes the LAST verdict token when several appear", () => {
    const v = parseBriefJudgeVerdict(
      "First I thought VERDICT: SHIP but on reflection VERDICT: HOLD",
    );
    expect(v?.decision).toBe("hold");
  });

  it("returns null when no verdict token is present (caller fails open)", () => {
    expect(parseBriefJudgeVerdict("I am not sure how to decide this one.")).toBeNull();
  });

  it("fills a placeholder reason when the model gave only the verdict", () => {
    expect(parseBriefJudgeVerdict("VERDICT: SHIP")).toEqual({
      decision: "ship",
      reason: "(no reason given)",
    });
  });
});

describe("buildBriefJudgeUserPrompt", () => {
  it("renders the content and the timing signals", () => {
    const p = buildBriefJudgeUserPrompt(candidate);
    expect(p).toContain("kind: info");
    expect(p).toContain(candidate.title);
    expect(p).toContain("grounded in 2 cited document(s)");
    expect(p).toContain("rolls up 1 tracked obligation(s)");
    expect(p).toContain("would surface now");
    expect(p).toContain("carries a concrete event/due moment");
  });

  it("marks a dated reminder as timing-satisfied and omits empty body", () => {
    const p = buildBriefJudgeUserPrompt({
      ...candidate,
      description: undefined,
      body: undefined,
      scheduledForLater: true,
      hasEventAt: false,
    });
    expect(p).toContain("scheduled to surface later");
    expect(p).not.toContain("- description:");
    expect(p).not.toContain("- body:");
  });
});

describe("briefJudgeGateSet", () => {
  it("selects the lane-specific judging policy", () => {
    expect(briefJudgeGateSet("reactive")).toBe("reactive");
    expect(briefJudgeGateSet("lookahead")).toBe("preparation");
    expect(briefJudgeGateSet("dated_reminder")).toBe("preparation");
    expect(briefJudgeGateSet("noticing")).toBe("non_obviousness");
  });
});

describe("runBriefJudgeGate", () => {
  it("passes when no judge is wired (gate absent)", async () => {
    expect(await runBriefJudgeGate({ log, runId: "run_1" }, candidate)).toEqual({ kind: "pass" });
  });

  it("passes when the judge resolves to null (disabled)", async () => {
    const out = await runBriefJudgeGate(
      { getBriefJudge: () => null, log, runId: "run_1" },
      candidate,
    );
    expect(out).toEqual({ kind: "pass" });
  });

  it("passes on a SHIP verdict", async () => {
    const judge = stubJudge(async () => ({ decision: "ship", reason: "clears the bar" }));
    expect(
      await runBriefJudgeGate({ getBriefJudge: () => judge, log, runId: "run_1" }, candidate),
    ).toEqual({
      kind: "pass",
    });
  });

  it("holds on a HOLD verdict and relays the reason", async () => {
    const judge = stubJudge(async () => ({ decision: "hold", reason: "the user just did this" }));
    const out = await runBriefJudgeGate(
      { getBriefJudge: () => judge, log, runId: "run_1" },
      candidate,
    );
    expect(out).toEqual({ kind: "hold", reason: "the user just did this" });
  });

  it("fails closed (holds) when a configured judge throws", async () => {
    const judge = stubJudge(async () => {
      throw new Error("model exploded");
    });
    expect(
      await runBriefJudgeGate({ getBriefJudge: () => judge, log, runId: "run_1" }, candidate),
    ).toEqual({
      kind: "hold",
      reason:
        "the configured Brief judge was unavailable, so the card was held rather than shipped without review",
    });
  });

  it("never judges a digest card — the gate is skipped before the judge is resolved", async () => {
    const judge = stubJudge(async () => ({ decision: "hold", reason: "would have held it" }));
    const getBriefJudge = vi.fn(() => judge);
    const out = await runBriefJudgeGate(
      { getBriefJudge, log, runId: "run_1" },
      { ...candidate, lane: "digest" as const },
    );
    expect(out).toEqual({ kind: "pass" });
    // Skipped early enough that it costs no backend resolve, and therefore no
    // model call: a scheduled once-a-day composition cannot earn an interrupt
    // by construction, so asking is pure spend.
    expect(getBriefJudge).not.toHaveBeenCalled();
  });

  it("still judges every other lane", async () => {
    for (const lane of ["lookahead", "dated_reminder", "noticing", "reactive"] as const) {
      const judge = stubJudge(async () => ({ decision: "hold", reason: `held ${lane}` }));
      expect(
        await runBriefJudgeGate(
          { getBriefJudge: () => judge, log, runId: "run_1" },
          { ...candidate, lane },
        ),
      ).toEqual({ kind: "hold", reason: `held ${lane}` });
    }
  });
});

/** A one-shot ChatBackend that streams a fixed answer (and optional usage). */
class FakeBackend implements ChatBackend {
  readonly name = "fake-judge";
  readonly model = "fake-judge-model";
  readonly seen: TurnInput[] = [];

  constructor(
    private readonly text: string,
    private readonly usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ) {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.seen.push(input);
    yield {
      type: "agent.text.delta",
      payload: { sessionId: input.sessionId, messageId: input.messageId, delta: this.text },
    };
    yield {
      type: "agent.message.end",
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        stopReason: "end_turn",
        ...(this.usage ? { usage: this.usage } : {}),
      },
    };
  }
}

class FailedTurnBackend implements ChatBackend {
  readonly name = "fake-judge";
  readonly model = "fake-judge-model";

  constructor(private readonly code: "context_window_exceeded" | "output_truncated") {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    yield {
      type: "agent.text.delta",
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        delta: "VERDICT: SHIP",
      },
    };
    yield {
      type: "agent.message.end",
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        stopReason: this.code === "output_truncated" ? "max_tokens" : "error",
        usage: { inputTokens: 80, outputTokens: 12 },
        ...(this.code === "context_window_exceeded"
          ? {
              failure: {
                code: this.code,
                message: "prompt is too long",
                retryable: false,
                backend: this.name,
                model: this.model,
              },
            }
          : {}),
      },
    };
  }
}

describe("LlmBriefJudge", () => {
  it("ships (fail-open) when no backend is resolvable — no session runs", async () => {
    const judge = new LlmBriefJudge({ resolveBackend: () => null, log });
    expect(await judge.judge(candidate)).toEqual({
      decision: "ship",
      reason: "judge backend unavailable (fail-open)",
    });
  });

  it("runs the completion, parses SHIP, and records spend once with folded usage", async () => {
    const backend = new FakeBackend("Clears all four gates.\nVERDICT: SHIP", {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 5,
    });
    const spend: Array<{
      modelId: string;
      promptTokens: number;
      completionTokens: number;
      countRun: boolean;
    }> = [];
    const judge = new LlmBriefJudge({
      resolveBackend: () => backend,
      recordUsage: (u) => spend.push(u),
      log,
    });
    const verdict = await judge.judge(candidate);
    expect(verdict.decision).toBe("ship");
    expect(backend.seen).toHaveLength(1);
    // promptTokens = input + cacheRead + cacheCreation; completionTokens = output.
    expect(spend).toEqual([
      {
        modelId: "fake-judge-model",
        promptTokens: 135,
        completionTokens: 20,
        countRun: true,
      },
    ]);
  });

  it("throws when the model returns no verdict (the gate then fails open)", async () => {
    const judge = new LlmBriefJudge({
      resolveBackend: () => new FakeBackend("I really can't decide this one."),
      log,
    });
    await expect(judge.judge(candidate)).rejects.toThrow(/no verdict/);
  });

  it("records no spend when the backend reports zero usage", async () => {
    let recorded = 0;
    const judge = new LlmBriefJudge({
      resolveBackend: () => new FakeBackend("VERDICT: HOLD"),
      recordUsage: () => {
        recorded += 1;
      },
      log,
    });
    expect((await judge.judge(candidate)).decision).toBe("hold");
    expect(recorded).toBe(0);
  });

  it.each(["context_window_exceeded", "output_truncated"] as const)(
    "throws a typed %s failure instead of parsing partial output",
    async (code) => {
      const spend: Array<{
        modelId: string;
        promptTokens: number;
        completionTokens: number;
        countRun: boolean;
      }> = [];
      const judge = new LlmBriefJudge({
        resolveBackend: () => new FailedTurnBackend(code),
        recordUsage: (usage) => spend.push(usage),
        log,
      });

      await expect(judge.judge(candidate)).rejects.toMatchObject({
        name: "BriefJudgeModelFailureError",
        failure: { code, retryable: false },
      });
      expect(spend).toEqual([
        {
          modelId: "fake-judge-model",
          promptTokens: 80,
          completionTokens: 12,
          countRun: false,
        },
      ]);
    },
  );

  it("holds on a typed context-window failure and logs the cause", async () => {
    const judge = new LlmBriefJudge({
      resolveBackend: () => new FailedTurnBackend("context_window_exceeded"),
      log,
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    try {
      expect(
        await runBriefJudgeGate({ getBriefJudge: () => judge, log, runId: "run_1" }, candidate),
      ).toEqual({
        kind: "hold",
        reason:
          "the configured Brief judge was unavailable, so the card was held rather than shipped without review",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("context_window_exceeded"));
    } finally {
      warn.mockRestore();
    }
  });
});

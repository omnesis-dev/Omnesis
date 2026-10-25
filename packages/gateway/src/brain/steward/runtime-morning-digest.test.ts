// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The morning run's runtime seams, zero-token: `preflight` settles a day
 * already sent and an empty packet without inference, runs the morning
 * recheck (decision model stubbed at the DecisionCapability seam) before
 * deciding whether there is anything to say, and defers when the horizon is
 * unreadable; `validateRun` fails a digest run that had inputs but never
 * sent; and only the digest run is handed `morning_brief_send`.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  createLogger,
  type DecisionCapability,
  type TemporalItem,
  type ToolResult,
} from "@omnesis/core";
import { TemporalQueryService } from "../../enrichment/temporal/temporal-query-service.js";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { resolveBrainSettings } from "../config.js";
import { createObservation, getObservation } from "../storage/observations.js";
import { listMorningBriefItems, morningBriefSent } from "../storage/morning-brief-items.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { cognitionSpendDay } from "../storage/spend.js";
import { DEFAULT_SALIENCE_THRESHOLDS } from "../observations/salience.js";
import { createCognitionRuntime, type CognitionRuntimeDeps } from "./runtime.js";
import type { MorningBriefConversationPort } from "../observations/morning-brief.js";
import type { ClaimedCognitionRun } from "../storage/types.js";
import type Database from "better-sqlite3";

const log = createLogger("test").child("runtime-morning-digest");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 86_400_000;
const TODAY = "2026-07-02";

let path: string;
let db: Database.Database;
let query: ReturnType<typeof vi.spyOn>;

let decide: Mock<(...args: any[]) => Promise<any>>;
let appended: Array<{ day: string; text: string; notify: boolean }>;

function temporalResult(items: TemporalItem[]) {
  return {
    type: "temporal.results" as const,
    window: {
      start: new Date(NOW).toISOString(),
      endExclusive: new Date(NOW + 3 * DAY).toISOString(),
      timeZone: "UTC",
    },
    items,
    summary: { anchored: items.length, spanning: 0 },
    coverage: { projectionSources: [], specialistSources: [], annotations: { selective: true } },
    truncated: false,
  };
}

const calendarItem: TemporalItem = {
  id: "proj_meeting",
  origin: "projection",
  start: new Date(NOW + DAY).toISOString(),
  endExclusive: new Date(NOW + DAY + 3_600_000).toISOString(),
  precision: "instant",
  allDay: false,
  label: "Quarterly planning review",
  kind: "appointment",
  modality: "scheduled",
  status: "active",
  projection: {
    sourceId: "calendar:test",
    slot: "calendar",
    projectedAt: new Date(NOW).toISOString(),
    revision: "r1",
  },
};

function scores(consequence: number, timing: number, alreadyKnown = 0) {
  return {
    model: "scripted-decision",
    answers: {
      consequence: { type: "score", score: consequence },
      timing: { type: "score", score: timing },
      already_known: { type: "score", score: alreadyKnown },
    },
    inputTokens: 0,
  };
}

function claimed(overrides: Partial<ClaimedCognitionRun>): ClaimedCognitionRun {
  const payload = overrides.payload ?? { digest: true, date: TODAY };
  return {
    id: "run_morning",
    kind: "daily",
    payload,
    payloadJson: JSON.stringify(payload),
    attempts: 1,
    ...overrides,
  };
}

const digestRun = () => claimed({});
const sourceDailyRun = () =>
  claimed({ id: "run_source", payload: { sourceId: "gmail-test", fromMs: 1, toMs: 2 } });

function runtime(
  opts: { observations?: boolean; port?: MorningBriefConversationPort | null } = {},
) {
  const writeGate = directWriteGate(db);
  const decision: DecisionCapability = {
    modelId: "scripted-decision",
    decide: (...args) => decide(...args),
    dispose() {},
  };
  const port: MorningBriefConversationPort | null =
    opts.port === undefined
      ? {
          appendMorningBrief: async (input) => {
            appended.push({ day: input.day, text: input.text, notify: input.notify });
            return { conversationId: "conv_morning", messageId: `msg_${appended.length}` };
          },
        }
      : opts.port;
  const observations: CognitionRuntimeDeps["observations"] = {
    recheck: {
      writes: writeGate,
      getDecision: () => decision,
      recordSpend: async () => {},
      thresholds: () => DEFAULT_SALIENCE_THRESHOLDS,
    },
    createScorer: () => async () => ({ scores: null, wouldPushAt: null }),
    sender: {
      getPort: () => port,
      markSent: (input, now) => writeGate.markMorningBriefSent(input, now),
      suppressObservation: (id, now) =>
        writeGate.transitionObservation(id, { state: "dropped", reason: "suppressed" }, now),
      getPushEnabled: () => true,
    },
  };
  return createCognitionRuntime({
    db,
    writeGate,
    searchPipeline: {} as unknown as CognitionRuntimeDeps["searchPipeline"],
    syncStatus: {} as unknown as CognitionRuntimeDeps["syncStatus"],
    analyticsDb: {} as unknown as CognitionRuntimeDeps["analyticsDb"],
    getSettings: () => resolveBrainSettings(),
    ...(opts.observations === false ? {} : { observations }),
    clock: () => NOW,
    log,
  });
}

function sendTool(rt: Awaited<ReturnType<typeof runtime>>, run: ClaimedCognitionRun) {
  return rt.buildTools(run).find((t) => t.name === "morning_brief_send");
}

async function send(rt: Awaited<ReturnType<typeof runtime>>, args: unknown): Promise<ToolResult> {
  const tool = sendTool(rt, digestRun());
  if (!tool) throw new Error("morning_brief_send missing");
  return tool.invoke(args, { sessionId: "S", messageId: "M" });
}

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  appended = [];
  decide = vi.fn(async () => scores(3, 2));
  query = vi
    .spyOn(TemporalQueryService.prototype, "query")
    .mockResolvedValue(temporalResult([]) as never);
});
afterEach(() => {
  query.mockRestore();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

describe("digest preflight", () => {
  test("a non-digest run continues without reading the horizon", async () => {
    const rt = await runtime();
    expect(await rt.preflight!(sourceDailyRun())).toBe("continue");
    expect(await rt.preflight!(claimed({ kind: "feedback", payload: {} }))).toBe("continue");
    expect(query).not.toHaveBeenCalled();
  });

  test("a day already sent completes without reading anything or asking the model", async () => {
    createObservation(db, { id: "obs_1", createdByRun: "r", summary: "Pending." }, NOW - DAY);
    const rt = await runtime();
    expect((await send(rt, { text: "Good morning." })).kind).toBe("structured");
    query.mockClear();
    decide.mockClear();
    expect(await rt.preflight!(digestRun())).toBe("complete");
    expect(query).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  test("nothing to say completes with no message", async () => {
    const rt = await runtime();
    expect(await rt.preflight!(digestRun())).toBe("complete");
    expect(appended).toEqual([]);
    expect(morningBriefSent(db, TODAY)).toBe(false);
  });

  test("an unreadable horizon defers without inference", async () => {
    createObservation(db, { id: "obs_1", createdByRun: "r", summary: "Pending." }, NOW - DAY);
    query.mockRejectedValue(new Error("temporal store unavailable"));
    const rt = await runtime();
    expect(await rt.preflight!(digestRun())).toBe("defer");
    expect(decide).not.toHaveBeenCalled();
  });

  test("with no conversation to write into, the run waits without reading or asking", async () => {
    createObservation(db, { id: "obs_1", createdByRun: "r", summary: "Pending." }, NOW - DAY);
    const rt = await runtime({ port: null });
    expect(await rt.preflight!(digestRun())).toBe("defer");
    expect(query).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  test("a calendar horizon alone is enough to continue", async () => {
    query.mockResolvedValue(temporalResult([calendarItem]) as never);
    const rt = await runtime();
    expect(await rt.preflight!(digestRun())).toBe("continue");
  });

  test("a loop coming due alone is enough to continue", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_due",
        createdByRun: "r",
        title: "Renew the parking permit",
        confidence: 0.8,
        importance: 0.5,
        deadline: cognitionSpendDay(NOW),
      },
      NOW - 20 * DAY,
    );
    const rt = await runtime();
    expect(await rt.preflight!(digestRun())).toBe("continue");
  });

  test("the recheck ranks shippable observations into today's list and continues", async () => {
    createObservation(db, { id: "obs_low", createdByRun: "r", summary: "Lower." }, NOW - 2 * DAY);
    createObservation(db, { id: "obs_high", createdByRun: "r", summary: "Higher." }, NOW - DAY);
    decide.mockImplementation(async (request: { state: { observation: string } }) =>
      request.state.observation === "Higher." ? scores(4, 3) : scores(2, 1),
    );
    const rt = await runtime();
    expect(await rt.preflight!(digestRun())).toBe("continue");
    expect(decide).toHaveBeenCalledTimes(2);
    expect(listMorningBriefItems(db, TODAY).map((i) => i.observationId)).toEqual([
      "obs_high",
      "obs_low",
    ]);
  });

  test("observations the recheck holds back are not a reason to send", async () => {
    createObservation(db, { id: "obs_meh", createdByRun: "r", summary: "Trivia." }, NOW - DAY);
    decide.mockResolvedValue(scores(0, 0));
    const rt = await runtime();
    expect(await rt.preflight!(digestRun())).toBe("complete");
    expect(getObservation(db, "obs_meh")?.state).toBe("held");
    expect(listMorningBriefItems(db, TODAY)).toEqual([]);
  });

  test("without the observation pipeline an open observation is not ranked", async () => {
    createObservation(db, { id: "obs_1", createdByRun: "r", summary: "Pending." }, NOW - DAY);
    const rt = await runtime({ observations: false });
    expect(await rt.preflight!(digestRun())).toBe("complete");
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("digest validateRun", () => {
  test("a run with inputs that did not send fails with an instruction to send", async () => {
    query.mockResolvedValue(temporalResult([calendarItem]) as never);
    const rt = await runtime();
    expect(await rt.validateRun!(digestRun())).toContain("morning_brief_send");
  });

  test("passes once the brief is sent", async () => {
    query.mockResolvedValue(temporalResult([calendarItem]) as never);
    const rt = await runtime();
    await send(rt, { text: "Planning review tomorrow." });
    expect(await rt.validateRun!(digestRun())).toBeNull();
  });

  test("passes a run that had nothing to say", async () => {
    const rt = await runtime();
    expect(await rt.validateRun!(digestRun())).toBeNull();
  });

  test("never judges non-digest runs or runtimes without the observation pipeline", async () => {
    query.mockResolvedValue(temporalResult([calendarItem]) as never);
    expect(await (await runtime()).validateRun!(sourceDailyRun())).toBeNull();
    expect(await (await runtime({ observations: false })).validateRun!(digestRun())).toBeNull();
  });
});

describe("morning_brief_send in the toolset", () => {
  test("only the digest run with the observation pipeline gets the tool", async () => {
    const rt = await runtime();
    expect(sendTool(rt, digestRun())).toBeDefined();
    expect(sendTool(rt, sourceDailyRun())).toBeUndefined();
    expect(sendTool(await runtime({ observations: false }), digestRun())).toBeUndefined();
  });

  test("sends once, ships the ranked items, and refuses a second send", async () => {
    createObservation(db, { id: "obs_a", createdByRun: "r", summary: "Ship me." }, NOW - DAY);
    decide.mockResolvedValue(scores(3, 2));
    const rt = await runtime();
    expect(await rt.preflight!(digestRun())).toBe("continue");
    const first = await send(rt, { text: "One thing today." });
    expect(first).toMatchObject({
      kind: "structured",
      resultType: "morning_brief.sent",
      data: { conversationId: "conv_morning", shippedObservations: 1 },
    });
    expect(appended).toEqual([{ day: TODAY, text: "One thing today.", notify: true }]);
    expect(getObservation(db, "obs_a")).toMatchObject({
      state: "shipped",
      shippedMessageId: "msg_1",
    });
    const second = await send(rt, { text: "Again." });
    expect(second).toMatchObject({ kind: "error", code: "already_sent" });
    expect(appended).toHaveLength(1);
  });

  test("an unavailable conversation is an error and records nothing", async () => {
    const rt = await runtime({ port: null });
    const result = await send(rt, { text: "Hello." });
    expect(result).toMatchObject({ kind: "error", code: "conversation_unavailable" });
    expect(morningBriefSent(db, TODAY)).toBe(false);
  });
});

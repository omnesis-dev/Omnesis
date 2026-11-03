// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sending the morning brief over a real gateway store with a recording
 * conversation port: once per day, the notification flag follows the push
 * setting, omitted observations are suppressed, and the ranked list ships.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import {
  getSentMorningBrief,
  markMorningBriefSent,
  replaceMorningBriefItems,
  type MarkMorningBriefSentResult,
} from "../storage/morning-brief-items.js";
import {
  createObservation,
  getObservation,
  transitionObservation,
} from "../storage/observations.js";
import { readDailyBriefDetail } from "./brief-detail.js";
import {
  buildMorningBriefSendTool,
  MORNING_BRIEF_MAX_CHARS,
  sendMorningBrief,
  type MorningBriefConversationPort,
  type MorningBriefSenderDeps,
} from "./morning-brief.js";
import type Database from "better-sqlite3";

const log = createLogger("test").child("morning-brief");
const NOW = Date.parse("2026-07-02T07:00:00.000Z");
const DAY = "2026-07-02";
const CTX = { sessionId: "S", messageId: "M" };

describe("morning brief sending", () => {
  let path: string;
  let db: Database.Database;
  let port: MorningBriefConversationPort & { appendMorningBrief: ReturnType<typeof vi.fn> };
  let pushEnabled: boolean;
  let messageSeq: number;

  function deps(overrides: Partial<MorningBriefSenderDeps> = {}): MorningBriefSenderDeps {
    return {
      db,
      getPort: () => port,
      markSent: (input, now) => Promise.resolve(markMorningBriefSent(db, input, now)),
      suppressObservation: (id, now) =>
        Promise.resolve(
          transitionObservation(db, id, { state: "dropped", reason: "suppressed" }, now),
        ),
      getPushEnabled: () => pushEnabled,
      clock: () => NOW,
      log,
      ...overrides,
    };
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    pushEnabled = true;
    messageSeq = 0;
    port = {
      appendMorningBrief: vi.fn(async () => ({
        conversationId: "conv_brief",
        messageId: `msg_${++messageSeq}`,
      })),
    };
    for (const id of ["obs_1", "obs_2", "obs_3", "obs_off"])
      createObservation(
        db,
        { id, createdByRun: "run_note", summary: `Observation ${id}` },
        NOW - 1,
      );
    replaceMorningBriefItems(db, DAY, "run_morning", ["obs_2", "obs_1", "obs_3"]);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  describe("sendMorningBrief", () => {
    test("appends the text, records the send and ships the ranked observations", async () => {
      const result = await sendMorningBrief(deps(), {
        day: DAY,
        runId: "run_morning",
        text: "Good morning. Two things today.",
      });
      expect(result).toEqual({
        sent: true,
        conversationId: "conv_brief",
        messageId: "msg_1",
        shipped: ["obs_2", "obs_1", "obs_3"],
      });
      expect(port.appendMorningBrief).toHaveBeenCalledExactlyOnceWith({
        day: DAY,
        runId: "run_morning",
        text: "Good morning. Two things today.",
        notify: true,
      });
      expect(getSentMorningBrief(db, DAY)).toMatchObject({
        messageId: "msg_1",
        itemCount: 3,
        sentAt: NOW,
      });
      expect(getObservation(db, "obs_off")?.state).toBe("live");
    });

    test("the notification flag follows the push setting", async () => {
      pushEnabled = false;
      await sendMorningBrief(deps(), { day: DAY, runId: "run_morning", text: "Brief." });
      expect(port.appendMorningBrief.mock.calls[0]![0]).toMatchObject({ notify: false });
    });

    test("a day already sent is refused before the port is touched", async () => {
      await sendMorningBrief(deps(), { day: DAY, runId: "run_morning", text: "First." });
      const second = await sendMorningBrief(deps(), {
        day: DAY,
        runId: "run_morning",
        text: "Second.",
        omittedObservationIds: ["obs_1"],
      });
      expect(second).toEqual({ sent: false, reason: "already_sent" });
      expect(port.appendMorningBrief).toHaveBeenCalledTimes(1);
      expect(getSentMorningBrief(db, DAY)?.messageId).toBe("msg_1");
    });

    test("an unavailable conversation port sends nothing and suppresses nothing", async () => {
      const suppressObservation = vi.fn(async () => true);
      const result = await sendMorningBrief(deps({ getPort: () => null, suppressObservation }), {
        day: DAY,
        runId: "run_morning",
        text: "Brief.",
        omittedObservationIds: ["obs_1"],
      });
      expect(result).toEqual({ sent: false, reason: "conversation_unavailable" });
      expect(suppressObservation).not.toHaveBeenCalled();
      expect(getSentMorningBrief(db, DAY)).toBeNull();
      expect(getObservation(db, "obs_1")?.state).toBe("live");
    });

    test("omitted listed observations are suppressed and do not ship; unlisted ids are ignored", async () => {
      const result = await sendMorningBrief(deps(), {
        day: DAY,
        runId: "run_morning",
        text: "Brief.",
        omittedObservationIds: ["obs_1", "obs_off", "obs_unknown"],
      });
      expect(result).toMatchObject({ sent: true, shipped: ["obs_2", "obs_3"] });
      expect(getObservation(db, "obs_1")).toMatchObject({
        state: "dropped",
        closeReason: "suppressed",
      });
      expect(getObservation(db, "obs_off")?.state).toBe("live");
    });

    test("a send recorded concurrently after the append reports already_sent", async () => {
      const markSent = vi.fn(async (): Promise<MarkMorningBriefSentResult> => ({
        ok: false,
        reason: "already_sent",
      }));
      const result = await sendMorningBrief(deps({ markSent }), {
        day: DAY,
        runId: "run_morning",
        text: "Brief.",
      });
      expect(result).toEqual({ sent: false, reason: "already_sent" });
      expect(markSent).toHaveBeenCalledExactlyOnceWith(
        { day: DAY, runId: "run_morning", conversationId: "conv_brief", messageId: "msg_1" },
        NOW,
      );
    });

    test("a day with no ranked items still sends", async () => {
      const result = await sendMorningBrief(deps(), {
        day: "2026-07-03",
        runId: "run_next",
        text: "Calendar only today.",
      });
      expect(result).toMatchObject({ sent: true, shipped: [] });
    });
  });

  describe("morning_brief_send tool", () => {
    const tool = () => buildMorningBriefSendTool(deps(), { day: DAY, runId: "run_morning" });

    test("attaches documents of any source without creating observations", async () => {
      for (const [id, source] of [
        ["email_ref", "gmail:fiction"],
        ["chat_ref", "whatsapp:fiction"],
      ]) {
        db.prepare(
          `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
          VALUES (?, 'p', ?, ?, 'Supporting record', 'body', 'h', '2026-07-01', '2026-07-01', '2026-07-01', '2026-07-01')`,
        ).run(id, source, id);
      }
      const t = buildMorningBriefSendTool(deps(), { day: "2026-07-03", runId: "run_next" });
      expect(
        await t.invoke(
          {
            text: "Two records support this brief.",
            referenceDocumentIds: ["email_ref", "chat_ref", "email_ref"],
          },
          CTX,
        ),
      ).toMatchObject({ kind: "structured" });
      const detail = readDailyBriefDetail(db, { day: "2026-07-03", messageId: "msg_1" });
      expect(detail.items).toEqual([]);
      expect(detail.references?.map((r) => [r.id, r.sourceType])).toEqual([
        ["email_ref", "gmail"],
        ["chat_ref", "whatsapp"],
      ]);
      expect(detail.references?.every((r) => !("reaction" in r))).toBe(true);
    });

    test("unavailable references reject before sending or suppressing observations", async () => {
      expect(
        await tool().invoke(
          { text: "Brief.", referenceDocumentIds: ["missing"], omittedObservationIds: ["obs_1"] },
          CTX,
        ),
      ).toMatchObject({ kind: "error", code: "invalid_references" });
      expect(port.appendMorningBrief).not.toHaveBeenCalled();
      expect(getObservation(db, "obs_1")?.state).toBe("live");
    });

    test("an existing document outside the run's evidence is refused", async () => {
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
        VALUES ('unread', 'p', 'files:fiction', 'unread', 'Unread', 'body', 'h', '2026-07-01', '2026-07-01', '2026-07-01', '2026-07-01')`,
      ).run();
      const t = buildMorningBriefSendTool(deps({ canReferenceDocument: () => false }), {
        day: DAY,
        runId: "run_morning",
      });
      expect(
        await t.invoke({ text: "Brief.", referenceDocumentIds: ["unread"] }, CTX),
      ).toMatchObject({ kind: "error", code: "invalid_references" });
      expect(port.appendMorningBrief).not.toHaveBeenCalled();
    });

    test("is a mutating tool named morning_brief_send", () => {
      expect(tool()).toMatchObject({ name: "morning_brief_send", mutates: true });
    });

    test("sends and reports the shipped count", async () => {
      const result = await tool().invoke(
        { text: "  Good morning.  ", omittedObservationIds: ["obs_3"] },
        CTX,
      );
      expect(result).toEqual({
        kind: "structured",
        resultType: "morning_brief.sent",
        data: { conversationId: "conv_brief", shippedObservations: 2 },
      });
      expect(port.appendMorningBrief.mock.calls[0]![0]).toMatchObject({ text: "Good morning." });
      expect(getObservation(db, "obs_3")?.closeReason).toBe("suppressed");
    });

    test.each<[string, unknown]>([
      ["missing text", {}],
      ["blank text", { text: "   " }],
      ["text over the limit", { text: "x".repeat(MORNING_BRIEF_MAX_CHARS + 1) }],
      ["an unknown key", { text: "Brief.", extra: true }],
      ["an empty reference id", { text: "Brief.", referenceDocumentIds: [""] }],
      ["too many references", { text: "Brief.", referenceDocumentIds: Array(101).fill("doc") }],
      ["an empty omitted id", { text: "Brief.", omittedObservationIds: [""] }],
    ])("rejects %s", async (_label, args) => {
      const result = await tool().invoke(args, CTX);
      expect(result).toMatchObject({ kind: "error", code: "invalid_args" });
      expect(port.appendMorningBrief).not.toHaveBeenCalled();
    });

    test("accepts text exactly at the limit", async () => {
      const result = await tool().invoke({ text: "x".repeat(MORNING_BRIEF_MAX_CHARS) }, CTX);
      expect(result.kind).toBe("structured");
    });

    test("a second call reports already_sent", async () => {
      const t = tool();
      await t.invoke({ text: "Brief." }, CTX);
      const again = await t.invoke({ text: "Brief again." }, CTX);
      expect(again).toMatchObject({ kind: "error", code: "already_sent" });
      expect((again as { message: string }).message).toContain("Do not send another");
    });

    test("an unavailable conversation reports conversation_unavailable", async () => {
      const t = buildMorningBriefSendTool(deps({ getPort: () => null }), {
        day: DAY,
        runId: "run_morning",
      });
      expect(await t.invoke({ text: "Brief." }, CTX)).toMatchObject({
        kind: "error",
        code: "conversation_unavailable",
      });
    });
  });
});

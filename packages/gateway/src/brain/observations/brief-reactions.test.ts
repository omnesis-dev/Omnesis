// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Thumbs on a sent brief item over a real store: the interest signal each
 * reaction leaves, the reaction row the clients read, the observation's
 * user action, and the quick-capture note a factual correction becomes.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { InterestEngine } from "../interest/engine.js";
import {
  getBriefItemReaction,
  listInterestSignals,
  listLiveInterestSignals,
} from "../storage/interest.js";
import { markMorningBriefSent, replaceMorningBriefItems } from "../storage/morning-brief-items.js";
import { createObservation, getObservation } from "../storage/observations.js";
import {
  correctionNoteText,
  createBriefItemReactor,
  type BriefNoteCapture,
} from "./brief-reactions.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-07-02T07:00:00.000Z");
const DAY = "2026-07-02";
const MESSAGE = "msg_brief";
const log = createLogger("test").child("brief-reactions");

describe("brief item reactions", () => {
  let path: string;
  let db: Database.Database;
  let now: number;
  let capture: ReturnType<typeof vi.fn<BriefNoteCapture["capture"]>>;
  let notes: BriefNoteCapture | null;
  let react: ReturnType<typeof createBriefItemReactor>;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    now = NOW;
    let n = 0;
    const writeGate = directWriteGate(db);
    const interest = new InterestEngine({
      db,
      writeGate,
      getEmbedder: () => null,
      enabled: () => true,
      clock: () => now,
      idGen: () => `sig${++n}`,
      log,
    });
    capture = vi.fn<BriefNoteCapture["capture"]>(async () => undefined);
    notes = { capture };
    react = createBriefItemReactor({
      db,
      writeGate,
      interest,
      notes: () => notes,
      clock: () => now,
      log,
    });
    createObservation(
      db,
      {
        id: "obs_rent",
        createdByRun: "r",
        summary: "The studio rent invoice is due Friday.",
        why: "Late rent costs a penalty.",
      },
      NOW - 100,
    );
    createObservation(
      db,
      { id: "obs_venue", createdByRun: "r", summary: "The workshop venue moved to the 14th." },
      NOW - 90,
    );
    createObservation(
      db,
      { id: "obs_unsent", createdByRun: "r", summary: "A points balance expires soon." },
      NOW - 80,
    );
    replaceMorningBriefItems(db, DAY, "run_morning", ["obs_rent", "obs_venue"]);
    markMorningBriefSent(
      db,
      { day: DAY, runId: "run_morning", conversationId: "conv_brief", messageId: MESSAGE },
      NOW - 50,
    );
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  const live = () => listLiveInterestSignals(db);
  const userAction = (id: string) => getObservation(db, id)?.userAction;

  test("a thumbs up is a positive signal with the item's text", async () => {
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "up",
    });
    expect(result).toEqual({
      ok: true,
      reaction: { observationId: "obs_rent", reaction: "up", at: new Date(NOW).toISOString() },
    });
    expect(live()).toEqual([
      expect.objectContaining({
        polarity: 1,
        kind: "observation",
        source: "brief_thumbs_up",
        subjectText: "The studio rent invoice is due Friday.\nLate rent costs a penalty.",
        note: null,
        observationId: "obs_rent",
      }),
    ]);
    expect(getBriefItemReaction(db, "obs_rent")).toMatchObject({
      day: DAY,
      messageId: MESSAGE,
      reaction: "up",
      note: null,
      noteId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(userAction("obs_rent")).toBe("thumbs_up");
    expect(capture).not.toHaveBeenCalled();
  });

  test("changing to not interested supersedes the thumbs up and keeps the owner's words", async () => {
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: "up" });
    now = NOW + 1_000;
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "not_interested",
      note: "  I never look at invoices before the weekend.  ",
    });
    expect(result).toEqual({
      ok: true,
      reaction: {
        observationId: "obs_rent",
        reaction: "not_interested",
        note: "I never look at invoices before the weekend.",
        at: new Date(now).toISOString(),
      },
    });
    expect(live()).toEqual([
      expect.objectContaining({
        polarity: -1,
        source: "brief_not_interested",
        note: "I never look at invoices before the weekend.",
        observationId: "obs_rent",
      }),
    ]);
    expect(listInterestSignals(db, { limit: 10 }).map((s) => [s.source, s.supersededAt])).toEqual([
      ["brief_not_interested", null],
      ["brief_thumbs_up", now],
    ]);
    expect(getBriefItemReaction(db, "obs_rent")).toMatchObject({
      reaction: "not_interested",
      createdAt: NOW,
      updatedAt: now,
    });
    expect(userAction("obs_rent")).toBe("not_interested");
  });

  test("a factual error with a correction saves a note and leaves no signal", async () => {
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: "up" });
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "The rent is due Monday, not Friday.",
      noteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result).toEqual({
      ok: true,
      reaction: {
        observationId: "obs_rent",
        reaction: "factual_error",
        note: "The rent is due Monday, not Friday.",
        noteId: "11111111-1111-4111-8111-111111111111",
        at: new Date(NOW).toISOString(),
      },
    });
    expect(live()).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      id: "11111111-1111-4111-8111-111111111111",
      text: correctionNoteText(
        "The studio rent invoice is due Friday.",
        "The rent is due Monday, not Friday.",
      ),
      capturedAt: new Date(NOW).toISOString(),
      surface: "brief",
      fromOwner: true,
    });
    expect(getBriefItemReaction(db, "obs_rent")).toMatchObject({
      reaction: "factual_error",
      noteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(userAction("obs_rent")).toBe("disputed");

    // The same correction sent again is not captured twice.
    const retry = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "The rent is due Monday, not Friday.",
      noteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(retry).toEqual(result);
    expect(capture).toHaveBeenCalledTimes(1);

    // A different correction is a new note.
    await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "It was paid last week.",
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1]![0].id).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(getBriefItemReaction(db, "obs_rent")?.noteId).toBe(capture.mock.calls[1]![0].id);
  });

  test("a factual error without a correction captures nothing", async () => {
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_venue",
      reaction: "factual_error",
    });
    expect(result).toMatchObject({
      ok: true,
      reaction: { observationId: "obs_venue", reaction: "factual_error" },
    });
    expect((result as { reaction: object }).reaction).not.toHaveProperty("noteId");
    expect(capture).not.toHaveBeenCalled();
    expect(live()).toEqual([]);
    expect(userAction("obs_venue")).toBe("disputed");
  });

  test("clearing takes the signal back and removes the row", async () => {
    await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "not_interested",
      note: "Not my thing.",
    });
    now = NOW + 5_000;
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: null,
    });
    expect(result).toEqual({ ok: true, reaction: { observationId: "obs_rent", reaction: null } });
    expect(live()).toEqual([]);
    expect(listInterestSignals(db, { limit: 10 })).toEqual([
      expect.objectContaining({ source: "brief_not_interested", supersededAt: now }),
    ]);
    expect(getBriefItemReaction(db, "obs_rent")).toBeNull();
    expect(userAction("obs_rent")).toBeNull();
  });

  test("an observation that is not an item of that brief is refused", async () => {
    for (const input of [
      { observationId: "obs_unsent" },
      { observationId: "obs_missing" },
      { observationId: "obs_rent", messageId: "msg_other" },
      { observationId: "obs_rent", day: "2026-07-01" },
    ]) {
      const result = await react({
        day: DAY,
        messageId: MESSAGE,
        reaction: "up",
        ...input,
      });
      expect(result, JSON.stringify(input)).toMatchObject({ ok: false, reason: "not_an_item" });
    }
    expect(live()).toEqual([]);
    expect(userAction("obs_rent")).toBeNull();
    expect(userAction("obs_unsent")).toBeNull();
  });

  test("a correction with no notes runtime is refused and nothing changes", async () => {
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: "up" });
    notes = null;
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "The rent is due Monday.",
    });
    expect(result).toMatchObject({ ok: false, reason: "notes_unavailable" });
    expect(live()).toEqual([expect.objectContaining({ source: "brief_thumbs_up" })]);
    expect(getBriefItemReaction(db, "obs_rent")?.reaction).toBe("up");
    expect(userAction("obs_rent")).toBe("thumbs_up");
    expect(capture).not.toHaveBeenCalled();
  });
});

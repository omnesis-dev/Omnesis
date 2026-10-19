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
  insertInterestSignal,
  listInterestSignals,
  listLiveInterestSignals,
} from "../storage/interest.js";
import { markMorningBriefSent, replaceMorningBriefItems } from "../storage/morning-brief-items.js";
import { createObservation, getObservation } from "../storage/observations.js";
import {
  correctionNoteId,
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
  let enabled: boolean;
  let capture: ReturnType<typeof vi.fn<BriefNoteCapture["capture"]>>;
  let notes: BriefNoteCapture | null;
  let react: ReturnType<typeof createBriefItemReactor>;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    now = NOW;
    enabled = true;
    let n = 0;
    const writeGate = directWriteGate(db);
    const interest = new InterestEngine({
      db,
      writeGate,
      getEmbedder: () => null,
      enabled: () => enabled,
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

  test("a statement that cites the item survives a changed or cleared thumbs", async () => {
    insertInterestSignal(db, {
      id: "sig_statement",
      polarity: -1,
      kind: "statement",
      source: "statement",
      subjectText: "rent reminders",
      note: "Stop telling me about rent.",
      observationId: "obs_rent",
      createdAt: NOW - 10,
    });
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: "up" });
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: null });
    expect(live().map((s) => s.id)).toEqual(["sig_statement"]);
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

  test("a factual error with a correction saves a note under a derived id and leaves no signal", async () => {
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: "up" });
    const noteId = correctionNoteId("obs_rent", "The rent is due Monday, not Friday.");
    expect(noteId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "  The rent is due Monday, not Friday.  ",
    });
    expect(result).toEqual({
      ok: true,
      reaction: {
        observationId: "obs_rent",
        reaction: "factual_error",
        note: "The rent is due Monday, not Friday.",
        noteId,
        at: new Date(NOW).toISOString(),
      },
    });
    expect(live()).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      id: noteId,
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
      noteId,
    });
    expect(userAction("obs_rent")).toBe("disputed");

    // The same correction sent again, however padded, is not captured twice.
    const retry = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "The rent is due Monday, not Friday.   ",
    });
    expect(retry).toEqual(result);
    expect(capture).toHaveBeenCalledTimes(1);

    // Different words, even only in their case, are a new note.
    await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "The rent is due monday, not friday.",
    });
    const recased = correctionNoteId("obs_rent", "The rent is due monday, not friday.");
    expect(recased).not.toBe(noteId);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1]![0].id).toBe(recased);
    expect(getBriefItemReaction(db, "obs_rent")?.noteId).toBe(recased);
    // The same correction on another item is another note.
    expect(correctionNoteId("obs_venue", "The rent is due Monday, not Friday.")).not.toBe(noteId);
  });

  test("a correction the notes runtime rejects is refused and nothing changes", async () => {
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: "up" });
    capture.mockRejectedValueOnce(new Error("the notes ledger is closed"));
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "factual_error",
      note: "The rent is due Monday.",
    });
    expect(result).toEqual({
      ok: false,
      reason: "notes_unavailable",
      message: "the correction could not be saved: notes are unavailable",
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(live()).toEqual([expect.objectContaining({ source: "brief_thumbs_up" })]);
    expect(getBriefItemReaction(db, "obs_rent")).toMatchObject({ reaction: "up", noteId: null });
    expect(userAction("obs_rent")).toBe("thumbs_up");
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM interest_signals").get()!.n,
    ).toBe(1);
  });

  test("while the ledger is off a thumbs still lands its row and user action, writes no signal, and takes the previous one back", async () => {
    await react({ day: DAY, messageId: MESSAGE, observationId: "obs_rent", reaction: "up" });
    expect(live()).toHaveLength(1);
    enabled = false;
    now = NOW + 2_000;
    const result = await react({
      day: DAY,
      messageId: MESSAGE,
      observationId: "obs_rent",
      reaction: "not_interested",
      note: "Not this month.",
    });
    expect(result).toEqual({
      ok: true,
      reaction: {
        observationId: "obs_rent",
        reaction: "not_interested",
        note: "Not this month.",
        at: new Date(now).toISOString(),
      },
    });
    expect(live()).toEqual([]);
    expect(listInterestSignals(db, { limit: 10 })).toEqual([
      expect.objectContaining({ source: "brief_thumbs_up", supersededAt: now }),
    ]);
    expect(getBriefItemReaction(db, "obs_rent")).toMatchObject({
      reaction: "not_interested",
      note: "Not this month.",
      updatedAt: now,
    });
    expect(userAction("obs_rent")).toBe("not_interested");
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

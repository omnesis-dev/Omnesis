// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Morning brief item lists over a real gateway store: an unsent day's list
 * is replaceable, a sent one is history; sending is once per day and ships
 * exactly the ranked observations that are still open.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  getSentMorningBrief,
  latestSentMorningBrief,
  listMorningBriefItems,
  listMorningBriefItemsForMessage,
  markMorningBriefSent,
  morningBriefSent,
  replaceMorningBriefItems,
} from "./morning-brief-items.js";
import { createObservation, getObservation, transitionObservation } from "./observations.js";
import type Database from "better-sqlite3";

const T0 = Date.parse("2026-07-02T07:00:00.000Z");
const DAY1 = "2026-07-02";
const DAY2 = "2026-07-03";

describe("morning brief items", () => {
  let path: string;
  let db: Database.Database;

  function note(id: string) {
    createObservation(db, { id, createdByRun: "run_note", summary: `Observation ${id}` }, T0);
  }

  function send(day: string, messageId: string, now = T0 + 100) {
    return markMorningBriefSent(
      db,
      { day, runId: `run_${day}`, conversationId: "conv_brief", messageId },
      now,
    );
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    for (const id of ["obs_1", "obs_2", "obs_3", "obs_4"]) note(id);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("replace writes ranks from 1 in the given order and replaces an unsent list", () => {
    expect(replaceMorningBriefItems(db, DAY1, "run_a", ["obs_2", "obs_1"])).toBe(true);
    expect(listMorningBriefItems(db, DAY1)).toEqual([
      {
        day: DAY1,
        rank: 1,
        observationId: "obs_2",
        runId: "run_a",
        conversationId: null,
        messageId: null,
      },
      {
        day: DAY1,
        rank: 2,
        observationId: "obs_1",
        runId: "run_a",
        conversationId: null,
        messageId: null,
      },
    ]);
    expect(replaceMorningBriefItems(db, DAY1, "run_b", ["obs_3"])).toBe(true);
    expect(listMorningBriefItems(db, DAY1).map((i) => [i.rank, i.observationId, i.runId])).toEqual([
      [1, "obs_3", "run_b"],
    ]);
    expect(replaceMorningBriefItems(db, DAY1, "run_c", [])).toBe(true);
    expect(listMorningBriefItems(db, DAY1)).toEqual([]);
  });

  test("days are independent", () => {
    replaceMorningBriefItems(db, DAY1, "run_a", ["obs_1"]);
    replaceMorningBriefItems(db, DAY2, "run_b", ["obs_2"]);
    expect(listMorningBriefItems(db, DAY1).map((i) => i.observationId)).toEqual(["obs_1"]);
    expect(listMorningBriefItems(db, DAY2).map((i) => i.observationId)).toEqual(["obs_2"]);
  });

  test("a sent day's list is history: replace is refused and leaves it untouched", () => {
    replaceMorningBriefItems(db, DAY1, "run_a", ["obs_1", "obs_2"]);
    expect(send(DAY1, "msg_1").ok).toBe(true);
    expect(replaceMorningBriefItems(db, DAY1, "run_b", ["obs_3"])).toBe(false);
    expect(listMorningBriefItems(db, DAY1).map((i) => i.observationId)).toEqual(["obs_1", "obs_2"]);
  });

  test("sending ships exactly the ranked observations and stamps the list with the message", () => {
    replaceMorningBriefItems(db, DAY1, "run_a", ["obs_3", "obs_1"]);
    const result = send(DAY1, "msg_1", T0 + 500);
    expect(result).toEqual({ ok: true, shippedObservationIds: ["obs_3", "obs_1"] });
    for (const id of ["obs_3", "obs_1"])
      expect(getObservation(db, id)).toMatchObject({
        state: "shipped",
        shippedAt: T0 + 500,
        shippedConversationId: "conv_brief",
        shippedMessageId: "msg_1",
        closedAt: T0 + 500,
      });
    for (const id of ["obs_2", "obs_4"]) expect(getObservation(db, id)?.state).toBe("live");
    expect(listMorningBriefItemsForMessage(db, "msg_1")).toEqual([
      {
        day: DAY1,
        rank: 1,
        observationId: "obs_3",
        runId: "run_a",
        conversationId: "conv_brief",
        messageId: "msg_1",
      },
      {
        day: DAY1,
        rank: 2,
        observationId: "obs_1",
        runId: "run_a",
        conversationId: "conv_brief",
        messageId: "msg_1",
      },
    ]);
    expect(getSentMorningBrief(db, DAY1)).toEqual({
      day: DAY1,
      runId: `run_${DAY1}`,
      conversationId: "conv_brief",
      messageId: "msg_1",
      itemCount: 2,
      sentAt: T0 + 500,
    });
    expect(morningBriefSent(db, DAY1)).toBe(true);
    expect(morningBriefSent(db, DAY2)).toBe(false);
  });

  test("a second send for the same day is refused and changes nothing", () => {
    replaceMorningBriefItems(db, DAY1, "run_a", ["obs_1"]);
    send(DAY1, "msg_1", T0 + 100);
    expect(send(DAY1, "msg_again", T0 + 200)).toEqual({ ok: false, reason: "already_sent" });
    expect(getSentMorningBrief(db, DAY1)).toMatchObject({ messageId: "msg_1", sentAt: T0 + 100 });
    expect(listMorningBriefItemsForMessage(db, "msg_again")).toEqual([]);
  });

  test("a listed observation closed before the send is not shipped, but stays on the list", () => {
    replaceMorningBriefItems(db, DAY1, "run_a", ["obs_1", "obs_2"]);
    transitionObservation(db, "obs_2", { state: "dropped", reason: "suppressed" }, T0 + 50);
    expect(send(DAY1, "msg_1")).toEqual({ ok: true, shippedObservationIds: ["obs_1"] });
    expect(getObservation(db, "obs_2")).toMatchObject({
      state: "dropped",
      closeReason: "suppressed",
      shippedMessageId: null,
    });
    expect(getSentMorningBrief(db, DAY1)?.itemCount).toBe(2);
  });

  test("a held observation on the list ships", () => {
    transitionObservation(db, "obs_1", { state: "held", reason: "below_bar" }, T0 + 1);
    replaceMorningBriefItems(db, DAY1, "run_a", ["obs_1"]);
    expect(send(DAY1, "msg_1")).toEqual({ ok: true, shippedObservationIds: ["obs_1"] });
  });

  test("a day with no items still records its send", () => {
    expect(send(DAY1, "msg_empty")).toEqual({ ok: true, shippedObservationIds: [] });
    expect(getSentMorningBrief(db, DAY1)?.itemCount).toBe(0);
    expect(replaceMorningBriefItems(db, DAY1, "run_late", ["obs_1"])).toBe(false);
  });

  test("latestSentMorningBrief returns the newest sent day", () => {
    expect(latestSentMorningBrief(db)).toBeNull();
    expect(getSentMorningBrief(db, DAY1)).toBeNull();
    send(DAY2, "msg_2", T0 + 10);
    send(DAY1, "msg_1", T0 + 20);
    expect(latestSentMorningBrief(db)).toMatchObject({ day: DAY2, messageId: "msg_2" });
  });
});

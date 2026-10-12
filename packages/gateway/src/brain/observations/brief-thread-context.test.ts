// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { transitionObservation, createObservation } from "../storage/observations.js";
import { markMorningBriefSent, replaceMorningBriefItems } from "../storage/morning-brief-items.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { renderDailyBriefContext } from "./brief-thread-context.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-07-02T07:00:00.000Z");
const DAY = "2026-07-02";

describe("renderDailyBriefContext", () => {
  let path: string;
  let db: Database.Database;

  function send(observationIds: string[], messageId = "msg_1") {
    replaceMorningBriefItems(db, DAY, "run_morning", observationIds);
    markMorningBriefSent(
      db,
      { day: DAY, runId: "run_morning", conversationId: "conv_brief", messageId },
      NOW,
    );
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    createOpenLoop(
      db,
      {
        id: "loop_rent",
        createdByRun: "r",
        title: "Pay the studio rent",
        confidence: 0.9,
        importance: 0.8,
      },
      NOW,
    );
    createOpenLoop(
      db,
      {
        id: "loop_permit",
        createdByRun: "r",
        title: "Renew the parking permit",
        confidence: 0.9,
        importance: 0.5,
        state: "snoozed",
      },
      NOW,
    );
    createObservation(
      db,
      {
        id: "obs_rent",
        createdByRun: "r",
        summary: "The studio rent invoice is due Friday.",
        relatedLoopIds: ["loop_rent", "loop_permit", "loop_gone"],
      },
      NOW - 10,
    );
    createObservation(
      db,
      { id: "obs_venue", createdByRun: "r", summary: "The workshop venue moved to the 14th." },
      NOW - 5,
    );
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("lists the brief's items in rank order with their related tasks", () => {
    send(["obs_venue", "obs_rent"]);
    const text = renderDailyBriefContext(db, { day: DAY, messageId: "msg_1" });
    expect(text).toContain("## The Morning brief conversation");
    expect(text).toContain(`the brief you sent on ${DAY}`);
    expect(text).toContain(
      "Its items, in the order you wrote them:\n" +
        "1. [obs_venue] The workshop venue moved to the 14th.\n" +
        '2. [obs_rent] The studio rent invoice is due Friday. — tasks: loop_permit "Renew the parking permit" (snoozed); loop_rent "Pay the studio rent" (open)',
    );
    // A related loop that no longer exists is left out.
    expect(text).not.toContain("loop_gone");
    expect(text).not.toContain("carried no ranked items");
    expect(text).toContain("resolve it from this list");
  });

  test("an item without related loops has no task suffix", () => {
    send(["obs_venue"]);
    const text = renderDailyBriefContext(db, { day: DAY, messageId: "msg_1" });
    expect(text).toContain("1. [obs_venue] The workshop venue moved to the 14th.\n");
    expect(text).not.toContain("— tasks:");
  });

  test("a brief with no ranked items says so", () => {
    send([]);
    const text = renderDailyBriefContext(db, { day: DAY, messageId: "msg_1" });
    expect(text).toContain("That brief carried no ranked items, only the calendar and due tasks.");
    expect(text).not.toContain("Its items");
  });

  test("an item whose observation was deleted is skipped, keeping the others' ranks", () => {
    send(["obs_venue", "obs_rent"]);
    db.prepare("DELETE FROM observations WHERE id = 'obs_venue'").run();
    const text = renderDailyBriefContext(db, { day: DAY, messageId: "msg_1" });
    expect(text).not.toContain("obs_venue");
    expect(text).toContain("2. [obs_rent]");
  });

  test("an item left out of the brief takes no number", () => {
    transitionObservation(db, "obs_venue", { state: "dropped", reason: "suppressed" }, NOW);
    send(["obs_venue", "obs_rent"]);
    const text = renderDailyBriefContext(db, { day: DAY, messageId: "msg_1" });
    expect(text).not.toContain("obs_venue");
    expect(text).toContain("1. [obs_rent]");
  });

  test("another message's items are not shown", () => {
    send(["obs_venue"]);
    const text = renderDailyBriefContext(db, { day: DAY, messageId: "msg_other" });
    expect(text).toContain("carried no ranked items");
  });
});

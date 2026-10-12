// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { createObservation, transitionObservation } from "../storage/observations.js";
import { markMorningBriefSent, replaceMorningBriefItems } from "../storage/morning-brief-items.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { readDailyBriefDetail, shippedBriefItems } from "./brief-detail.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-07-02T06:02:40.055Z");
const DAY = "2026-07-02";

describe("morning brief detail", () => {
  let path: string;
  let db: Database.Database;

  function insertDoc(id: string, sourceId: string, title: string, createdAt: string) {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
         source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'p', ?, ?, ?, 'body', 'h', ?, ?, ?, ?)`,
    ).run(id, sourceId, id, title, createdAt, createdAt, createdAt, createdAt);
  }

  function send(observationIds: string[], messageId = "msg_1", day = DAY) {
    replaceMorningBriefItems(db, day, "run_morning", observationIds);
    markMorningBriefSent(
      db,
      { day, runId: "run_morning", conversationId: "conv_brief", messageId },
      NOW,
    );
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    insertDoc("doc_offer", "gmail:work", "Loan offer letter", "2026-06-28T09:00:00.000Z");
    insertDoc("doc_untitled", "notion:home", "", "2026-06-29T10:30:00.000Z");
    createOpenLoop(
      db,
      {
        id: "loop_boiler",
        createdByRun: "r",
        title: "Book the boiler engineer",
        confidence: 0.9,
        importance: 0.8,
      },
      NOW - 100,
    );
    createObservation(
      db,
      {
        id: "obs_offer",
        createdByRun: "r",
        summary: "The loan offer expires on Friday.",
        citations: ["doc_offer", "doc_deleted", "doc_untitled"],
        relatedLoopIds: ["loop_boiler", "loop_gone"],
      },
      NOW - 10,
    );
    createObservation(
      db,
      { id: "obs_venue", createdByRun: "r", summary: "The workshop venue moved to the 14th." },
      NOW - 5,
    );
    createObservation(
      db,
      { id: "obs_points", createdByRun: "r", summary: "Loyalty points expire this quarter." },
      NOW - 4,
    );
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("lists the shipped items in order with their surviving sources and tasks", () => {
    send(["obs_offer", "obs_venue"]);
    expect(readDailyBriefDetail(db, { day: DAY, messageId: "msg_1" })).toEqual({
      sentAt: "2026-07-02T06:02:40.055Z",
      items: [
        {
          rank: 1,
          observationId: "obs_offer",
          summary: "The loan offer expires on Friday.",
          sources: [
            {
              id: "doc_offer",
              title: "Loan offer letter",
              sourceType: "gmail",
              createdAt: "2026-06-28T09:00:00.000Z",
            },
            {
              id: "doc_untitled",
              title: null,
              sourceType: "notion",
              createdAt: "2026-06-29T10:30:00.000Z",
            },
          ],
          tasks: [{ id: "loop_boiler", title: "Book the boiler engineer", state: "open" }],
        },
        {
          rank: 2,
          observationId: "obs_venue",
          summary: "The workshop venue moved to the 14th.",
          sources: [],
          tasks: [],
        },
      ],
    });
  });

  test("a task reads its current title and state", () => {
    send(["obs_offer"]);
    db.prepare(
      "UPDATE open_loops SET title = 'Call the boiler engineer', state = 'done' WHERE id = 'loop_boiler'",
    ).run();
    const [item] = readDailyBriefDetail(db, { day: DAY, messageId: "msg_1" }).items;
    expect(item!.tasks).toEqual([
      { id: "loop_boiler", title: "Call the boiler engineer", state: "done" },
    ]);
  });

  test("an item the composition left out is absent and takes no number", () => {
    transitionObservation(db, "obs_points", { state: "dropped", reason: "suppressed" }, NOW);
    send(["obs_points", "obs_venue"]);
    expect(
      readDailyBriefDetail(db, { day: DAY, messageId: "msg_1" }).items.map((i) => [
        i.rank,
        i.observationId,
      ]),
    ).toEqual([[1, "obs_venue"]]);
  });

  test("an observation deleted since keeps its place in the numbering", () => {
    send(["obs_venue", "obs_offer"]);
    db.prepare("DELETE FROM observations WHERE id = 'obs_venue'").run();
    expect(shippedBriefItems(db, "msg_1").map((i) => [i.rank, i.observation.id])).toEqual([
      [2, "obs_offer"],
    ]);
  });

  test("another message's brief has no items and no recorded send", () => {
    send(["obs_venue"]);
    expect(readDailyBriefDetail(db, { day: DAY, messageId: "msg_other" })).toEqual({
      sentAt: null,
      items: [],
    });
  });

  test("a day with no recorded send still lists the message's items", () => {
    send(["obs_venue"]);
    expect(readDailyBriefDetail(db, { day: "2026-07-01", messageId: "msg_1" })).toMatchObject({
      sentAt: null,
      items: [{ observationId: "obs_venue" }],
    });
  });
});

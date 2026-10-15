// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The morning brief's input packet: ranked item lines rendered from the day's
 * list, and `hasInputs`, which is true only when the horizon, the ranked
 * observations or loops coming due have something in them.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { createObservation } from "../storage/observations.js";
import { markMorningBriefSent, replaceMorningBriefItems } from "../storage/morning-brief-items.js";
import { applyTaskCommand, autoApplyTaskChange, readTaskAuthorship } from "../storage/tasks.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { cognitionSpendDay } from "../storage/spend.js";
import { resolveBrainSettings } from "../config.js";
import {
  readDigestInputs,
  renderAutoAppliedTaskLines,
  renderMorningBriefItemLines,
} from "./digest-inputs.js";
import type { DigestHorizon } from "./digest-horizon.js";
import type { TemporalItem } from "@omnesis/core";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 86_400_000;
const TODAY = "2026-07-02";

let path: string;
let db: Database.Database;

const EMPTY_HORIZON: DigestHorizon = { items: [], timeZone: "UTC", truncated: false };

function horizonWith(label: string): DigestHorizon {
  const item: TemporalItem = {
    id: "proj_1",
    origin: "projection",
    start: new Date(NOW + DAY).toISOString(),
    endExclusive: new Date(NOW + DAY + 3_600_000).toISOString(),
    precision: "instant",
    allDay: false,
    label,
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
  return { items: [item], timeZone: "UTC", truncated: false };
}

function insertDoc(externalId: string, title: string): string {
  upsertDocuments(db, [
    {
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail-test"),
      externalId,
      title,
      content: `Body of ${title}`,
      contentHash: `h-${externalId}`,
      sourceCreatedAt: "2026-07-01T09:00:00.000Z",
      sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
      metadata: { documentType: "email" },
    },
  ]);
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

const settings = () => resolveBrainSettings();

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

describe("renderMorningBriefItemLines", () => {
  test("is empty when the day has no list", () => {
    expect(renderMorningBriefItemLines(db, TODAY)).toEqual([]);
  });

  test("renders rank, id, summary, why, window and titled sources in rank order", () => {
    const doc = insertDoc("m1", "Studio Northstar renewal");
    createObservation(
      db,
      {
        id: "obs_a",
        createdByRun: "run_note",
        summary: "The studio lease renewal form is due Friday.",
        why: "Missing it ends the lease.",
        windowStart: Date.parse("2026-07-03T00:00:00.000Z"),
        relevantUntil: Date.parse("2026-07-04T00:00:00.000Z"),
        citations: [doc, "doc_missing"],
      },
      NOW,
    );
    createObservation(
      db,
      { id: "obs_b", createdByRun: "run_note", summary: "A parcel is waiting." },
      NOW,
    );
    replaceMorningBriefItems(db, TODAY, "run_morning", ["obs_b", "obs_a"]);
    expect(renderMorningBriefItemLines(db, TODAY)).toEqual([
      "1. [obs_b] A parcel is waiting.",
      `2. [obs_a] The studio lease renewal form is due Friday. — why: Missing it ends the lease. — from 2026-07-03T00:00:00.000Z, until 2026-07-04T00:00:00.000Z — sources: Studio Northstar renewal (${doc}); untitled (doc_missing)`,
    ]);
  });

  test("renders a one-sided window", () => {
    createObservation(
      db,
      {
        id: "obs_until",
        createdByRun: "r",
        summary: "Until only.",
        relevantUntil: Date.parse("2026-07-05T00:00:00.000Z"),
      },
      NOW,
    );
    createObservation(
      db,
      {
        id: "obs_from",
        createdByRun: "r",
        summary: "From only.",
        windowStart: Date.parse("2026-07-06T00:00:00.000Z"),
      },
      NOW,
    );
    replaceMorningBriefItems(db, TODAY, "r", ["obs_until", "obs_from"]);
    expect(renderMorningBriefItemLines(db, TODAY)).toEqual([
      "1. [obs_until] Until only. — until 2026-07-05T00:00:00.000Z",
      "2. [obs_from] From only. — from 2026-07-06T00:00:00.000Z",
    ]);
  });

  test("skips an item whose observation no longer exists", () => {
    createObservation(db, { id: "obs_kept", createdByRun: "r", summary: "Kept." }, NOW);
    replaceMorningBriefItems(db, TODAY, "r", ["obs_gone", "obs_kept"]);
    expect(renderMorningBriefItemLines(db, TODAY)).toEqual(["2. [obs_kept] Kept."]);
  });

  test("reads only the requested day", () => {
    createObservation(db, { id: "obs_y", createdByRun: "r", summary: "Yesterday." }, NOW);
    replaceMorningBriefItems(db, "2026-07-01", "r", ["obs_y"]);
    expect(renderMorningBriefItemLines(db, TODAY)).toEqual([]);
  });
});

describe("readDigestInputs", () => {
  test("nothing anywhere: no inputs", () => {
    const inputs = readDigestInputs(db, NOW, settings(), EMPTY_HORIZON, TODAY);
    expect(inputs).toMatchObject({ horizonLines: [], itemLines: [], hasInputs: false });
  });

  test("a horizon entry alone is an input", () => {
    const inputs = readDigestInputs(db, NOW, settings(), horizonWith("Dentist visit"), TODAY);
    expect(inputs.horizonLines).toHaveLength(1);
    expect(inputs.horizonLines[0]).toContain("Dentist visit");
    expect(inputs.hasInputs).toBe(true);
  });

  test("a ranked observation alone is an input", () => {
    createObservation(db, { id: "obs_1", createdByRun: "r", summary: "Ranked." }, NOW);
    replaceMorningBriefItems(db, TODAY, "r", ["obs_1"]);
    const inputs = readDigestInputs(db, NOW, settings(), EMPTY_HORIZON, TODAY);
    expect(inputs.itemLines).toEqual(["1. [obs_1] Ranked."]);
    expect(inputs.hasInputs).toBe(true);
  });

  test("an open observation not on today's list is not an input", () => {
    createObservation(db, { id: "obs_unranked", createdByRun: "r", summary: "Held back." }, NOW);
    expect(readDigestInputs(db, NOW, settings(), EMPTY_HORIZON, TODAY).hasInputs).toBe(false);
  });

  test("a loop coming due alone is an input", () => {
    createOpenLoop(
      db,
      {
        id: "loop_due",
        createdByRun: "r",
        title: "Return the library books",
        confidence: 0.8,
        importance: 0.5,
        deadline: cognitionSpendDay(NOW),
      },
      NOW - 20 * DAY,
    );
    const inputs = readDigestInputs(db, NOW, settings(), EMPTY_HORIZON, TODAY);
    expect(inputs.deltaPrime).toContain("Return the library books");
    expect(inputs.hasInputs).toBe(true);
  });

  test("a loop merely touched recently is context, never a reason to send", () => {
    createOpenLoop(
      db,
      {
        id: "loop_touched",
        createdByRun: "r",
        title: "Compare insurance quotes",
        confidence: 0.8,
        importance: 0.5,
      },
      NOW - 3_600_000,
    );
    const inputs = readDigestInputs(db, NOW, settings(), EMPTY_HORIZON, TODAY);
    expect(inputs.deltaPrime).toContain("Compare insurance quotes");
    expect(inputs.hasInputs).toBe(false);
  });
});

describe("renderAutoAppliedTaskLines", () => {
  function userTask(id: string, title: string, at: number): void {
    applyTaskCommand(
      db,
      { surface: "tasks", runId: "user:tasks", kind: "create", id, origin: "user", title },
      at,
    );
  }

  function autoComplete(id: string, reason: string, at: number): number {
    const result = autoApplyTaskChange(
      db,
      id,
      {
        kind: "complete",
        reason,
        evidence: [],
        runId: "run_1",
        basedOnSeq: readTaskAuthorship(db, id).latestEventSeq,
      },
      at,
    );
    if (!result.applied) throw new Error(`not applied: ${result.reason}`);
    return result.seq;
  }

  test("lists the changes since the last brief, leaving out undone ones", () => {
    userTask("loop_old", "Renew the bike insurance", NOW - 3 * DAY);
    autoComplete("loop_old", "The insurer confirmed the renewal.", NOW - 2 * DAY);
    markMorningBriefSent(
      db,
      { day: "2026-07-01", runId: "r", conversationId: "c", messageId: "m" },
      NOW - DAY,
    );
    userTask("loop_paid", "Pay the window cleaner", NOW - 3 * DAY);
    autoComplete("loop_paid", "The receipt says it was paid in full.", NOW - 3_600_000);
    userTask("loop_undone", "Return the hedge trimmer", NOW - 3 * DAY);
    const seq = autoComplete("loop_undone", "The library logged the return.", NOW - 1_800_000);
    applyTaskCommand(
      db,
      { surface: "tasks", runId: "user:tasks", kind: "undo", seq },
      NOW - 900_000,
    );

    expect(renderAutoAppliedTaskLines(db, NOW)).toEqual([
      "- Marked done: Pay the window cleaner — The receipt says it was paid in full.",
    ]);
    // Context for the brief, never a reason to send one.
    const inputs = readDigestInputs(db, NOW, settings(), EMPTY_HORIZON, TODAY);
    expect(inputs.autoAppliedLines).toHaveLength(1);
    expect(inputs.hasInputs).toBe(false);
  });

  test("before the first brief, looks back one day", () => {
    userTask("loop_a", "Book the bike service", NOW - 3 * DAY);
    autoComplete("loop_a", "The shop confirmed the booking.", NOW - 2 * DAY);
    userTask("loop_b", "Send the Q4 budget review", NOW - 3 * DAY);
    autoComplete("loop_b", "The review was sent.", NOW - 3_600_000);
    expect(renderAutoAppliedTaskLines(db, NOW)).toEqual([
      "- Marked done: Send the Q4 budget review — The review was sent.",
    ]);
  });
});

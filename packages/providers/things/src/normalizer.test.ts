// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { thingsDateToString, unixToISO, normalizeTask } from "./normalizer.js";
import type { RawThingsTask, RawThingsChecklistItem } from "./types.js";

describe("thingsDateToString", () => {
  test("decodes 2026-03-08", () => {
    // 2026 << 16 | 3 << 12 | 8 << 7 = 132776960 + 12288 + 1024 = 132790272
    const encoded = (2026 << 16) | (3 << 12) | (8 << 7);
    expect(thingsDateToString(encoded)).toBe("2026-03-08");
  });

  test("decodes 2025-12-25", () => {
    const encoded = (2025 << 16) | (12 << 12) | (25 << 7);
    expect(thingsDateToString(encoded)).toBe("2025-12-25");
  });

  test("pads single-digit month and day", () => {
    const encoded = (2024 << 16) | (1 << 12) | (5 << 7);
    expect(thingsDateToString(encoded)).toBe("2024-01-05");
  });
});

describe("unixToISO", () => {
  test("converts Unix timestamp to ISO string", () => {
    expect(unixToISO(1709856000)).toBe("2024-03-08T00:00:00.000Z");
  });

  test("converts epoch 0", () => {
    expect(unixToISO(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("normalizeTask", () => {
  const baseTask: RawThingsTask = {
    uuid: "test-uuid-1",
    title: "Buy groceries",
    notes: null,
    type: 0,
    status: 0,
    trashed: 0,
    creationDate: 1709856000,
    userModificationDate: 1709856000,
    startDate: null,
    deadline: null,
    stopDate: null,
    start: 1,
    project: null,
    area: null,
    heading: null,
  };

  test("normalizes a simple task", () => {
    const doc = normalizeTask(baseTask, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.title).toBe("Buy groceries");
    expect(doc.externalId).toBe("test-uuid-1");
    expect(doc.providerId).toBe(ProviderId("things"));
    expect(doc.sourceId).toBe(SourceId("things"));
    expect(doc.content).toContain("# Buy groceries");
    expect(doc.content).toContain("Status: Open");
    expect(doc.metadata.sourceUrl).toBe("things:///show?id=test-uuid-1");
    expect(doc.metadata.documentType).toBe("task");
    expect(doc.metadata.status).toBe("open");
    expect(doc.metadata.people).toEqual([{ role: "author", isSelf: true }]);
    expect(doc.contentHash).toBeDefined();
  });

  test("attributes every doc to self via isSelf primitive", () => {
    // Things has no per-task author — single-user-per-DB. Every normalized
    // doc must carry exactly one author mention with isSelf: true so the
    // gateway resolves it to the canonical self person at write time.
    const doc = normalizeTask(baseTask, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.metadata.people).toEqual([{ role: "author", isSelf: true }]);
  });

  test("normalizes a project", () => {
    const project = { ...baseTask, type: 1, title: "Home Renovation" };
    const doc = normalizeTask(project, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.metadata.documentType).toBe("project");
    expect(doc.content).toContain("# Home Renovation");
  });

  test("includes notes in content", () => {
    const task = { ...baseTask, notes: "Get milk and eggs" };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.content).toContain("Get milk and eggs");
  });

  test("renders checklist items", () => {
    const checklist: RawThingsChecklistItem[] = [
      { uuid: "c1", title: "Milk", status: 3, task: "test-uuid-1", index: 0 },
      { uuid: "c2", title: "Eggs", status: 0, task: "test-uuid-1", index: 1 },
    ];
    const doc = normalizeTask(
      baseTask,
      checklist,
      null,
      null,
      ProviderId("things"),
      SourceId("things"),
    );
    expect(doc.content).toContain("## Checklist");
    expect(doc.content).toContain("- [x] Milk");
    expect(doc.content).toContain("- [ ] Eggs");
    expect(doc.metadata.extra?.checklistTotal).toBe(2);
    expect(doc.metadata.extra?.checklistDone).toBe(1);
  });

  test("includes deadline and scheduled dates", () => {
    const deadline = (2026 << 16) | (3 << 12) | (15 << 7);
    const startDate = (2026 << 16) | (3 << 12) | (10 << 7);
    const task = { ...baseTask, deadline, startDate };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.content).toContain("Deadline: 2026-03-15");
    expect(doc.content).toContain("Scheduled: 2026-03-10");
    expect(doc.metadata.extra?.deadline).toBe("2026-03-15");
    expect(doc.metadata.extra?.scheduled).toBe("2026-03-10");
  });

  test("promotes startDate/deadline to typed scheduledAt/dueAt fields", () => {
    // A task planned for the 10th, hard-due by the 15th — kept as two
    // distinct typed dates (not collapsed), while the display strings in
    // `extra` and the prose stay intact.
    const deadline = (2026 << 16) | (3 << 12) | (15 << 7);
    const startDate = (2026 << 16) | (3 << 12) | (10 << 7);
    const task = { ...baseTask, deadline, startDate };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.metadata.scheduledAt).toBe("2026-03-10");
    expect(doc.metadata.dueAt).toBe("2026-03-15");
    // Existing display strings + prose remain for rendering.
    expect(doc.metadata.extra?.scheduled).toBe("2026-03-10");
    expect(doc.metadata.extra?.deadline).toBe("2026-03-15");
    expect(doc.content).toContain("Scheduled: 2026-03-10");
    expect(doc.content).toContain("Deadline: 2026-03-15");
  });

  test("scheduledAt is set from a scheduled-only task (no deadline)", () => {
    // Mirrors the canonical self-reminder case: a task scheduled for a
    // future day with no hard deadline still gets a typed scheduled date.
    const startDate = (2026 << 16) | (7 << 12) | (4 << 7);
    const task = { ...baseTask, title: "Renew the parking permit", startDate };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.metadata.scheduledAt).toBe("2026-07-04");
    expect(doc.metadata.dueAt).toBeUndefined();
  });

  test("dueAt is set from a deadline-only task (no scheduled start)", () => {
    const deadline = (2026 << 16) | (7 << 12) | (4 << 7);
    const task = { ...baseTask, deadline };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.metadata.dueAt).toBe("2026-07-04");
    expect(doc.metadata.scheduledAt).toBeUndefined();
  });

  test("omits scheduledAt/dueAt when the task carries no dates", () => {
    const doc = normalizeTask(baseTask, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.metadata.scheduledAt).toBeUndefined();
    expect(doc.metadata.dueAt).toBeUndefined();
  });

  test("includes project and area titles", () => {
    const doc = normalizeTask(
      baseTask,
      [],
      "Home Reno",
      "Personal",
      ProviderId("things"),
      SourceId("things"),
    );
    expect(doc.content).toContain("Project: Home Reno");
    expect(doc.content).toContain("Area: Personal");
    expect(doc.metadata.extra?.project).toBe("Home Reno");
    expect(doc.metadata.extra?.area).toBe("Personal");
    expect(doc.metadata.tags).toEqual(["Personal"]);
  });

  test("shows completed status", () => {
    const task = { ...baseTask, status: 3 };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.content).toContain("Status: Completed");
    expect(doc.metadata.status).toBe("completed");
    expect(doc.metadata.extra?.status).toBe("completed");
  });

  test("shows canceled status", () => {
    const task = { ...baseTask, status: 2 };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.content).toContain("Status: Canceled");
    expect(doc.metadata.status).toBe("canceled");
  });

  test("uses Untitled for null title", () => {
    const task = { ...baseTask, title: null };
    const doc = normalizeTask(task, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.title).toBe("Untitled");
  });

  test("sets sourceCreatedAt and sourceUpdatedAt", () => {
    const doc = normalizeTask(baseTask, [], null, null, ProviderId("things"), SourceId("things"));
    expect(doc.sourceCreatedAt).toBe("2024-03-08T00:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2024-03-08T00:00:00.000Z");
  });

  test("surfaces TMTaskTag-derived hashtags into metadata.tags + content (regression for things-tags-not-extracted)", () => {
    const doc = normalizeTask(
      baseTask,
      [],
      null,
      "Personal",
      ProviderId("things"),
      SourceId("things"),
      ["Important", "#Errand"],
    );
    // Tags merge: area first, then per-task tags (lowercased, '#'-stripped, deduped).
    expect(doc.metadata.tags).toEqual(["Personal", "important", "errand"]);
    expect(doc.metadata.extra?.hashtags).toEqual(["important", "errand"]);
    expect(doc.content).toMatch(/Tags:.*#important.*#errand/);
  });

  test("hashtags are deduped (case-insensitive) and stripped of leading #", () => {
    const doc = normalizeTask(baseTask, [], null, null, ProviderId("things"), SourceId("things"), [
      "Important",
      "#IMPORTANT",
      "important",
    ]);
    expect(doc.metadata.extra?.hashtags).toEqual(["important"]);
    expect(doc.metadata.tags).toEqual(["important"]);
  });

  test("missing taskTags param (older callers) still produces just the area tag", () => {
    const doc = normalizeTask(baseTask, [], null, "Work", ProviderId("things"), SourceId("things"));
    expect(doc.metadata.tags).toEqual(["Work"]);
    expect(doc.metadata.extra?.hashtags).toBeUndefined();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDevAnnotation,
  createDevAnnotationsTables,
  deleteDevAnnotation,
  getDevAnnotation,
  listDevAnnotations,
  resolveDevAnnotation,
} from "./store.js";

describe("dev_annotations store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createDevAnnotationsTables(db);
  });

  afterEach(() => {
    db.close();
  });

  test("DDL is idempotent", () => {
    // Re-running the fresh-install DDL over an existing table is a no-op.
    expect(() => createDevAnnotationsTables(db)).not.toThrow();
  });

  test("creates and reads back an annotation with a durable context snapshot", () => {
    const created = createDevAnnotation(
      db,
      {
        id: "note-1",
        targetType: "document",
        targetId: "doc-abc",
        note: "This email was mis-parsed — the sender name is wrong.",
        context: { label: "Re: Q4 budget review", summary: "sender mismatch" },
        deepLink: "/portal/doc/doc-abc",
        client: "portal",
      },
      1000,
    );

    expect(created.id).toBe("note-1");
    expect(created.status).toBe("open");
    expect(created.targetType).toBe("document");
    expect(created.targetId).toBe("doc-abc");
    expect(created.context).toEqual({ label: "Re: Q4 budget review", summary: "sender mismatch" });
    expect(created.createdAt).toBe(1000);
    expect(created.resolvedAt).toBeNull();

    const fetched = getDevAnnotation(db, "note-1");
    expect(fetched).toEqual(created);
  });

  test("stores a free-form route note with a null target id", () => {
    const created = createDevAnnotation(
      db,
      {
        id: "note-route",
        targetType: "route",
        note: "The /people browse sort feels off.",
        deepLink: "/portal/people",
        client: "portal",
      },
      1000,
    );
    expect(created.targetId).toBeNull();
    expect(created.context).toBeNull();
    expect(created.targetType).toBe("route");
  });

  test("stores cognition targets — a retired loop (with id) and the idless agent-notes blob", () => {
    const retired = createDevAnnotation(
      db,
      {
        id: "note-retired",
        targetType: "retired_loop",
        targetId: "rl-7",
        note: "This loop was retired too early.",
        context: { label: "Renew the parking permit" },
        client: "portal",
      },
      1000,
    );
    expect(retired.targetType).toBe("retired_loop");
    expect(retired.targetId).toBe("rl-7");

    const notes = createDevAnnotation(
      db,
      {
        id: "note-agent-notes",
        targetType: "agent_notes",
        note: "The agent's standing notes are stale.",
        client: "portal",
      },
      1000,
    );
    expect(notes.targetType).toBe("agent_notes");
    expect(notes.targetId).toBeNull();
  });

  test("lists open notes newest-first and filters by status and type", () => {
    createDevAnnotation(db, { id: "a", targetType: "document", note: "a" }, 100);
    createDevAnnotation(db, { id: "b", targetType: "brief", note: "b" }, 300);
    createDevAnnotation(db, { id: "c", targetType: "document", note: "c" }, 200);

    const open = listDevAnnotations(db);
    expect(open.map((r) => r.id)).toEqual(["b", "c", "a"]);

    const docs = listDevAnnotations(db, { targetType: "document" });
    expect(docs.map((r) => r.id)).toEqual(["c", "a"]);

    resolveDevAnnotation(db, "c", 400);
    expect(listDevAnnotations(db).map((r) => r.id)).toEqual(["b", "a"]);
    expect(listDevAnnotations(db, { status: "resolved" }).map((r) => r.id)).toEqual(["c"]);
    expect(listDevAnnotations(db, { status: "all" }).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  test("resolve records the resolution note and timestamp", () => {
    createDevAnnotation(db, { id: "r1", targetType: "open_loop", note: "spurious loop" }, 100);
    const resolved = resolveDevAnnotation(db, "r1", 500, "Fixed the loop-detection heuristic.");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toBe(500);
    expect(resolved?.resolvedNote).toBe("Fixed the loop-detection heuristic.");
  });

  test("resolve on a missing id returns null without throwing", () => {
    expect(resolveDevAnnotation(db, "nope", 500)).toBeNull();
  });

  test("delete removes the row and reports whether it existed", () => {
    createDevAnnotation(db, { id: "d1", targetType: "document", note: "x" }, 100);
    expect(deleteDevAnnotation(db, "d1")).toBe(true);
    expect(getDevAnnotation(db, "d1")).toBeNull();
    expect(deleteDevAnnotation(db, "d1")).toBe(false);
  });
});

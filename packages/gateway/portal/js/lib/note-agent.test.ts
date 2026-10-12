// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  noteAgentActive,
  noteAgentDisplay,
  noteAgentPending,
  noteChangeHref,
  noteRefreshChanged,
  noteUndoErrorMessage,
  // @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
} from "./note-agent.js";

describe("note agent display", () => {
  it("reads pending and running as reading", () => {
    for (const state of ["pending", "running"]) {
      expect(noteAgentPending({ state })).toBe(true);
      expect(noteAgentDisplay({ state, receipt: null })).toEqual({
        kind: "reading",
        text: "Omnesis is reading this…",
        changes: [],
      });
    }
    expect(noteAgentPending({ state: "done" })).toBe(false);
    expect(noteAgentPending(undefined)).toBe(false);
  });

  it("shows a done receipt with its changes and nothing for an empty one", () => {
    const changes = [{ text: "Added: Order printer paper", taskId: "loop_a", undoSeq: 7 }];
    expect(noteAgentDisplay({ state: "done", receipt: { text: "Added a task.", changes } })).toEqual({
      kind: "receipt",
      text: "Added a task.",
      changes,
    });
    expect(noteAgentDisplay({ state: "done", receipt: { text: " ", changes: [] } })).toBeNull();
    expect(noteAgentDisplay({ state: "done", receipt: null })).toBeNull();
  });

  it("says failed quietly and shows nothing for skipped or absent", () => {
    expect(noteAgentDisplay({ state: "failed", receipt: null })?.text).toBe("Omnesis couldn't act on this note.");
    expect(noteAgentDisplay({ state: "skipped", receipt: { text: "Nothing to do.", changes: [] } })).toBeNull();
    expect(noteAgentDisplay(undefined)).toBeNull();
  });

  it("links a change with a task to Tasks", () => {
    expect(noteChangeHref({ taskId: "loop_a" })).toBe("/portal/tasks");
    expect(noteChangeHref({ taskId: null })).toBeNull();
  });

  it("explains a refused undo", () => {
    expect(noteUndoErrorMessage({ status: 409 })).toBe("A later change to this task has to be undone first.");
    expect(noteUndoErrorMessage({ status: 500 })).toBe("Couldn't undo that change — try again.");
  });

  it("reads the hint gate from /status", () => {
    expect(noteAgentActive({ tasks: { available: true, noteAgent: true } })).toBe(true);
    expect(noteAgentActive({ tasks: { available: true, noteAgent: false } })).toBe(false);
    expect(noteAgentActive(null)).toBe(false);
  });

  it("spots a refreshed copy with news", () => {
    const base = { id: "n", agent: { state: "running", receipt: null } };
    expect(noteRefreshChanged(base, { ...base })).toBe(false);
    expect(noteRefreshChanged(base, { id: "n", agent: { state: "done", receipt: { text: "x", changes: [] } } })).toBe(true);
    expect(noteRefreshChanged({ id: "n", transcription: "pending" }, { id: "n" })).toBe(true);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConversationDraft,
  clearPendingSubmission,
  readConversationDraft,
  readPendingSubmission,
  submissionForRetry,
  writeConversationDraft,
  // @ts-expect-error — portal modules are plain JS without sibling declarations.
} from "./conversation-draft.js";

afterEach(() => {
  for (const session of ["first", "second", "unavailable"]) {
    const pending = readPendingSubmission(session);
    if (pending) clearPendingSubmission(session, pending.clientMessageId);
  }
  vi.unstubAllGlobals();
});
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}
describe("conversation draft durability", () => {
  it("restores text and command independently for each conversation", () => {
    storage();
    writeConversationDraft("first", "Find the project notes", "deep-research");
    writeConversationDraft("second", "Summarize the plan");
    expect(readConversationDraft("first")).toEqual({
      text: "Find the project notes",
      command: "deep-research",
    });
    writeConversationDraft("second", "");
    expect(readConversationDraft("first").text).toBe("Find the project notes");
    expect(readConversationDraft("second").text).toBe("");
  });
  it("reuses an unconfirmed submission ID after reload but not after acknowledgment", () => {
    storage();
    const initial = submissionForRetry("first", "Also include milestones", { mode: "queue" });
    expect(submissionForRetry("first", "Also include milestones", { mode: "queue" })).toEqual(
      initial,
    );
    clearPendingSubmission("first", "unrelated");
    expect(submissionForRetry("first", "Also include milestones", { mode: "queue" })).toEqual(
      initial,
    );
    clearPendingSubmission("first", initial.clientMessageId);
    expect(
      submissionForRetry("first", "Also include milestones", { mode: "queue" }).clientMessageId,
    ).not.toBe(initial.clientMessageId);
  });
  it("retries original clarification metadata even when refreshed controls no longer include it", () => {
    storage();
    const original = submissionForRetry("first", "This month", {
      mode: "interrupt",
      clarificationId: "question-one",
      deepResearch: true,
    });
    expect(submissionForRetry("first", "This month", { mode: "queue" })).toEqual(original);
    expect(() => submissionForRetry("first", "Another prompt", { mode: "queue" })).toThrow(
      "unacknowledged",
    );
  });
  it("does not clear a newer draft when an earlier send is acknowledged", () => {
    storage();
    writeConversationDraft("first", "New draft");
    expect(clearConversationDraft("first", "Earlier draft")).toBe(false);
    expect(readConversationDraft("first").text).toBe("New draft");
    expect(clearConversationDraft("first", "New draft")).toBe(true);
    expect(readConversationDraft("first").text).toBe("");
  });
  it("retains the original retry ID and metadata when browser storage fails", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    });
    const original = submissionForRetry("unavailable", "This month", {
      mode: "interrupt",
      clarificationId: "question-one",
    });
    expect(submissionForRetry("unavailable", "This month", { mode: "queue" })).toEqual(original);
    clearPendingSubmission("unavailable", original.clientMessageId);
    expect(
      submissionForRetry("unavailable", "This month", { mode: "queue" }).clientMessageId,
    ).not.toBe(original.clientMessageId);
  });
  it("reports unavailable storage without losing the editing surface", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("unavailable");
      },
      setItem() {
        throw new Error("full");
      },
    });
    expect(readConversationDraft("first").text).toBe("");
    expect(writeConversationDraft("first", "Draft")).toBe(false);
  });
});

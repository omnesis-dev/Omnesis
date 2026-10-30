// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  withOptimisticQueuedMessage,
  withoutOptimisticQueuedMessage,
  // @ts-expect-error — portal modules are plain JS without sibling declarations.
} from "./queue-handoff.js";

const sid = "sess-1";
const submission = { clientMessageId: "sub-1", text: "And also this", mode: "queue" };
const controls = { sessionId: sid, busy: true, capabilities: { coalescedQueue: true, queueSendNow: true }, queuedMessages: [] };

describe("a follow-up shows on the queue card before the gateway confirms it", () => {
  it("adds the submission as a queued message of this session's controls", () => {
    const next = withOptimisticQueuedMessage(controls, sid, submission);
    expect(next.queuedMessages).toEqual([{ id: "sub-1", text: "And also this", status: "queued" }]);
    expect(controls.queuedMessages).toEqual([]);
    expect(withOptimisticQueuedMessage(controls, sid, { ...submission, deepResearch: true }).queuedMessages[0]).toMatchObject({ deepResearch: true });
  });

  it("leaves controls of another session, an unsupported gateway, or an already listed id alone", () => {
    expect(withOptimisticQueuedMessage(controls, "other", submission)).toBe(controls);
    const unsupported = { sessionId: sid, unsupported: true };
    expect(withOptimisticQueuedMessage(unsupported, sid, submission)).toBe(unsupported);
    expect(withOptimisticQueuedMessage(null, sid, submission)).toBeNull();
    const listed = withOptimisticQueuedMessage(controls, sid, submission);
    expect(withOptimisticQueuedMessage(listed, sid, submission)).toBe(listed);
  });

  it("a refused submission is removed again, without touching the rest", () => {
    const listed = withOptimisticQueuedMessage(
      { ...controls, queuedMessages: [{ id: "earlier", text: "Earlier", status: "queued" }] },
      sid,
      submission,
    );
    const next = withoutOptimisticQueuedMessage(listed, sid, "sub-1");
    expect(next.queuedMessages).toEqual([{ id: "earlier", text: "Earlier", status: "queued" }]);
    expect(withoutOptimisticQueuedMessage(next, sid, "sub-1")).toBe(next);
    expect(withoutOptimisticQueuedMessage(listed, "other", "sub-1")).toBe(listed);
  });
});

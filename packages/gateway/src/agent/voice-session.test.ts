// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  createVoiceSession,
  withVoiceMutationAdmission,
  type ConversationTurnReceipt,
} from "./voice-session.js";
import { z } from "zod";
import type { ChatMessage, ToolHandle } from "@omnesis/agent";

function fixture(history: ChatMessage[]) {
  let active = true;
  const receipt: ConversationTurnReceipt = {
    messageId: "fixture-message",
    historyStart: 0,
    historyEnd: history.length,
    stopReason: "end_turn",
  };
  const cancel = vi.fn(async (_ids: ReadonlySet<string>) => {});
  const unsubscribe = vi.fn();
  const session = createVoiceSession({
    sessionId: "fixture-session",
    model: "configured-model",
    backend: "configured-backend",
    history: () => history,
    active: () => active,
    closedError: () => new Error("Closed fixture"),
    subscribe: () => unsubscribe,
    accept: async (_input, admit) => {
      if (!admit()) throw new Error("Closed fixture");
    },
    wait: async () => receipt,
    cancel,
    release: () => {
      active = false;
    },
  });
  return { session, receipt, cancel, unsubscribe };
}
describe("configured voice session projection", () => {
  it("reads only the final canonical assistant segment without recording speech as another turn", async () => {
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "Fictional workshop question" }] },
      { role: "assistant", parts: [{ kind: "text", text: "I will look that up." }] },
      {
        role: "assistant",
        parts: [{ kind: "text", text: "The fictional workshop has two rooms." }],
      },
    ];
    const f = fixture(history);
    expect(
      await f.session.submit({
        clientMessageId: "delegation-1",
        text: "Fictional workshop question",
      }),
    ).toEqual({
      messageId: "fixture-message",
      text: "The fictional workshop has two rooms.",
      stopReason: "end_turn",
    });
    expect(history).toHaveLength(3);
    expect(f.session).toMatchObject({ model: "configured-model", backend: "configured-backend" });
  });
  it("does not mistake a tool-bearing preamble for a finished answer", async () => {
    const f = fixture([
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "I will look that up." },
          { kind: "tool_use", toolCallId: "fixture-call", tool: "fixture_tool", args: {} },
        ],
      },
    ]);
    expect(
      (await f.session.submit({ clientMessageId: "delegation-1", text: "Fictional question" }))
        .text,
    ).toBe("");
  });
  it.each(["annotate_many", "cite_record"])(
    "preserves the answer around final %s citations",
    async (tool) => {
      const f = fixture([
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "The invented observatory has three domes." },
            { kind: "tool_use", toolCallId: "citation", tool, args: {} },
          ],
        },
        {
          role: "user",
          parts: [
            {
              kind: "tool_result",
              toolCallId: "citation",
              result: { kind: "error", code: "fixture", message: "Fixture result" },
            },
          ],
        },
      ]);
      expect(
        (await f.session.submit({ clientMessageId: "citation-answer", text: "Invented question" }))
          .text,
      ).toBe("The invented observatory has three domes.");
    },
  );
  it("preserves tool metadata and prototype while wrapping only writes", async () => {
    const invoke = vi.fn(async () => ({
      kind: "error" as const,
      code: "fixture",
      message: "Fixture result",
    }));
    class FixtureTool implements ToolHandle {
      name = "fixture_write";
      description = "Invented mutation";
      schema = z.object({});
      mutates = true;
      invoke = invoke;
      summarize() {
        return "Invented summary";
      }
    }
    const original = new FixtureTool();
    const admit = vi.fn(
      async (
        _ctx: Parameters<ToolHandle["invoke"]>[1],
        operation: () => ReturnType<ToolHandle["invoke"]>,
      ) => operation(),
    );
    const wrapped = withVoiceMutationAdmission(original, admit);
    expect(wrapped).toBeInstanceOf(FixtureTool);
    expect(wrapped.schema).toBe(original.schema);
    expect(wrapped.summarize?.({})).toBe("Invented summary");
    await wrapped.invoke({}, { sessionId: "fixture-session", messageId: "fixture-message" });
    expect(admit).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    const read = { ...original, mutates: false };
    expect(withVoiceMutationAdmission(read, admit)).toBe(read);
  });
  it("detaches listeners and rejects fresh submissions without canceling accepted work", async () => {
    const f = fixture([]);
    f.session.subscribe(() => {});
    await f.session.close();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.cancel).not.toHaveBeenCalled();
    await expect(
      f.session.submit({ clientMessageId: "late", text: "Fictional question" }),
    ).rejects.toThrow("Closed fixture");
    await f.session.cancel();
    expect(f.cancel).not.toHaveBeenCalled();
  });
});

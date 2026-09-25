// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { buildConversationMemoryEvidenceTool } from "./conversation-memory-tool.js";

const context = { sessionId: "session", messageId: "message" };

describe("conversation memory evidence tool", () => {
  it("returns only the session's persisted evidence", async () => {
    const evidence = { documentId: "doc_chat", userMessages: ["I prefer morning meetings."] };
    const prepare = vi.fn(async () => evidence);
    const tool = buildConversationMemoryEvidenceTool(prepare);
    expect(tool.mutates).toBe(true);
    expect(await tool.invoke({}, context)).toEqual({
      kind: "structured",
      resultType: "memory.conversation_evidence",
      data: evidence,
    });
    expect(prepare).toHaveBeenCalledOnce();
  });
  it("rejects model-supplied transcript text before persisting anything", async () => {
    const prepare = vi.fn(async () => null);
    const tool = buildConversationMemoryEvidenceTool(prepare);
    expect(await tool.invoke({ userMessages: ["Invented testimony"] }, context)).toMatchObject({
      kind: "error",
      code: "invalid_args",
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([null, { documentId: "doc_chat", userMessages: [] }])(
    "refuses missing user evidence",
    async (evidence) => {
      expect(
        await buildConversationMemoryEvidenceTool(async () => evidence).invoke({}, context),
      ).toMatchObject({ kind: "error", code: "memory_evidence_unavailable" });
    },
  );
  it("reports persistence failure without claiming a save or leaking storage errors", async () => {
    const tool = buildConversationMemoryEvidenceTool(async () => {
      throw new Error("private storage details");
    });
    const result = await tool.invoke({}, context);
    expect(result).toMatchObject({ kind: "error", code: "memory_evidence_unavailable" });
    expect(JSON.stringify(result)).not.toContain("private storage details");
  });
});

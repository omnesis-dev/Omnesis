// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { sendAgentAnswerPush } from "./answer-push.js";
import type { NotificationMessage } from "@omnesis/core/push";

function harness() {
  const messages: NotificationMessage[] = [];
  return {
    messages,
    deps: {
      publisher: {
        publish: vi.fn(async (message: NotificationMessage) => {
          messages.push(message);
          return [];
        }),
      },
    },
  };
}

describe("sendAgentAnswerPush", () => {
  test("publishes a tagged answer with a per-conversation collapse id", async () => {
    const { deps, messages } = harness();
    await sendAgentAnswerPush(deps, {
      conversationId: "conversation-example",
      answer: "A fictional answer is ready.",
    });
    expect(messages).toEqual([
      {
        kind: "agent-answer",
        title: "Answer ready",
        body: "A fictional answer is ready.",
        data: { conversationId: "conversation-example" },
        collapseId: "agent-answer:conversation-example",
      },
    ]);
  });

  test("collapses whitespace and clips long answers", async () => {
    const { deps, messages } = harness();
    await sendAgentAnswerPush(deps, {
      conversationId: "conversation-example",
      answer: `  ${"fictional ".repeat(40)}\nresult  `,
    });
    expect(messages[0]?.body).not.toContain("\n");
    expect(messages[0]?.body.endsWith("…")).toBe(true);
    expect(messages[0]?.body.length).toBe(175);
  });

  test("publishes a failure banner without inventing answer content", async () => {
    const { deps, messages } = harness();
    await sendAgentAnswerPush(deps, { conversationId: "conversation-example", answer: null });
    expect(messages[0]).toMatchObject({
      kind: "agent-answer",
      title: "Answer failed",
      data: { conversationId: "conversation-example" },
    });
    expect(messages[0]?.body).toContain("Open Omnesis to retry");
  });
});

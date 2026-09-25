// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  AnswerHttpClient,
  InvalidAnswerResponseError,
  parseAnswerResponse,
} from "./answer-client.js";
import type { AnswerHttpError } from "./answer-client.js";

const released = {
  status: "released",
  workflowId: "workflow_fictional",
  conversationId: "conversation_fictional",
  taskId: "task_fictional",
  releaseId: "release_fictional",
  answer: "Project Northstar has a planning note.",
} as const;

describe("AnswerHttpClient", () => {
  it("submits through the Answer boundary with explicit non-interactive approval", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(released));
    const client = new AnswerHttpClient({
      baseUrl: "https://gateway.example.org:7600/",
      token: "omn_fictional",
      fetchImpl,
    });
    const controller = new AbortController();

    await expect(
      client.submit(
        {
          question: "What mentions Project Northstar?",
          clientRequestId: "mcp_request_fictional",
          workflowPurpose: "Answer a user question",
        },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(released);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://gateway.example.org:7600/answer");
    expect(init).toMatchObject({ method: "POST", signal: controller.signal });
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer omn_fictional",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      question: "What mentions Project Northstar?",
      clientRequestId: "mcp_request_fictional",
      workflowPurpose: "Answer a user question",
      approval: "never",
    });
  });

  it("encodes task handles and propagates cancellation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(released));
    const client = new AnswerHttpClient({
      baseUrl: "https://gateway.example.org",
      token: "omn_fictional",
      fetchImpl,
    });
    const controller = new AbortController();

    await client.getTask("task/with spaces", { signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example.org/answer/tasks/task%2Fwith%20spaces",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it.each([
    released,
    {
      ...released,
      status: "released_with_reductions",
      reductions: ["removed third-party detail"],
    },
    {
      status: "approval_required",
      workflowId: "workflow_fictional",
      conversationId: "conversation_fictional",
      taskId: "task_fictional",
      approvalId: "approval_fictional",
      approvalExpiresAt: 1_900_000_000_000,
    },
    {
      status: "denied",
      workflowId: "workflow_fictional",
      conversationId: "conversation_fictional",
      taskId: "task_fictional",
      reason: "privacy_policy",
    },
  ])("validates the exact public Answer response %#", (value) => {
    expect(parseAnswerResponse(value)).toEqual(value);
  });

  it.each([
    null,
    { ...released, candidate: "unreviewed content" },
    { ...released, status: "future_status" },
    { ...released, answer: 42 },
    { ...released, status: "denied", reason: "internal_policy_detail" },
  ])("fails closed on a malformed success payload %#", (value) => {
    expect(() => parseAnswerResponse(value)).toThrow(InvalidAnswerResponseError);
  });

  it("preserves typed error metadata without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          code: "ANSWER_IN_PROGRESS",
          error: "private server detail",
          detail: { taskId: "task_fictional" },
        },
        409,
      ),
    );
    const client = new AnswerHttpClient({
      baseUrl: "https://gateway.example.org",
      token: "omn_fictional",
      fetchImpl,
    });

    const promise = client.submit({
      question: "What mentions Project Northstar?",
      clientRequestId: "mcp_request_fictional",
    });
    await expect(promise).rejects.toMatchObject<Partial<AnswerHttpError>>({
      status: 409,
      code: "ANSWER_IN_PROGRESS",
      detail: { taskId: "task_fictional" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 429, 500, 503])("reports HTTP %i as a typed failure", async (status) => {
    const client = new AnswerHttpClient({
      baseUrl: "https://gateway.example.org",
      token: "omn_fictional",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "detail" }, status)),
    });

    await expect(client.getTask("task_fictional")).rejects.toMatchObject({ status });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

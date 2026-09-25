// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenState = vi.hoisted(() => ({
  value: "omn_fictional_answer_test_token" as string | undefined,
}));

vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  return { ...actual, resolveToken: () => tokenState.value };
});

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    withSpinner: vi.fn((_label: string, fn: () => unknown) => fn()),
  };
});

import { EXIT_AUTH, EXIT_GATEWAY_ERROR, EXIT_USER_ERROR } from "../utils.js";
import {
  answerCommand,
  DEFAULT_WAIT_TIMEOUT_S,
  formatAnswer,
  parseWaitTimeout,
  assertNotInsideAgentHarness,
  WAIT_POLL_INTERVAL_MS,
} from "./answer.js";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function run(args: Record<string, unknown>) {
  return (answerCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({ args });
}

function sentBody(): unknown {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  tokenState.value = "omn_fictional_answer_test_token";
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  fetchMock.mockResolvedValue(
    response(200, {
      status: "released",
      workflowId: "wf_example",
      conversationId: "conv_example",
      taskId: "task_example",
      releaseId: "release_example",
      answer: "A concise answer.",
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("omnesis answer", () => {
  it("reports missing credentials as an authentication error", async () => {
    tokenState.value = undefined;
    await expect(run({ question: "Question" })).rejects.toMatchObject({ exitCode: EXIT_AUTH });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves transport errors for the top-level gateway-down classifier", async () => {
    const transportError = new TypeError("fetch failed");
    fetchMock.mockRejectedValue(transportError);
    await expect(run({ question: "Question" })).rejects.toBe(transportError);
  });

  it("classifies a malformed success payload as a gateway protocol failure", async () => {
    fetchMock.mockResolvedValue(response(200, { status: "released", answer: "incomplete" }));
    await expect(run({ question: "Question" })).rejects.toMatchObject({
      exitCode: EXIT_GATEWAY_ERROR,
      message: "Gateway returned a malformed Answer response.",
    });
  });

  it("posts a new question without inventing a conversation id", async () => {
    await run({ question: "  What changed?  " });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://localhost:7600/answer",
      expect.objectContaining({ method: "POST", body: expect.any(String) }),
    );
    expect(sentBody()).toEqual({
      question: "What changed?",
      clientRequestId: expect.stringMatching(/^cli_/),
      approval: "never",
    });
  });

  it("passes --conversation through for a follow-up", async () => {
    await run({ question: "And next?", conversation: "S_example", json: true });
    expect(sentBody()).toEqual({
      question: "And next?",
      clientRequestId: expect.stringMatching(/^cli_/),
      conversationId: "S_example",
      approval: "never",
    });
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({
      status: "released",
      workflowId: "wf_example",
      conversationId: "conv_example",
      taskId: "task_example",
      releaseId: "release_example",
      answer: "A concise answer.",
    });
  });

  it("polls an approval task without starting another agent turn", async () => {
    await run({ task: "task_example", json: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://localhost:7600/answer/tasks/task_example",
      expect.any(Object),
    );
  });

  it("rejects a question combined with --task", async () => {
    await expect(run({ question: "Question", task: "task_example" })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects wait flags unless they form a task wait", async () => {
    await expect(run({ question: "Question", wait: true })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: "--wait requires --task.",
    });
    await expect(run({ task: "task_example", "wait-timeout": "55" })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: "--wait-timeout requires --wait.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects blank input before contacting the gateway", async () => {
    await expect(run({ question: "   " })).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a blank --conversation before contacting the gateway", async () => {
    await expect(run({ question: "Question", conversation: "   " })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a gateway 404 through the standard status mapping", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "Not found" }));
    await expect(run({ question: "Question" })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: "Not found",
    });
  });

  it("preserves an unknown-conversation 404", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "no conversation S_missing" }));
    await expect(run({ question: "Follow-up", conversation: "S_missing" })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: "no conversation S_missing",
    });
  });

  it("uses the gateway's error message and status-derived exit code", async () => {
    fetchMock.mockResolvedValue(
      response(409, { error: "conversation already has an answer in progress" }),
    );
    await expect(run({ question: "Question" })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: "conversation already has an answer in progress",
    });
  });

  it("formats human output with the reusable conversation id", () => {
    expect(
      formatAnswer(
        {
          status: "released",
          workflowId: "wf_example",
          conversationId: "conv_example",
          taskId: "task_example",
          releaseId: "release_example",
          answer: "A concise answer.",
        },
        false,
      ),
    ).toContain("A concise answer.\n\nWorkflow: wf_example\nConversation: conv_example");
  });

  it("does not print a held candidate when approval is required", () => {
    const text = formatAnswer(
      {
        status: "approval_required",
        workflowId: "wf_example",
        conversationId: "conv_example",
        taskId: "task_example",
        approvalId: "approval_example",
        approvalExpiresAt: 123,
      },
      false,
    );
    expect(text).toContain("Approval required in Omnesis");
    expect(text).toContain("answer --task task_example --wait");
    expect(text).toContain("Approval: approval_example");
  });
});

describe("omnesis answer --task --wait", () => {
  const pending = {
    status: "approval_required",
    approvalId: "approval_example",
    approvalExpiresAt: 123,
    workflowId: "wf_example",
    conversationId: "conv_example",
    taskId: "task_example",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns immediately when the first task status is terminal", async () => {
    await run({ task: "task_example", wait: true, json: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls until a pending approval is released", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, pending))
      .mockResolvedValueOnce(response(200, pending))
      .mockResolvedValueOnce(
        response(200, {
          status: "released_with_reductions",
          workflowId: "wf_example",
          conversationId: "conv_example",
          taskId: "task_example",
          releaseId: "release_example",
          answer: "A generalized answer.",
          reductions: ["precise date"],
        }),
      );

    const done = run({ task: "task_example", wait: true, json: true });
    await vi.advanceTimersByTimeAsync(WAIT_POLL_INTERVAL_MS * 2);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"status": "released_with_reductions"'),
    );
  });

  it("stops polling when the user denies the approval", async () => {
    fetchMock.mockResolvedValueOnce(response(200, pending)).mockResolvedValueOnce(
      response(200, {
        status: "denied",
        workflowId: "wf_example",
        conversationId: "conv_example",
        taskId: "task_example",
        reason: "user_denied",
      }),
    );

    const done = run({ task: "task_example", wait: true, json: true });
    await vi.advanceTimersByTimeAsync(WAIT_POLL_INTERVAL_MS);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status": "denied"'));
  });

  it("sends approval never for a non-interactive request", async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, {
        status: "denied",
        workflowId: "wf_example",
        conversationId: "conv_example",
        taskId: "task_example",
        reason: "approval_not_available",
      }),
    );

    await run({ question: "A fictional scheduled question", "no-approval": true, json: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://localhost:7600/answer",
      expect.objectContaining({ body: expect.stringContaining('"approval":"never"') }),
    );
  });

  it("returns the pending response at the exact timeout without oversleeping", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response(200, pending)));

    const done = run({
      task: "task_example",
      wait: true,
      "wait-timeout": "7",
      json: true,
    });
    await vi.advanceTimersByTimeAsync(6_999);
    expect(console.log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"status": "approval_required"'),
    );
  });

  it("aborts an in-flight poll at the deadline and returns the last pending response", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, pending))
      .mockImplementationOnce((_input: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      });

    const done = run({
      task: "task_example",
      wait: true,
      "wait-timeout": "7",
      json: true,
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"status": "approval_required"'),
    );
  });

  it("keeps one-shot task checks one-shot", async () => {
    fetchMock.mockResolvedValue(response(200, pending));

    await run({ task: "task_example", json: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates the optional timeout", async () => {
    for (const timeout of ["", "0", "-1", "soon", "Infinity", "3601", "1e308"]) {
      await expect(
        run({
          task: "task_example",
          wait: true,
          "wait-timeout": timeout,
        }),
      ).rejects.toMatchObject({
        exitCode: EXIT_USER_ERROR,
        message: "--wait-timeout must be greater than 0 and at most 3600 seconds.",
      });
    }
    expect(parseWaitTimeout(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_S);
    expect(parseWaitTimeout("55")).toBe(55);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("asking from inside an agent harness", () => {
  it("refuses and names the native tool, so the model can correct itself", () => {
    expect(() => assertNotInsideAgentHarness({ OMNESIS_AGENT_HARNESS: "openclaw" })).toThrow(
      /not available from a shell inside openclaw/,
    );
    expect(() => assertNotInsideAgentHarness({ OMNESIS_AGENT_HARNESS: "hermes" })).toThrow(
      /`omnesis_answer`/,
    );
  });

  it("still lets an agent read back a task it already started", async () => {
    // Polling an existing task is a plain lookup, with none of the properties
    // that make asking a fresh question from a shell wrong.
    process.env.OMNESIS_AGENT_HARNESS = "openclaw";
    try {
      await run({ task: "task_example", json: true });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://localhost:7600/answer/tasks/task_example",
        expect.any(Object),
      );
    } finally {
      delete process.env.OMNESIS_AGENT_HARNESS;
    }
  });

  it("refuses a question asked from inside a harness shell", async () => {
    process.env.OMNESIS_AGENT_HARNESS = "openclaw";
    try {
      await expect(run({ question: "What changed?" })).rejects.toMatchObject({
        exitCode: EXIT_USER_ERROR,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.OMNESIS_AGENT_HARNESS;
    }
  });

  it("stays out of the way of an operator's own shell", () => {
    expect(() => assertNotInsideAgentHarness({})).not.toThrow();
    // An explicit opt-out for an operator working inside a harness host.
    expect(() => assertNotInsideAgentHarness({ OMNESIS_AGENT_HARNESS: "0" })).not.toThrow();
    expect(() => assertNotInsideAgentHarness({ OMNESIS_AGENT_HARNESS: "  " })).not.toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

import {
  describeAnswerOutcome,
  firingAnswerConversationHandle,
  firingAnswerRequestId,
  integrationAnswerConversationHandle,
  integrationAnswerRequestId,
  AnswerPendingError,
  requestFiringAnswer,
  type AnswerWaitOptions,
  type AnswerPoster,
} from "./answer-wait.js";
import { GatewayRequestTimeoutError, IntegrationHttpError } from "./http.js";

const ENDPOINT = "/subscriptions/firings/sf_fictional/answer";
const QUESTION = "What changed on the fictional workspace invoice?";

const RELEASED = {
  status: "released",
  workflowId: "wf_fictional",
  conversationId: "conv_fictional",
  taskId: "task_fictional",
  releaseId: "rel_fictional",
  answer: "A revised quote arrived on the fictional invoice thread.",
};

/** Every poll is instant, so a test never waits on a real backoff. */
const fast: AnswerWaitOptions = { sleep: async () => {}, pollIntervalMs: 1 };

function inProgress(): IntegrationHttpError {
  return new IntegrationHttpError(
    409,
    "gateway rejected request (HTTP 409)",
    undefined,
    "ANSWER_IN_PROGRESS",
  );
}

function atCapacity(status = 503): IntegrationHttpError {
  return new IntegrationHttpError(
    status,
    "gateway rejected request (HTTP 503)",
    undefined,
    "ANSWER_CAPACITY",
  );
}

/** A gateway that is genuinely not serving — same status, opposite meaning. */
function unavailable(): IntegrationHttpError {
  return new IntegrationHttpError(
    503,
    "gateway rejected request (HTTP 503)",
    undefined,
    "SERVICE_UNAVAILABLE",
  );
}

function poster(
  postJson: AnswerPoster["postJson"],
): AnswerPoster & { postJson: ReturnType<typeof vi.fn> } {
  return { postJson: vi.fn(postJson) } as never;
}

describe("a gateway at capacity", () => {
  // "The turn limit is full" is a not-yet, and the wait budget exists for
  // exactly that. Treated as a settled failure it ended a scheduled report
  // with minutes of budget unspent, while the answer it asked for was in
  // fact produced.
  test("is waited out like an ask already running", async () => {
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call < 4) throw atCapacity();
      return RELEASED;
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).resolves.toEqual(RELEASED);
    expect(http.postJson).toHaveBeenCalledTimes(4);
  });

  test("is waited out when reported as a rate limit too", async () => {
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call < 3) throw atCapacity(429);
      return RELEASED;
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).resolves.toEqual(RELEASED);
  });

  // The distinction the code exists for: a gateway that is not serving is
  // also a 503, and waiting seven minutes for one is not useful.
  test("a gateway that is simply unavailable is not waited out indefinitely", async () => {
    const http = poster(async () => {
      throw unavailable();
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).rejects.toBeInstanceOf(IntegrationHttpError);
    // The few quick retries a blip gets, not the full polling budget.
    expect(http.postJson.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("firingAnswerRequestId", () => {
  test("is stable across repeats of the same ask", () => {
    const request = { endpoint: ENDPOINT, question: QUESTION };
    expect(firingAnswerRequestId(request)).toBe(firingAnswerRequestId({ ...request }));
  });

  test("separates different questions, firings, and conversations", () => {
    const base = firingAnswerRequestId({ endpoint: ENDPOINT, question: QUESTION });
    expect(firingAnswerRequestId({ endpoint: ENDPOINT, question: "Something else?" })).not.toBe(
      base,
    );
    expect(
      firingAnswerRequestId({
        endpoint: "/subscriptions/firings/sf_other/answer",
        question: QUESTION,
      }),
    ).not.toBe(base);
    expect(
      firingAnswerRequestId({ endpoint: ENDPOINT, question: QUESTION, conversationId: "conv_x" }),
    ).not.toBe(base);
  });

  test("matches the gateway's client request id format", () => {
    expect(firingAnswerRequestId({ endpoint: ENDPOINT, question: QUESTION })).toMatch(
      /^[A-Za-z0-9_.:-]{1,160}$/,
    );
  });
});

describe("integrationAnswerRequestId", () => {
  const base = { runGeneration: "agent:main:cron:job:run:monday", question: "How is today?" };

  test("is stable for one ask, so every repeat is recognisable as the same ask", () => {
    expect(integrationAnswerRequestId(base)).toBe(integrationAnswerRequestId({ ...base }));
    expect(integrationAnswerRequestId(base)).toMatch(/^integration_[0-9a-f]{48}$/);
  });

  test("separates one scheduled run from the next", () => {
    expect(integrationAnswerRequestId(base)).not.toBe(
      integrationAnswerRequestId({ ...base, runGeneration: "agent:main:cron:job:run:tuesday" }),
    );
  });

  test("separates two asks inside one conversation", () => {
    // Without this a person asking the same question again an hour later would
    // be served the stored answer for the life of the session.
    const conversation = {
      runGeneration: "agent:main:slack:channel:c1",
      question: "How is today?",
    };
    expect(integrationAnswerRequestId({ ...conversation, askId: "call-1" })).not.toBe(
      integrationAnswerRequestId({ ...conversation, askId: "call-2" }),
    );
  });

  test("covers every field the gateway folds into its own fingerprint", () => {
    // A repeat carrying this id with different content is rejected as a
    // conflict rather than recognised as the poll it is.
    for (const differing of [
      { question: "How was yesterday?" },
      { conversationId: "conv_1" },
      { workflowId: "wf_1" },
      { workflowName: "Morning report" },
      { workflowPurpose: "A fictional purpose." },
      { approval: "never" as const },
    ]) {
      expect(integrationAnswerRequestId({ ...base, ...differing })).not.toBe(
        integrationAnswerRequestId(base),
      );
    }
  });

  test("files the completion route under a handle derived from the same ask", () => {
    expect(integrationAnswerConversationHandle(base)).toBe(
      integrationAnswerConversationHandle({ ...base }),
    );
    expect(integrationAnswerConversationHandle(base)).not.toBe(
      integrationAnswerConversationHandle({ ...base, question: "Something else?" }),
    );
    expect(integrationAnswerConversationHandle(base)).toMatch(/^native_[0-9a-f]{48}$/);
  });
});

describe("requestFiringAnswer", () => {
  test("returns the answer on the first attempt without polling", async () => {
    const http = poster(async () => RELEASED);
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }),
    ).resolves.toEqual(RELEASED);
    expect(http.postJson).toHaveBeenCalledTimes(1);
  });

  test("sends a derived idempotency key so a repeat is recognisable as the same ask", async () => {
    const http = poster(async () => RELEASED);
    await requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION });
    expect(http.postJson).toHaveBeenCalledWith(
      ENDPOINT,
      {
        question: QUESTION,
        clientRequestId: firingAnswerRequestId({ endpoint: ENDPOINT, question: QUESTION }),
        nativeConversationId: firingAnswerConversationHandle({
          endpoint: ENDPOINT,
          question: QUESTION,
        }),
      },
      undefined,
      { timeoutMs: expect.any(Number) },
    );
  });

  test("leaves a route behind, so an answer held for approval can still arrive", async () => {
    // The live failure this exists for: the answer was held, this run ended,
    // the operator approved — and the released answer had nowhere to go, so it
    // waited forever. A one-shot background turn cannot be the thing that
    // collects a decision made after it is gone.
    const http = poster(async () => RELEASED);
    await requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION });

    const body = http.postJson.mock.calls[0]![1] as { nativeConversationId?: string };
    expect(body.nativeConversationId, "a firing ask left no way back").toBeTruthy();
  });

  test("gives the same ask the same route, so a repeat resumes one conversation", async () => {
    // Derived, not invented. Two asks that are the same ask must not open two
    // routes — the gateway would then hold one answer and deliver it to a
    // conversation nobody is reading.
    const first = firingAnswerConversationHandle({ endpoint: ENDPOINT, question: QUESTION });
    const again = firingAnswerConversationHandle({ endpoint: ENDPOINT, question: QUESTION });
    const other = firingAnswerConversationHandle({
      endpoint: ENDPOINT,
      question: "something else",
    });

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  test("gives the first attempt a budget far wider than an ordinary gateway read", async () => {
    const http = poster(async () => RELEASED);
    await requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION });
    const options = http.postJson.mock.calls[0]![3] as { timeoutMs: number };
    // An answer turn has been measured at close to a minute; a budget in the
    // twenty-second range is the wall this module exists to remove.
    expect(options.timeoutMs).toBeGreaterThan(60_000);
  });

  test("a socket timeout collects the answer instead of discarding the work", async () => {
    // The exact live failure: the client's budget elapsed while the gateway
    // was still running the turn, and the turn then completed.
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call === 1) throw new GatewayRequestTimeoutError(20_000);
      return RELEASED;
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).resolves.toEqual(RELEASED);
    expect(http.postJson).toHaveBeenCalledTimes(2);
  });

  test("never varies the request id across a retry, so no second turn can start", async () => {
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call < 4) throw call === 1 ? new GatewayRequestTimeoutError(20_000) : inProgress();
      return RELEASED;
    });
    await requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast);
    const ids = http.postJson.mock.calls.map(
      (args) => (args[1] as { clientRequestId: string }).clientRequestId,
    );
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(1);
  });

  test("polls while the gateway reports the turn is still running", async () => {
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call < 3) throw inProgress();
      return RELEASED;
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).resolves.toEqual(RELEASED);
    expect(http.postJson).toHaveBeenCalledTimes(3);
  });

  test("polls with a tighter budget than the first attempt", async () => {
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call === 1) throw inProgress();
      return RELEASED;
    });
    await requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast);
    const first = http.postJson.mock.calls[0]![3] as { timeoutMs: number };
    const second = http.postJson.mock.calls[1]![3] as { timeoutMs: number };
    expect(second.timeoutMs).toBeLessThan(first.timeoutMs);
  });

  test("backs off between polls", async () => {
    const waits: number[] = [];
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call < 4) throw inProgress();
      return RELEASED;
    });
    await requestFiringAnswer(
      http,
      { endpoint: ENDPOINT, question: QUESTION },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
        pollIntervalMs: 10,
        pollMaxIntervalMs: 25,
      },
    );
    expect(waits).toEqual([10, 20, 25]);
  });

  test("a held answer resolves rather than throwing", async () => {
    const held = {
      status: "approval_required",
      workflowId: "wf_fictional",
      conversationId: "conv_fictional",
      taskId: "task_fictional",
      approvalId: "appr_fictional",
      approvalExpiresAt: 1_900_000_000_000,
    };
    const http = poster(async () => held);
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).resolves.toEqual(held);
  });

  test("a conflict it can never wait out is surfaced immediately", async () => {
    const conflict = new IntegrationHttpError(
      409,
      "gateway rejected request (HTTP 409)",
      undefined,
      "CONFLICT",
    );
    const http = poster(async () => {
      throw conflict;
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).rejects.toBe(conflict);
    expect(http.postJson).toHaveBeenCalledTimes(1);
  });

  test("an authorization failure is surfaced immediately", async () => {
    const forbidden = new IntegrationHttpError(403, "gateway rejected request (HTTP 403)");
    const http = poster(async () => {
      throw forbidden;
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, fast),
    ).rejects.toBe(forbidden);
    expect(http.postJson).toHaveBeenCalledTimes(1);
  });

  test("stops at the deadline and says the work is still running", async () => {
    let clock = 0;
    const http = poster(async () => {
      throw inProgress();
    });
    await expect(
      requestFiringAnswer(
        http,
        { endpoint: ENDPOINT, question: QUESTION },
        {
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          deadlineMs: 50,
          pollIntervalMs: 20,
          pollMaxIntervalMs: 20,
        },
      ),
    ).rejects.toBeInstanceOf(AnswerPendingError);
  });

  test("never lets a request budget outrun the deadline", async () => {
    let clock = 0;
    const http = poster(async () => {
      clock += 5_000;
      throw inProgress();
    });
    await requestFiringAnswer(
      http,
      { endpoint: ENDPOINT, question: QUESTION },
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        deadlineMs: 12_000,
        pollIntervalMs: 1_000,
      },
    ).catch(() => {});
    for (const call of http.postJson.mock.calls) {
      expect((call[3] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(12_000);
    }
  });

  test("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const http = poster(async () => {
      controller.abort(new Error("wake cancelled"));
      throw inProgress();
    });
    await expect(
      requestFiringAnswer(http, { endpoint: ENDPOINT, question: QUESTION }, {}, controller.signal),
    ).rejects.toThrow("wake cancelled");
  });
});

describe("a blip that is not the ask settling", () => {
  const request = { endpoint: ENDPOINT, question: QUESTION };

  function httpError(status: number): IntegrationHttpError {
    return new IntegrationHttpError(status, `gateway rejected request (HTTP ${status})`);
  }

  test("asks again when a healthy gateway rejects one attempt", async () => {
    // Observed live: a 404 on a route serving requests either side of it, and
    // the immediate retry succeeds. Unretried, one blip ends a scheduled
    // report for the day.
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call === 1) throw httpError(404);
      return RELEASED;
    });
    await expect(requestFiringAnswer(http, request, fast)).resolves.toEqual(RELEASED);
    expect(http.postJson).toHaveBeenCalledTimes(2);
  });

  test("retries a server-side error too", async () => {
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call === 1) throw httpError(503);
      return RELEASED;
    });
    await expect(requestFiringAnswer(http, request, fast)).resolves.toEqual(RELEASED);
    expect(http.postJson).toHaveBeenCalledTimes(2);
  });

  test("gives up quickly when the rejection really is settled", async () => {
    const http = poster(async () => {
      throw httpError(404);
    });
    await expect(requestFiringAnswer(http, request, fast)).rejects.toThrow(/HTTP 404/);
    // Bounded: the caller learns the answer is not coming in seconds, not
    // after a long wait that hides a genuine misconfiguration.
    expect(http.postJson).toHaveBeenCalledTimes(3);
  });

  test("never retries a rejection the ask itself caused", async () => {
    const http = poster(async () => {
      throw httpError(400);
    });
    await expect(requestFiringAnswer(http, request, fast)).rejects.toThrow(/HTTP 400/);
    expect(http.postJson).toHaveBeenCalledTimes(1);
  });

  test("does not vary the request id across a retried blip", async () => {
    let call = 0;
    const http = poster(async () => {
      call += 1;
      if (call === 1) throw httpError(500);
      return RELEASED;
    });
    await requestFiringAnswer(http, request, fast);
    const ids = http.postJson.mock.calls.map(
      (args) => (args[1] as { clientRequestId: string }).clientRequestId,
    );
    expect(new Set(ids).size).toBe(1);
  });
});

describe("describeAnswerOutcome", () => {
  test("says a held answer is waiting on the user, not broken", () => {
    const note = describeAnswerOutcome({ status: "approval_required" });
    expect(note).toContain("approval");
    expect(note).toContain("not a failure");
  });

  test("says a withheld answer is a settled decision", () => {
    const note = describeAnswerOutcome({ status: "denied" });
    expect(note).toContain("private");
    expect(note).toContain("do not ask again");
  });

  test("says a no-approval denial is an omission the run should work around", () => {
    // A scheduled run asks for a settled outcome, so this is the shape it gets
    // when a question needed a person. Reporting it as a fault would make a
    // working privacy boundary look like a broken job.
    const note = describeAnswerOutcome({
      status: "denied",
      reason: "approval_not_available",
    });
    expect(note).toContain("Complete the rest of the work");
    expect(note).not.toContain("do not ask again");
  });

  test("flags a reduced answer", () => {
    expect(describeAnswerOutcome({ status: "released_with_reductions" })).toContain(
      "detail removed",
    );
  });

  test("adds nothing to a plain release", () => {
    expect(describeAnswerOutcome(RELEASED)).toBeNull();
    expect(describeAnswerOutcome(null)).toBeNull();
    expect(describeAnswerOutcome("released")).toBeNull();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { DecisionHttpError } from "./transport.js";
import { describeDecisionFailure, vetDecisionModel, verifyDecisionModel } from "./verify.js";
import type { DecisionCapability } from "@omnesis/core";

const ctx = { url: "http://127.0.0.1:11435/v1/systemone", model: "kevv" };

function client(decide: DecisionCapability["decide"]): DecisionCapability {
  return { modelId: "kevv", decide, dispose: vi.fn() };
}
const failing = (error: unknown) => client(async () => Promise.reject(error));

describe("verifyDecisionModel", () => {
  it("passes a model that answers both test questions, and disposes the client", async () => {
    const c = client(async () => ({
      model: "kev:latest",
      answers: {
        verify_noul: { type: "noul", noul: 0.98 },
        verify_score: { type: "score", score: 1.4 },
      },
    }));
    const result = await verifyDecisionModel(c, ctx);
    expect(result).toMatchObject({ ok: true, answeredBy: "kev:latest" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(c.dispose).toHaveBeenCalled();
  });

  it("catches an answer on the wrong scale", async () => {
    const c = client(async () => ({
      model: "x",
      answers: {
        verify_noul: { type: "noul", noul: 0.5 },
        verify_score: { type: "score", score: 7 },
      },
    }));
    expect(await verifyDecisionModel(c, ctx)).toEqual({
      ok: false,
      failure: "answer",
      reason: "The model answered a three-level question outside 0–2.",
    });
  });

  it.each([
    [
      new DecisionHttpError(404, "Ollaya HTTP 404: not found"),
      "refused",
      404,
      'The server has no model "kevv"',
    ],
    [
      new DecisionHttpError(401, "OpenRouter HTTP 401: bad key"),
      "refused",
      401,
      "The API key was refused (HTTP 401)",
    ],
    [new DecisionHttpError(402, "HTTP 402"), "refused", 402, "cannot pay"],
    [new DecisionHttpError(422, "HTTP 422: bad question"), "refused", 422, "HTTP 422"],
    [new DecisionHttpError(429, "HTTP 429: slow down"), "unavailable", 429, "HTTP 429"],
    [new DecisionHttpError(425, "HTTP 425: warming"), "unavailable", 425, "HTTP 425"],
    [new DecisionHttpError(503, "HTTP 503: busy"), "unavailable", 503, "HTTP 503"],
    [
      new TypeError("fetch failed"),
      "unavailable",
      undefined,
      "Nothing answered at http://127.0.0.1:11435/v1/systemone",
    ],
    [
      new Error('Ollaya reply lacks a score answer for "verify_score"'),
      "refused",
      undefined,
      "lacks a score answer",
    ],
  ] as const)("classifies a failure (%s)", async (error, failure, status, reason) => {
    const result = await verifyDecisionModel(failing(error), ctx);
    expect(result).toMatchObject({ ok: false, failure });
    expect(result.status).toBe(status);
    expect(result.reason).toContain(reason);
  });

  it("describes a timeout as unavailable", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(describeDecisionFailure(err, ctx)).toEqual({
      failure: "unavailable",
      reason: `${ctx.url} did not answer in time.`,
    });
  });
});

describe("vetDecisionModel", () => {
  it("refuses a model the server says it cannot serve", async () => {
    const verdict = await vetDecisionModel(
      failing(new DecisionHttpError(404, "Ollaya HTTP 404: no such model")),
      ctx,
    );
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(
      /^kevv cannot serve the Decision model: The server has no model "kevv"/,
    );
  });

  it.each([
    new TypeError("fetch failed"),
    new DecisionHttpError(503, "busy"),
    new DecisionHttpError(429, "rate limited"),
    new DecisionHttpError(425, "warming up"),
    new DecisionHttpError(408, "request timeout"),
  ])("lets a server with no definite answer through (%s)", async (error) => {
    expect(await vetDecisionModel(failing(error), ctx)).toEqual({ ok: true });
  });

  it("refuses answers on the wrong scale", async () => {
    const odd = client(async () => ({
      model: "x",
      answers: {
        verify_noul: { type: "noul", noul: 3 },
        verify_score: { type: "score", score: 1 },
      },
    }));
    expect((await vetDecisionModel(odd, ctx)).ok).toBe(false);
  });
});

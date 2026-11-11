// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { validateConfig, type OmnesisConfig } from "@omnesis/config";
import { DecisionHttpError } from "../inference/decision/transport.js";
import { EMAIL_WORTH_QUESTIONS } from "../worth/rubric.js";
import {
  DecisionCalibrationJob,
  CalibrationUnsupported,
  defaultReferencePath,
  modelListUrls,
  probeDecisionBackend,
  readReferenceSet,
  withStoredCalibration,
} from "./decision-tools.js";
import type {
  DecisionCapability,
  DecisionCassetteEntry,
  DecisionRequest,
  ResolvedAssignment,
  ResolvedDecisionBackend,
} from "@omnesis/core";

describe("modelListUrls", () => {
  it("tries /api/tags, then a models listing beside the endpoint", () => {
    expect(modelListUrls("http://127.0.0.1:11435/v1/systemone")).toEqual([
      "http://127.0.0.1:11435/api/tags",
      "http://127.0.0.1:11435/v1/models",
    ]);
    expect(modelListUrls("http://192.0.2.5:8000/inference/v1/decisions/")).toEqual([
      "http://192.0.2.5:8000/api/tags",
      "http://192.0.2.5:8000/inference/v1/models",
    ]);
    expect(modelListUrls("not a url")).toEqual([]);
  });
});

describe("probeDecisionBackend", () => {
  it("lists an Ollama-style server's installed models", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        models: [{ name: "kev:latest" }, { name: "laya:en" }, { model: "d1:latest" }],
      }),
    ) as unknown as typeof fetch;
    const result = await probeDecisionBackend(
      { url: "http://127.0.0.1:11435/v1/systemone" },
      false,
      fetchFn,
    );
    expect(result).toEqual({
      ok: true,
      listed: true,
      models: ["d1:latest", "kev:latest", "laya:en"],
    });
  });

  it("falls back to an OpenAI-style listing, sending the key", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("x-api-key") });
      if (String(url).endsWith("/api/tags")) return new Response("", { status: 404 });
      return Response.json({ data: [{ id: "drex-9b" }] });
    }) as unknown as typeof fetch;
    const result = await probeDecisionBackend(
      { url: "http://127.0.0.1:8000/v1/systemone", auth: "x-api-key", apiKey: "k" },
      false,
      fetchFn,
    );
    expect(result).toEqual({ ok: true, listed: true, models: ["drex-9b"] });
    expect(seen.map((s) => s.auth)).toEqual(["k", "k"]);
  });

  it("does not ask a hosted provider or another wire format", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    for (const cfg of [
      { preset: "openrouter", url: "https://openrouter.ai/api/v1/systemone" },
      { url: "https://api.openai.com/v1/decisions", protocol: "openai-decisions" as const },
    ]) {
      expect(await probeDecisionBackend(cfg, true, fetchFn)).toEqual({
        ok: true,
        models: [],
        listed: false,
      });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("says when nothing answers", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await probeDecisionBackend(
      { url: "http://127.0.0.1:11435/v1/systemone" },
      false,
      fetchFn,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Could not reach http://127.0.0.1:11435/v1/systemone");
  });
});

describe("the bundled Jev reference set", () => {
  it("is the worth question on invented mail, answered by Jev", () => {
    const entries = readReferenceSet(defaultReferencePath());
    expect(entries.length).toBeGreaterThanOrEqual(300);
    for (const entry of entries) {
      expect(entry.request.questions).toEqual(EMAIL_WORTH_QUESTIONS);
      expect(entry.response.model).toMatch(/^jev-/);
      expect(entry.response.answers.worth_score?.type).toBe("score");
      expect(JSON.stringify(entry.request.state)).toMatch(/example\.(com|org|net|io)/);
    }
  });
});

// ── Calibration job ────────────────────────────────────────────────────

function reference(n: number): DecisionCassetteEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const jev = (3 * i) / (n - 1);
    return {
      fp: `fp-${i}`,
      request: {
        state: { subject: `Mail ${i}`, from: "a@example.com", body: String(i) },
        questions: EMAIL_WORTH_QUESTIONS,
      },
      response: {
        model: "jev-1.13.0",
        answers: { worth_score: { type: "score", score: jev } },
      },
    } as DecisionCassetteEntry;
  });
}

const RESOLVED: ResolvedDecisionBackend = {
  role: "decision",
  kind: "decision",
  backendKey: "ollaya",
  preset: "ollaya",
  model: "kev",
  url: "http://127.0.0.1:11435/v1/systemone",
  protocol: "systemone",
  onHost: true,
  allowRemoteInference: false,
  hasApiKey: false,
  calibrated: false,
  available: true,
};

/** A model that rates every email higher than Jev does: its score is Jev's, square-rooted on the 0–1 scale. */
function optimisticModel(failEvery = 0): DecisionCapability {
  let calls = 0;
  return {
    modelId: "kev",
    async decide(request: DecisionRequest) {
      calls += 1;
      if (failEvery && calls % failEvery === 0)
        throw new DecisionHttpError(503, "Ollaya HTTP 503: busy");
      const i = Number((request.state as { body: string }).body);
      const jev = (3 * i) / 299 / 3;
      return {
        model: "kev:latest",
        answers: { worth_score: { type: "score", score: 3 * Math.sqrt(jev) } },
      };
    },
    dispose: vi.fn(),
  };
}

function job(over: Partial<ConstructorParameters<typeof DecisionCalibrationJob>[0]> = {}) {
  const store = vi.fn(async () => {});
  const model = optimisticModel();
  const j = new DecisionCalibrationJob({
    resolve: () => RESOLVED,
    getDecisionEndpoint: () => ({ url: RESOLVED.url }),
    createRawClient: () => model,
    store,
    reference: () => reference(300),
    now: () => new Date("2026-11-10T12:00:00.000Z"),
    ...over,
  });
  return { j, store, model };
}

describe("DecisionCalibrationJob", () => {
  it("replays the reference set, fits the map, and stores it with the backend", async () => {
    const { j, store, model } = job();
    expect(j.start()).toMatchObject({ state: "running", assignment: "ollaya/kev", total: 300 });
    await j.settled();
    const status = j.status();
    expect(status).toMatchObject({ state: "done", done: 300, failed: 0 });
    expect(store).toHaveBeenCalledWith("ollaya", "kev", status.result, {
      url: RESOLVED.url,
      protocol: "systemone",
      scoreField: "score",
    });
    expect(status.result).toMatchObject({
      reference: "jev-worth/email-worth-v1/jev-1.13.0",
      fittedAt: "2026-11-10T12:00:00.000Z",
      samples: 300,
    });
    // The optimistic model keeps everything Jev keeps and lets junk through;
    // calibrated, it keeps ~95% of what Jev keeps and skips most of the rest.
    const r = status.result!;
    expect(r.keepsBefore).toBe(1);
    expect(r.keeps!).toBeGreaterThanOrEqual(0.94);
    expect(r.skips!).toBeGreaterThan(r.skipsBefore! + 0.3);
    expect(r.agreement!).toBeGreaterThan(r.agreementBefore!);
    expect(model.dispose).toHaveBeenCalled();
  });

  it("tolerates a few failed requests but fails a run that mostly failed, naming why", async () => {
    const few = job({ createRawClient: () => optimisticModel(50) });
    few.j.start();
    await few.j.settled();
    expect(few.j.status()).toMatchObject({ state: "done", failed: 6 });

    const most = job({ createRawClient: () => optimisticModel(2) });
    most.j.start();
    await most.j.settled();
    expect(most.j.status()).toMatchObject({ state: "failed" });
    expect(most.j.status().error).toContain("Only 150 of 300 reference emails were answered");
    expect(most.j.status().error).toContain("Ollaya HTTP 503");
    expect(most.store).not.toHaveBeenCalled();
  });

  it("runs one calibration at a time, and can be cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: DecisionCapability = {
      modelId: "kev",
      decide: async (req, opts) => {
        await Promise.race([
          gate,
          new Promise((_, reject) =>
            opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason)),
          ),
        ]);
        return optimisticModel().decide(req);
      },
      dispose: vi.fn(),
    };
    const { j, store } = job({ createRawClient: () => slow });
    j.start();
    expect(() => j.start()).toThrow("already running");
    j.cancel();
    release();
    await j.settled();
    expect(j.status().state).toBe("cancelled");
    expect(store).not.toHaveBeenCalled();
  });

  it.each([
    [{ role: "decision", kind: "typesafe", model: "jev-1.13.0" }, "Jev is the reference itself"],
    [
      { role: "decision", kind: "disabled" },
      "needs the Decision model to be assigned to a backend's decision model",
    ],
    [
      { ...RESOLVED, available: false, reason: "OpenRouter needs an API key." },
      "OpenRouter needs an API key.",
    ],
  ])("refuses what cannot be calibrated (%#)", (resolved, message) => {
    const { j } = job({ resolve: () => resolved as ResolvedAssignment });
    expect(() => j.start()).toThrow(CalibrationUnsupported);
    expect(() => j.start()).toThrow(message);
  });

  it("leaves the job idle when the model's client cannot be built", () => {
    const { j } = job({
      createRawClient: () => {
        throw new Error('"@cf/../x" is not a Workers AI model id');
      },
    });
    expect(() => j.start()).toThrow(CalibrationUnsupported);
    expect(j.status().state).toBe("idle");
    // Nothing is stuck: a later start with a good client runs.
    const ok = job();
    expect(ok.j.start().state).toBe("running");
  });

  it("fails when saving the calibration fails, naming why", async () => {
    const { j } = job({
      store: vi.fn(async () =>
        Promise.reject(new Error('Backend "ollaya" no longer has a decision API')),
      ),
    });
    j.start();
    await j.settled();
    expect(j.status()).toMatchObject({
      state: "failed",
      error: 'Backend "ollaya" no longer has a decision API',
    });
  });
});

describe("withStoredCalibration", () => {
  const CALIBRATION = {
    points: [[0.4, 0.36]] as const,
    reference: "jev-worth/email-worth-v1/jev-1.13.0",
    fittedAt: "2026-11-10T12:00:00.000Z",
  };
  const FITTED_ON = {
    url: "https://api.fireworks.ai/inference/v1/systemone",
    protocol: "systemone",
    scoreField: "score",
  } as const;
  const config = (decision?: Record<string, unknown>) =>
    ({
      inference: {
        backends: {
          fireworks: {
            type: "http",
            url: "https://api.fireworks.ai/inference",
            apiKeySecret: "config-secret:inference.backend.x.apiKey.y",
            ...(decision ? { decision } : {}),
          },
        },
        assignments: { agent: "fireworks/chat-model" },
      },
    }) as unknown as OmnesisConfig;

  it("stores the fit on the backend's decision API, leaving the rest of the backend as it was", () => {
    const current = config({
      url: FITTED_ON.url,
      calibration: { other: { ...CALIBRATION, points: [[0.5, 0.5]] } },
    });
    const next = withStoredCalibration(current, "fireworks", "rune", CALIBRATION, FITTED_ON);
    const backend = next.inference!.backends!.fireworks!;
    expect(backend.url).toBe("https://api.fireworks.ai/inference");
    expect(backend.apiKeySecret).toBe("config-secret:inference.backend.x.apiKey.y");
    expect(Object.keys(backend.decision!.calibration!)).toEqual(["other", "rune"]);
    expect(backend.decision!.calibration!.rune).toEqual({ ...CALIBRATION, points: [[0.4, 0.36]] });
    expect(next.inference!.assignments).toEqual({ agent: "fireworks/chat-model" });
    expect(validateConfig(next).ok).toBe(true);
  });

  it("refuses when the decision API was removed or changed during the run", () => {
    expect(() =>
      withStoredCalibration(config(), "fireworks", "rune", CALIBRATION, FITTED_ON),
    ).toThrow('Backend "fireworks" no longer has a decision API');
    expect(() => withStoredCalibration(config(), "gone", "rune", CALIBRATION, FITTED_ON)).toThrow(
      'Backend "gone" no longer has a decision API',
    );
    expect(() =>
      withStoredCalibration(
        config({ url: FITTED_ON.url, scoreField: "expected_level" }),
        "fireworks",
        "rune",
        CALIBRATION,
        FITTED_ON,
      ),
    ).toThrow('Backend "fireworks"\'s decision API changed during calibration; calibrate it again');
  });
});

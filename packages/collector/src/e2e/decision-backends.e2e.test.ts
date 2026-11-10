// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  decisionFingerprint,
  parseDecisionCassette,
  type DecisionAnswer,
  type DecisionQuestion,
} from "@omnesis/core";

import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  startDecisionProviderServer,
  type DecisionProviderServer,
} from "./decision-provider-server.js";

/**
 * Decision backends on a stable gateway, end to end: an operator adds decision
 * model providers through the same config write the portal and the apps make,
 * and the production registry, decision service, clients and gates use them.
 *
 * One scripted provider speaks every wire format Omnesis supports — System One
 * with each auth header, Fastino's score field, Workers AI's envelope, and
 * OpenAI Decisions — so each format is exercised through the gateway. Answers
 * are scripted by content: whether a judgement is good is the eval lane's
 * concern, not this suite's.
 *
 * Calibration replays the bundled Jev reference set through the assigned model;
 * the scripted model rates every reference email higher than Jev did, so the
 * fitted map has something to correct.
 */

type Db = InstanceType<typeof Database>;

const KEY = "sk-scripted-provider";
const REFERENCE = parseDecisionCassette(
  readFileSync(
    new URL("../../../gateway/decision-reference/jev-worth.jsonl", import.meta.url),
    "utf8",
  ),
);

function subjectOf(state: unknown): string {
  return String((state as { subject?: unknown } | null)?.subject ?? "");
}

/** Universe email: even subject lengths are junk, odd worth recording. */
const lowWorth = (subject: string) => subject.length % 2 === 0;

function answer(id: string, question: DecisionQuestion, state: unknown): DecisionAnswer {
  if (question.type === "score" && id === "worth_score") {
    const reference = REFERENCE.get(decisionFingerprint({ state, questions: { [id]: question } }));
    const jev = reference?.response.answers.worth_score;
    if (jev?.type === "score") return { type: "score", score: 3 * Math.sqrt(jev.score / 3) };
    return { type: "score", score: lowWorth(subjectOf(state)) ? 0.3 : 2.6 };
  }
  if (question.type === "choice") {
    const utterance = String((state as { utterance?: unknown } | null)?.utterance ?? "");
    const keys = Object.keys(question.criteria);
    return { type: "choice", choice: utterance.trim().endsWith("?") ? keys[0]! : keys[1]! };
  }
  if (question.type === "noul") return { type: "noul", noul: 0.9 };
  return { type: "score", score: 1 };
}

async function waitForGate(db: Db): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { extracting, untried } = db
      .prepare<[], { extracting: number; untried: number }>(
        `SELECT (SELECT COUNT(*) FROM documents WHERE dates_extracted_at IS NULL) AS extracting,
                (SELECT COUNT(*) FROM date_mention_judgements
                  WHERE verdict = 'pending' AND attempts = 0) AS untried`,
      )
      .get()!;
    if (extracting === 0 && untried === 0) return;
    if (Date.now() > deadline) throw new Error(`Still ${extracting} to scan, ${untried} to judge`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface Overview {
  decisionPresets?: Array<{ id: string; models: Array<{ id: string }> }>;
  assignmentDisplays: Record<string, { providerId: string; modelName: string }>;
  inference: {
    allowRemoteInference?: boolean;
    assignments: Record<string, Record<string, unknown>>;
    decisionBackends?: Record<string, Record<string, unknown>>;
  };
}

describe("decision backends — stable gateway, every wire format", () => {
  let harness: SyntheticE2EHarness;
  let provider: DecisionProviderServer;

  const overview = () => harness.gatewayJson<Overview>("/admin/models");
  const patch = (inference: unknown) =>
    harness.gatewayFetch("/admin/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inference }),
    });
  const post = (path: string, body?: unknown) =>
    harness.gatewayJson<Record<string, unknown>>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const capture = async (text: string) => {
    const res = await harness.gatewayFetch("/capture/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { route: string }).route;
  };

  beforeAll(async () => {
    provider = await startDecisionProviderServer({
      apiKey: KEY,
      models: [
        "kev",
        "microsoft-decision-1",
        "fastino/GLiDE",
        "gpt-6-luna",
        "@cf/cloudflare/clef-flash",
      ],
      answer,
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      extraGatewayEnv: { OMNESIS_TYPESAFE_API_KEY: "", TYPESAFE_API_KEY: "" },
      extraGatewayConfig: { enrichment: { dates: { worthGate: true } } },
    });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
    await provider?.close();
  }, 15_000);

  test("offers every decision provider, with models.dev's models, before any is added", async () => {
    const o = await overview();
    const ids = (o.decisionPresets ?? []).map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "ollaya",
        "ollama",
        "typesafe",
        "openrouter",
        "cloudflare",
        "openai",
      ]),
    );
    const openrouter = o.decisionPresets!.find((p) => p.id === "openrouter")!;
    expect(openrouter.models.length).toBeGreaterThan(10);
    expect(o.inference.decisionBackends).toEqual({});
    expect(o.inference.assignments.decision).toMatchObject({ kind: "disabled" });
  });

  test("refuses a decision backend named like a built-in assignment prefix", async () => {
    const res = await patch({
      decisionBackends: { local: { url: `${provider.url}/v1/systemone` } },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Decision backend name cannot be");
  });

  test("adds a local decision backend and assigns it in one write, with no key and no consent", async () => {
    const res = await patch({
      decisionBackends: { box: { preset: "ollaya", url: `${provider.url}/v1/systemone` } },
      assignments: { decision: "box/kev" },
    });
    expect(res.status).toBe(200);
    const o = await overview();
    expect(o.inference.assignments.decision).toMatchObject({
      kind: "decision",
      backendKey: "box",
      preset: "ollaya",
      model: "kev",
      onHost: true,
      calibrated: false,
      available: true,
    });
    expect(o.assignmentDisplays.decision).toMatchObject({ providerId: "ollaya", modelName: "kev" });
    expect(o.inference.allowRemoteInference).toBeFalsy();
  });

  test("refuses a model the server does not have when it is assigned", async () => {
    const res = await patch({ assignments: { decision: "box/kevv" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('The server has no model \\"kevv\\"');
    expect((await overview()).inference.assignments.decision).toMatchObject({ model: "kev" });
  });

  test("lists the server's models and verifies one", async () => {
    const probe = await post("/admin/inference/decision-backends/box/probe");
    expect(probe).toMatchObject({ ok: true, listed: true });
    expect(probe.models).toContain("kev");
    const verify = await post("/admin/inference/decision-backends/box/verify", { model: "kev" });
    expect(verify).toMatchObject({ ok: true, answeredBy: "kev-20261101" });
  });

  test("keeps every key out of omnesis.json and sends each provider's own auth", async () => {
    const res = await patch({
      decisionBackends: {
        router: { url: `${provider.url}/keyed/v1/systemone`, keyRequired: true, apiKey: KEY },
        foundry: {
          preset: "azure-foundry",
          url: `${provider.url}/foundry/providers/microsoft/v1/systemone`,
          auth: "api-key",
          apiKey: KEY,
        },
        fastino: {
          preset: "fastino",
          url: `${provider.url}/fastino/v1/systemone`,
          auth: "x-api-key",
          scoreField: "expected_level",
          apiKey: KEY,
        },
        cf: {
          preset: "cloudflare",
          url: `${provider.url}/client/v4/accounts/acct-1/ai/run`,
          protocol: "workers-ai",
          apiKey: KEY,
        },
        openai: {
          preset: "openai",
          url: `${provider.url}/v1/decisions`,
          protocol: "openai-decisions",
          apiKey: KEY,
        },
        wrongkey: { url: `${provider.url}/keyed/v1/systemone`, apiKey: "sk-wrong" },
      },
    });
    expect(res.status).toBe(200);
    const onDisk = readFileSync(join(harness.getConfigDir(), "omnesis.json"), "utf8");
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).not.toContain("sk-wrong");
    const backends = (await overview()).inference.decisionBackends!;
    for (const key of ["router", "foundry", "fastino", "cf", "openai", "wrongkey"]) {
      expect(backends[key], key).toMatchObject({ hasApiKey: true });
    }
    expect(JSON.stringify(backends)).not.toContain(KEY);

    for (const [key, model] of [
      ["router", "kev"],
      ["foundry", "microsoft-decision-1"],
      ["fastino", "fastino/GLiDE"],
      ["cf", "@cf/cloudflare/clef-flash"],
      ["openai", "gpt-6-luna"],
    ] as const) {
      const verify = await post(`/admin/inference/decision-backends/${key}/verify`, { model });
      expect(verify, key).toMatchObject({ ok: true });
    }
    expect(provider.callsTo("/keyed").at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(provider.callsTo("/foundry").at(-1)!.headers).toMatchObject({
      "api-key": KEY,
      authorization: undefined,
    });
    expect(provider.callsTo("/fastino").at(-1)!.headers["x-api-key"]).toBe(KEY);
    expect(provider.callsTo("/client/v4").at(-1)!.body.model).toBe("clef-flash");
    expect(provider.callsTo("/v1/decisions").at(-1)!.body.questions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "predicate", name: "verify_noul" })]),
    );

    const refused = await post("/admin/inference/decision-backends/wrongkey/verify", {
      model: "kev",
    });
    expect(refused).toMatchObject({ ok: false, status: 401 });
    expect(String(refused.reason)).toContain("The API key was refused");
  });

  test("saves a corrected key and the assignment in one write, without testing the old key", async () => {
    // `wrongkey` holds a refused key; assigning it alone is refused...
    const alone = await patch({ assignments: { decision: "wrongkey/kev" } });
    expect(alone.status).toBe(400);
    expect(await alone.text()).toContain("The API key was refused");
    // ...but replacing the key in the same write saves, and the new key works.
    const fixed = await patch({
      decisionBackends: { wrongkey: { apiKey: KEY } },
      assignments: { decision: "wrongkey/kev" },
    });
    expect(fixed.status).toBe(200);
    const verify = await post("/admin/inference/decision-backends/wrongkey/verify", {
      model: "kev",
    });
    expect(verify).toMatchObject({ ok: true });
  });

  test("lists an unsaved server's models", async () => {
    const probe = await post("/admin/inference/decision-backends/probe", {
      url: `${provider.url}/v1/systemone`,
    });
    expect(probe).toMatchObject({ ok: true, listed: true });
    expect(probe.models).toContain("kev");
  });

  test("leaves a backend off this host unused until remote inference is allowed", async () => {
    const before = provider.calls.length;
    expect(
      (await patch({ decisionBackends: { lan: { url: "http://192.0.2.1:9/v1/systemone" } } }))
        .status,
    ).toBe(200);
    const verify = await post("/admin/inference/decision-backends/lan/verify", { model: "kev" });
    expect(verify).toMatchObject({ ok: false });
    expect(String(verify.reason)).toContain("send data off your machine");
    expect(provider.calls.length).toBe(before);
  });

  test("judges every email through the decision backend at the mention worth gate", async () => {
    await harness.syncAllSources();
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      await waitForGate(db);
      const rows = db
        .prepare<
          [],
          { subject: string | null; verdict: string; requested: string; model: string | null }
        >(
          `SELECT d.title AS subject, c.verdict, c.requested_model_id AS requested, c.model_id AS model
             FROM cognition_decisions c LEFT JOIN documents d ON d.id = c.subject_document_id
            WHERE c.purpose = 'mention-worth'`,
        )
        .all();
      const answered = rows.filter((r) => r.verdict === "pass" || r.verdict === "skip");
      expect(answered.length).toBeGreaterThan(0);
      expect(answered.length).toBe(rows.length);
      for (const row of answered) {
        expect(row.requested).toBe("kev");
        expect(row.model).toBe("kev-20261101");
        expect(row.verdict).toBe(lowWorth(row.subject ?? "") ? "skip" : "pass");
      }
    } finally {
      db.close();
    }
  }, 180_000);

  test("routes a voice capture through each wire format", async () => {
    for (const [assignment, path] of [
      ["box/kev", "/v1/systemone"],
      ["foundry/microsoft-decision-1", "/foundry"],
      ["fastino/fastino/GLiDE", "/fastino"],
      ["cf/@cf/cloudflare/clef-flash", "/client/v4"],
      ["openai/gpt-6-luna", "/v1/decisions"],
    ] as const) {
      expect((await patch({ assignments: { decision: assignment } })).status, assignment).toBe(200);
      const before = provider.callsTo(path).length;
      expect(await capture("When is the dentist appointment?"), assignment).toBe("ask");
      expect(await capture("Remember that the gate code is 4417."), assignment).toBe("note");
      expect(provider.callsTo(path).length - before, assignment).toBe(2);
    }
  });

  test("calibrates the assigned model onto Jev's scale and answers with the calibration", async () => {
    expect((await patch({ assignments: { decision: "box/kev" } })).status).toBe(200);
    const started = await harness.gatewayFetch("/admin/models/decision/calibration", {
      method: "POST",
    });
    expect(started.status).toBe(202);
    let status: Record<string, unknown> = await started.json();
    expect(status).toMatchObject({ state: "running", assignment: "box/kev" });
    const deadline = Date.now() + 120_000;
    while (status.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await harness.gatewayJson("/admin/models/decision/calibration");
    }
    expect(status).toMatchObject({ state: "done", failed: 0 });
    const result = status.result as Record<string, number>;
    expect(result.samples).toBe(REFERENCE.size);
    // The scripted model rates every reference email higher than Jev did:
    // calibrated, it keeps about 95% of what Jev keeps and skips far more of the rest.
    expect(result.keepsBefore).toBe(1);
    expect(result.keeps).toBeGreaterThanOrEqual(0.94);
    expect(result.skips).toBeGreaterThan(result.skipsBefore!);
    expect(result.skips).toBeGreaterThanOrEqual(0.99);

    const o = await overview();
    expect(o.inference.assignments.decision).toMatchObject({ calibrated: true });
    expect(o.inference.decisionBackends!.box!.calibrations).toHaveProperty("kev");
    expect(readFileSync(join(harness.getConfigDir(), "omnesis.json"), "utf8")).toContain(
      '"calibration"',
    );

    // Decisions now carry the calibration: the spend ledger names the model as calibrated.
    expect(await capture("Remember to water the ferns on Friday.")).toBe("note");
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const models = db
        .prepare<[], { model_id: string }>(
          `SELECT model_id FROM cognition_spend WHERE mechanism = 'capture-decision'`,
        )
        .all()
        .map((r) => r.model_id);
      expect(models).toContain("kev-20261101+cal");
    } finally {
      db.close();
    }
  }, 180_000);

  test("refuses to calibrate TypeSafe's Jev, the reference itself", async () => {
    expect((await patch({ assignments: { decision: "typesafe/jev-1.13.0" } })).status).toBe(200);
    const res = await harness.gatewayFetch("/admin/models/decision/calibration", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  test("removing the assigned backend leaves the role unresolved, naming it", async () => {
    expect((await patch({ assignments: { decision: "box/kev" } })).status).toBe(200);
    expect((await patch({ decisionBackends: { box: null } })).status).toBe(200);
    const o = await overview();
    expect(o.inference.decisionBackends).not.toHaveProperty("box");
    expect(o.inference.assignments.decision).toMatchObject({
      kind: "unresolved",
      reason: 'Unknown backend "box" in assignment "box/kev"',
    });
  });
});

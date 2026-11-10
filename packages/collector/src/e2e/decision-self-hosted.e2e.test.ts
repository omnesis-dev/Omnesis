// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";
import { startChatLogprobsServer, type ChatLogprobsServer } from "./chat-logprobs-server.js";
import {
  startDecisionServer,
  type DecisionServer,
  type DecisionServerRequest,
} from "./brain-bench/decision-server.js";

/**
 * The decision role on self-hosted backends, end to end on a gateway whose
 * mention worth gate is on: every email with a date mention is judged once,
 * through the production registry, decision service and client, and each
 * judgement lands in the decision ledger. A chat model serves the role only in
 * experimental mode (its scores are not on TypeSafe Jev's scale), so that
 * suite boots an experimental gateway; a TypeSafe endpoint on this host is
 * stable.
 *
 * Scores are scripted from the email's subject so the corpus splits
 * deterministically; whether a score is a good judgement is the eval lane's
 * concern, not this suite's.
 */

type Db = InstanceType<typeof Database>;

/** Wait until extraction is done and every pending judgement was tried at least once. */
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
    if (Date.now() > deadline) {
      throw new Error(`Still ${extracting} documents to scan and ${untried} to judge`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface LedgerRow {
  subject: string | null;
  verdict: string;
  requested_model_id: string;
  model_id: string | null;
  score: number | null;
  error: string | null;
}

function ledger(db: Db): LedgerRow[] {
  return db
    .prepare<[], LedgerRow>(
      `SELECT d.title AS subject, c.verdict, c.requested_model_id, c.model_id, c.score, c.error
         FROM cognition_decisions c LEFT JOIN documents d ON d.id = c.subject_document_id
        WHERE c.purpose = 'mention-worth'`,
    )
    .all();
}

/** The email subject the rendered prompt carries. */
function subjectOf(user: string): string {
  const match = /"subject":"((?:[^"\\]|\\.)*)"/.exec(user);
  if (!match) throw new Error("prompt carries no subject");
  return JSON.parse(`"${match[1]}"`) as string;
}

describe("decision role — an OpenAI-compatible server read through its logprobs", () => {
  let harness: SyntheticE2EHarness;
  let server: ChatLogprobsServer;
  // An email whose subject length is a multiple of three gets a reply without
  // logprobs; otherwise even lengths score low and odd lengths high.
  const unsupported = (subject: string) => subject.length % 3 === 0;
  const low = (subject: string) => subject.length % 2 === 0;

  beforeAll(async () => {
    server = await startChatLogprobsServer({
      model: "decider-7b",
      policy: (user): Readonly<Record<string, number>> | null => {
        const subject = subjectOf(user);
        if (unsupported(subject)) return null;
        return low(subject) ? { "0": 0.85, "1": 0.1, The: 0.05 } : { "3": 0.8, "2": 0.15, I: 0.05 };
      },
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "default",
      extraInference: {
        backends: { decider: { type: "http", url: server.url } },
        assignments: { decision: "decider/decider-7b" },
      },
      extraGatewayConfig: { enrichment: { dates: { worthGate: true } } },
    });
    await harness.start();
    await harness.syncAllSources();
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
    await server?.close();
  }, 15_000);

  test("judges each email from the label probabilities and fails open without them", async () => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      await waitForGate(db);

      // Every call asked for one token and its logprobs, with a score's labels.
      expect(server.calls.length).toBeGreaterThan(0);
      for (const call of server.calls) {
        expect(call.body).toMatchObject({
          model: "decider-7b",
          max_tokens: 1,
          temperature: 0,
          logprobs: true,
          top_logprobs: 20,
        });
        expect(call.user).toMatch(/Answer with exactly one label \(0, 1, 2(, \d)*\)\.$/);
      }

      const rows = ledger(db);
      const answered = rows.filter((r) => r.verdict === "pass" || r.verdict === "skip");
      const unavailable = rows.filter((r) => r.verdict === "unavailable");
      expect(answered.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.requested_model_id).toBe("http:decider/decider-7b");
      for (const row of answered) {
        expect(row.model_id).toBe("http:decider/decider-7b");
        // The label probabilities, renormalized over the labels and weighted
        // by level: (1 × 0.1) / 0.95 for low email, (3 × 0.8 + 2 × 0.15) / 0.95
        // for high.
        expect(row.subject).not.toBeNull();
        expect(row.score!).toBeCloseTo(low(row.subject!) ? 0.1 / 0.95 : 2.7 / 0.95, 5);
      }

      // A reply without logprobs is no answer: the ledger says why, nothing is
      // dropped, and the email's mentions stay in time queries.
      expect(server.calls.some((c) => !c.withLogprobs)).toBe(true);
      expect(unavailable.length).toBeGreaterThan(0);
      for (const row of unavailable) {
        expect(unsupported(row.subject ?? "")).toBe(true);
        expect(row.model_id).toBeNull();
        expect(row.error).toMatch(/no logprobs/);
      }
      const verdicts = db
        .prepare<[], { subject: string | null; verdict: string }>(
          `SELECT d.title AS subject, j.verdict
             FROM date_mention_judgements j JOIN documents d ON d.id = j.document_id
            WHERE json_extract(d.metadata, '$.documentType') = 'email'`,
        )
        .all();
      const dropped = verdicts.filter((v) => v.verdict === "drop");
      const kept = verdicts.filter((v) => v.verdict === "keep");
      expect(dropped.length).toBeGreaterThan(0);
      expect(kept.length).toBeGreaterThan(0);
      for (const v of [...dropped, ...kept]) expect(unsupported(v.subject ?? "")).toBe(false);
      for (const v of dropped) expect(low(v.subject ?? "")).toBe(true);
    } finally {
      db.close();
    }
  }, 180_000);
});

describe("decision role — a self-hosted TypeSafe endpoint on this host", () => {
  let harness: SyntheticE2EHarness;
  let decision: DecisionServer;

  beforeAll(async () => {
    decision = await startDecisionServer({
      policy: (request: DecisionServerRequest) => ({
        worth_score: {
          type: "score",
          score:
            String((request.state as { subject?: unknown }).subject).length % 2 === 0 ? 0.2 : 2.4,
        },
      }),
      acceptKeyless: true,
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      // No key anywhere, and remote inference stays off: nothing leaves the host.
      extraGatewayEnv: { OMNESIS_TYPESAFE_API_KEY: "", TYPESAFE_API_KEY: "" },
      extraInference: {
        typesafeUrl: decision.endpoint,
        assignments: { decision: `typesafe/${decision.modelId}` },
      },
      extraGatewayConfig: { enrichment: { dates: { worthGate: true } } },
    });
    await harness.start();
    await harness.syncAllSources();
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
    await decision?.close();
  }, 15_000);

  test("serves the worth gate with no key and no remote inference", async () => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      await waitForGate(db);
      expect(decision.calls.length).toBeGreaterThan(0);
      for (const call of decision.calls) {
        expect(call.authorization).toBeNull();
        expect(call.status).toBe(200);
      }
      const rows = ledger(db);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.requested_model_id).toBe(decision.modelId);
        expect(["pass", "skip"]).toContain(row.verdict);
      }
    } finally {
      db.close();
    }
  }, 180_000);
});

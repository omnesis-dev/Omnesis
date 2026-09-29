// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — the worth gate answered from recorded decision cassettes.
 *
 * The harness's `decisionBackend: "replay"` assigns the `decision` role to
 * `replay` and points `OMNESIS_DECISION_FIXTURE` at the universe's
 * `decisionCassettes` directory (`loops-test-life/decision-cassettes/`,
 * generated from `worth-gate-mail.ts` by `scripts/write-worth-gate-cassettes.mjs`).
 * No decision server exists: every answer comes from the cassette by request
 * fingerprint, so the same emails reach the same verdicts the scripted model
 * gives them — with no network.
 *
 * A request the cassettes do not hold is a miss: the replay backend throws,
 * the gate fails open, and the ledger records the miss as `unavailable`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  WORTH_MAIL,
  compressCognitionCadences,
  passesWorthGate,
  worthAnswersFor,
  worthMailDoc,
  worthRequestFor,
  WORTH_GATE_MODEL_ID,
  type WorthMail,
} from "./brain-bench/index.js";

compressCognitionCadences();

describe("worth gate: replayed decisions", () => {
  let bench: BrainBench;
  const JUDGED: readonly WorthMail[] = [
    WORTH_MAIL.promotion,
    WORTH_MAIL.newsletter,
    WORTH_MAIL.booking,
    WORTH_MAIL.friend,
  ];
  /** Same sender and subject as a recorded email, different body — so a different request. */
  const UNRECORDED: WorthMail = {
    ...WORTH_MAIL.friend,
    key: "unrecorded",
    externalId: "wg-friend-unrecorded",
    content: "Hi Alex, change of plan: could we move dinner to Saturday instead? Maya",
  };
  const ids = new Map<string, string>();

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: { mergeAdjudication: { enabled: false } },
      decisionBackend: "replay",
    });
    await bench.drainUntilQuiet();
    expect((await bench.obs.runs({ kind: "data" })).items).toHaveLength(0);

    const docs = [...JUDGED, UNRECORDED];
    const docIds = await bench.pushAndSettle(docs.map((mail) => worthMailDoc(mail)));
    docs.forEach((mail, i) => ids.set(mail.key, docIds[i]!));
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("no decision server is running", () => {
    expect(() => bench.decision).toThrow(/no decision server/);
  });

  test("each recorded email reaches the verdict its cassette answer implies", async () => {
    for (const mail of JUDGED) {
      const run = await bench.obs.runForDoc(ids.get(mail.key)!);
      const agentTurns = bench.puppetCalls.filter((c) => c.runId === run.id).length;
      expect(run.status, mail.key).toBe("completed");
      if (passesWorthGate(mail)) {
        expect(run.gateVerdict, mail.key).toBe("pass");
        expect(agentTurns, mail.key).toBeGreaterThan(0);
      } else {
        expect(run.gateVerdict, mail.key).toBe("skip");
        expect(agentTurns, mail.key).toBe(0);
        expect(run.usage, mail.key).toBeNull();
      }
    }
  });

  test("the ledger records the replayed answer against the request that was matched", async () => {
    const run = await bench.obs.runForDoc(ids.get("newsletter")!);
    const { decisions } = await bench.obs.run(run.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      verdict: "skip",
      score: WORTH_MAIL.newsletter.score,
      // Attributed to replay, naming the model that originally answered; the
      // request names the backend that asked.
      modelId: `replay:${WORTH_GATE_MODEL_ID}`,
      error: null,
    });
    expect(decisions[0]!.request).toEqual({
      model: "replay",
      ...worthRequestFor(WORTH_MAIL.newsletter),
    });
    expect(decisions[0]!.response).toEqual({
      model: `replay:${WORTH_GATE_MODEL_ID}`,
      answers: worthAnswersFor(WORTH_MAIL.newsletter),
    });
  });

  test("an unrecorded request is a miss: recorded unavailable, and the run executes", async () => {
    const run = await bench.obs.runForDoc(ids.get(UNRECORDED.key)!);
    expect(run.gateVerdict).toBe("unavailable");
    expect(bench.puppetCalls.filter((c) => c.runId === run.id).length).toBeGreaterThan(0);
    const { decisions } = await bench.obs.run(run.id);
    expect(decisions[0]!.error).toMatch(/No recorded decision for sha256:[0-9a-f]{64}/);
  });
});

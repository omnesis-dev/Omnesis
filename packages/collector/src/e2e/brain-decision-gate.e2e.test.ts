// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — legacy datum recovery and current source discovery.
 *
 * Ingestion now creates maintenance work. Persisted legacy `data` rows still
 * recover through the worth gate: before an email starts its background-agent turn,
 * the drainer asks the `decision` model whether the email is worth one. The
 * model here is a scripted System One stand-in reached through the production
 * TypeSafe client (`typesafe/jev-1.13.0`, a bearer key, `inference.typesafe.url`),
 * so the assignment, key lookup, URL policy, retry ladder, reply validation,
 * decision ledger and admin surface all run for real; only the score is
 * scripted, by subject, from `worth-gate-mail.ts`.
 *
 * Covered:
 *  - what the gate sends: the rubric's exact state for each email;
 *  - a skip settles the run completed with no agent turn, no transcript and no
 *    usage; a pass runs the agent;
 *  - an attachment is judged by its parent email;
 *  - the runs list's `gateVerdict` and the run detail's `decisions`;
 *  - fail-open: a provider outage records `unavailable` and the run executes;
 *  - with the role unassigned there is no gate and no decision.
 *
 * Correctness only: whether a score is a GOOD judgement of an email is the
 * rubric's evaluation, not this suite's.
 */

import "./synth-env.js";
import { parseCognitionDataRunPayload } from "@omnesis/gateway/src/brain/run-payloads.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  sourceInterpretations,
  preserveCurrentOwner,
  EMAIL_WORTH_THRESHOLD,
  WORTH_MAIL,
  attachmentOf,
  compressCognitionCadences,
  passesWorthGate,
  worthAnswersFor,
  worthMailBySubject,
  worthMailDoc,
  worthRequestFor,
  type DecisionServerRequest,
  type WorthMail,
} from "./brain-bench/index.js";

compressCognitionCadences();

/** Score by subject; an email the table does not know fails loudly as a 422. */
function scoreBySubject(request: DecisionServerRequest) {
  const purpose = Object.keys(request.questions)[0]!;
  if (["urgency", "discovery", "impact", "review"].includes(purpose)) {
    const state = request.state as { title?: string; source?: { title: string } };
    const mail = worthMailBySubject(state.source?.title ?? state.title);
    return {
      [purpose]: {
        type: "score" as const,
        score: purpose === "discovery" && mail && !passesWorthGate(mail) ? 0 : 2,
      },
    };
  }
  const mail = worthMailBySubject((request.state as { subject?: unknown }).subject);
  return mail
    ? worthAnswersFor(mail)
    : { httpError: 422, message: `unscripted subject: ${JSON.stringify(request.state)}` };
}

/** A recovered row must carry the same valid payload as the retired enqueuer. */
function legacyDatumPayload(docId: string) {
  const payload = { docId, event: "created" as const, datumAt: Date.now() };
  expect(parseCognitionDataRunPayload(payload)).toEqual(payload);
  return payload;
}

/** Every worth-gate decision recorded against a run, as the ledger holds them. */
function decisionRowCount(bench: BrainBench): number {
  return (
    bench.sql.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_decisions").get()
      ?.n ?? 0
  );
}

/** Puppet completions served for one run — zero means no agent turn happened. */
function agentTurnsFor(bench: BrainBench, runId: string): number {
  return bench.puppetCalls.filter((c) => c.runId === runId).length;
}

const LANES_OFF = {
  mergeAdjudication: { enabled: false },
  knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Scripted decision model
// ═══════════════════════════════════════════════════════════════════════════

describe("worth gate: persisted legacy datum recovery alongside current source discovery", () => {
  let bench: BrainBench;
  const ids = new Map<string, string>();
  const ATTACHMENT = attachmentOf(WORTH_MAIL.booking, "wg-booking-1-itinerary", "itinerary.pdf");
  const JUDGED: readonly WorthMail[] = [
    WORTH_MAIL.promotion,
    WORTH_MAIL.newsletter,
    WORTH_MAIL.booking,
    WORTH_MAIL.friend,
  ];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: {
        dynamic: sourceInterpretations({
          sources: [{ plan: { calls: [] } }],
          maintainNode: preserveCurrentOwner,
        }),
      },
      brain: LANES_OFF,
      decision: { policy: scoreBySubject, inputTokens: 480 },
    });
    // Ambient arrivals use current discovery; they create no legacy datum
    // rows or email-worth requests before the explicit recovery stimulus.
    await bench.drainUntilQuiet();
    expect((await bench.obs.runs({ kind: "data" })).items).toHaveLength(0);
    expect(
      bench.decision.calls.filter((call) => "subject" in (call.request.state as object)),
    ).toHaveLength(0);

    // The parent before its attachment, so the containment resolves whenever
    // the attachment's run is claimed.
    await bench.pushAll([...JUDGED.map((mail) => worthMailDoc(mail)), ATTACHMENT]);
    await bench.drainUntilQuiet();
    for (const mail of JUDGED) ids.set(mail.key, await bench.docId(mail.externalId));
    ids.set("attachment", await bench.docId(ATTACHMENT.externalId));
    // Recover genuine persisted legacy datum rows; ingestion itself only buys maintenance.
    for (const id of ids.values())
      bench.seedRun({
        id: `legacy-worth-${id}`,
        kind: "data",
        payload: legacyDatumPayload(id),
        dedupeKey: `data:doc:${id}`,
        enqueuedAt: Date.now(),
      });
    await bench.drainUntilQuiet();
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the gate sends the rubric's exact state for each email, with a bearer key", () => {
    for (const mail of JUDGED) {
      const calls = bench.decision.callsForSubject(mail.title);
      // The booking may be asked twice: once for its own run and once for the
      // attachment's, when the attachment's run is claimed before the booking's
      // answer is in the ledger to be reused.
      expect(calls.length, mail.key).toBeGreaterThanOrEqual(1);
      expect(calls.length, mail.key).toBeLessThanOrEqual(mail === WORTH_MAIL.booking ? 2 : 1);
      for (const call of calls) {
        expect(call.request).toEqual({ model: bench.decision.modelId, ...worthRequestFor(mail) });
        expect(call.authorization).toMatch(/^Bearer \S+$/);
        expect(call.status).toBe(200);
      }
    }
    // Nothing else was asked: every call is one of the four emails.
    const subjects = new Set(JUDGED.map((m) => m.title));
    for (const call of bench.decision.calls.filter(
      (call) => "subject" in (call.request.state as object),
    )) {
      expect(subjects.has((call.request.state as { subject: string }).subject)).toBe(true);
    }
  });

  test("a low-scored email's run completes with no agent turn, no transcript and no usage", async () => {
    for (const mail of [WORTH_MAIL.promotion, WORTH_MAIL.newsletter]) {
      expect(passesWorthGate(mail)).toBe(false);
      const run = await bench.obs.runForDoc(ids.get(mail.key)!);
      expect(run.status, mail.key).toBe("completed");
      expect(run.usage, mail.key).toBeNull();
      expect(run.gateVerdict, mail.key).toBe("skip");
      expect(agentTurnsFor(bench, run.id), mail.key).toBe(0);
      expect((await bench.obs.transcripts({ runId: run.id })).items, mail.key).toHaveLength(0);
    }
  });

  test("a high-scored email's run executes the agent", async () => {
    for (const mail of [WORTH_MAIL.booking, WORTH_MAIL.friend]) {
      expect(passesWorthGate(mail)).toBe(true);
      const run = await bench.obs.runForDoc(ids.get(mail.key)!);
      expect(run.status, mail.key).toBe("completed");
      expect(run.gateVerdict, mail.key).toBe("pass");
      expect(agentTurnsFor(bench, run.id), mail.key).toBeGreaterThan(0);
      expect((await bench.obs.transcripts({ runId: run.id })).items.length, mail.key).toBe(1);
    }
  });

  test("the run detail carries the decision: request, reply, score, threshold and verdict", async () => {
    const run = await bench.obs.runForDoc(ids.get("promotion")!);
    const { decisions } = await bench.obs.run(run.id);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d).toMatchObject({
      purpose: "worth-gate",
      lane: "data",
      verdict: "skip",
      score: WORTH_MAIL.promotion.score,
      threshold: EMAIL_WORTH_THRESHOLD,
      modelId: bench.decision.modelId,
      documentId: ids.get("promotion"),
      subjectDocumentId: ids.get("promotion"),
      inheritedFromParent: false,
      reusedFrom: null,
      error: null,
      inputTokens: 480,
    });
    expect(d.subjectDoc?.id).toBe(ids.get("promotion"));
    expect(d.request).toEqual({
      model: bench.decision.modelId,
      ...worthRequestFor(WORTH_MAIL.promotion),
    });
    expect(d.response).toEqual({
      model: bench.decision.modelId,
      answers: worthAnswersFor(WORTH_MAIL.promotion),
    });
  });

  test("an attachment is judged by its parent email and rides on its verdict", async () => {
    const run = await bench.obs.runForDoc(ids.get("attachment")!);
    expect(run.gateVerdict).toBe("pass");
    expect(agentTurnsFor(bench, run.id)).toBeGreaterThan(0);

    const { decisions } = await bench.obs.run(run.id);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d).toMatchObject({
      verdict: "pass",
      score: WORTH_MAIL.booking.score,
      documentId: ids.get("attachment"),
      subjectDocumentId: ids.get("booking"),
      inheritedFromParent: true,
    });
    expect(d.subjectDoc?.id).toBe(ids.get("booking"));
    // Either the parent's answer was reused (no request of its own), or the
    // attachment's run was claimed first and asked about the PARENT's content.
    if (d.reusedFrom !== null) {
      expect(d.request).toBeNull();
    } else {
      expect(d.request).toEqual({
        model: bench.decision.modelId,
        ...worthRequestFor(WORTH_MAIL.booking),
      });
    }
  });

  test("the decision model's tokens are recorded as worth-gate spend", async () => {
    const { rows } = await bench.obs.mechanismSpend();
    const gate = rows.filter((r) => r.mechanism === "worth-gate");
    expect(gate.length).toBeGreaterThan(0);
    expect(gate.every((r) => r.modelId === bench.decision.modelId)).toBe(true);
    const calls = bench.decision.calls.filter(
      (c) => c.status === 200 && "subject" in (c.request.state as object),
    ).length;
    expect(gate.reduce((sum, r) => sum + r.promptTokens, 0)).toBe(480 * calls);
    expect(gate.reduce((sum, r) => sum + r.completionTokens, 0)).toBe(0);
  });

  test("an outage fails open: the run executes and the decision is recorded unavailable", async () => {
    const outage = [WORTH_MAIL.receipt, WORTH_MAIL.invitation];
    await bench.pushAll(outage.map((mail) => worthMailDoc(mail)));
    await bench.drainUntilQuiet();
    // Target persisted legacy recovery, after independent live discovery settles.
    bench.decision.refuseWith(529, "overloaded");
    try {
      for (const mail of outage) {
        const id = await bench.docId(mail.externalId);
        bench.seedRun({
          id: `legacy-worth-outage-${id}`,
          kind: "data",
          payload: legacyDatumPayload(id),
          dedupeKey: `data:doc:${id}`,
          enqueuedAt: Date.now(),
        });
      }
      await bench.drainUntilQuiet();
      for (const mail of outage) {
        // The client retries 529 before giving up; every attempt was refused.
        const calls = bench.decision.callsForSubject(mail.title);
        expect(calls.length, mail.key).toBeGreaterThanOrEqual(1);
        expect(
          calls.every((c) => c.status === 529),
          mail.key,
        ).toBe(true);

        const run = await bench.obs.runForDoc(await bench.docId(mail.externalId));
        expect(run.status, mail.key).toBe("completed");
        expect(run.gateVerdict, mail.key).toBe("unavailable");
        expect(agentTurnsFor(bench, run.id), mail.key).toBeGreaterThan(0);

        const { decisions } = await bench.obs.run(run.id);
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({
          verdict: "unavailable",
          score: null,
          response: null,
          reusedFrom: null,
          modelId: bench.decision.modelId,
        });
        expect(decisions[0]!.error).toMatch(/529/);
        // The request is kept even when unanswered, so the audit shows what was asked.
        expect(decisions[0]!.request).toEqual({
          model: bench.decision.modelId,
          ...worthRequestFor(mail),
        });
      }
    } finally {
      bench.decision.refuseWith(null);
    }
  }, 180_000);

  test("current discovery independently gates low-worth sources and records normalized metadata", async () => {
    for (const mail of JUDGED) {
      const id = ids.get(mail.key)!;
      const coverage = bench.sql
        .prepare<
          [string],
          { status: string }
        >("SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='organization'")
        .get(id);
      expect(coverage?.status).toBe(passesWorthGate(mail) ? "considered" : "gated");
      if (passesWorthGate(mail))
        expect((await bench.obs.interpretationForSource(id)).kind).toBe("synthesis");
      else expect(await bench.obs.runsForSource(id)).toEqual([]);
    }
    const decisions = bench.sql
      .prepare<
        [],
        { purpose: string; score: number | null; rubric_version: string }
      >("SELECT purpose,score,rubric_version FROM knowledge_decisions")
      .all();
    expect(decisions.length).toBeGreaterThan(0);
    expect(
      decisions.every((entry) => entry.score === null || (entry.score >= 0 && entry.score <= 1)),
    ).toBe(true);
    expect(
      decisions.every(
        (entry) =>
          entry.rubric_version ===
          (entry.purpose === "discovery"
            ? "knowledge-discovery-value-v3"
            : "knowledge-decisions-v2"),
      ),
    ).toBe(true);
  });

  test("every judged run has exactly one ledger row", () => {
    // 4 emails + the attachment + the 2 outage emails.
    expect(decisionRowCount(bench)).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// No decision model
// ═══════════════════════════════════════════════════════════════════════════

describe("worth gate: absent while the decision role is unassigned", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: LANES_OFF,
      behaviors: {
        dynamic: sourceInterpretations({
          sources: [{ plan: { calls: [] } }],
          maintainNode: preserveCurrentOwner,
        }),
      },
    });
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a low-worth email still gets its agent run, and nothing is judged", async () => {
    const [docId] = await bench.pushAndSettle([worthMailDoc(WORTH_MAIL.promotion)]);
    const run = await bench.obs.interpretationForSource(docId!);
    expect(run.status).toBe("completed");
    expect(run.kind).toBe("synthesis");
    expect(run.gateVerdict).toBeNull();
    expect(agentTurnsFor(bench, run.id)).toBeGreaterThan(0);
    expect((await bench.obs.run(run.id)).decisions).toEqual([]);
    expect(decisionRowCount(bench)).toBe(0);
  });
});

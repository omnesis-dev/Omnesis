// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two verdicts that read silence as a fault, produced by a real runtime.
 *
 * `never-matched` and `judge-declines-everything` are the ones an operator acts
 * on, and they were also the two nothing had ever produced outside a unit test:
 * a healthy install makes neither, which is the correct answer for it and
 * leaves two of the five paths unexercised from the arm that declines through
 * to the sentence on the row. The rules are a pure function and are tested as
 * one; what is not covered by that is everything between — the trace class the
 * runtime writes when an arm takes nothing up, the durable count the judge
 * leaves behind, and the route that reads both.
 *
 * So both are driven here: real documents, a real recall arm, a real judge, and
 * the verdict read off `/admin/watch/watches` exactly as a surface reads it.
 *
 * **One thing is not real, and it cannot be.** A verdict that reads silence as
 * a fault waits for a week of it, deliberately — so the watch's install date is
 * moved back in the store rather than waited out. Everything the watch has
 * *done* is produced by the runtime; only its age is stated.
 */

import "./synth-env.js";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface Verdict {
  name: string;
  because: string;
  label: string;
  actionable: boolean;
}

interface WatchRow {
  id: string;
  name: string;
  status: string;
  verdict: Verdict | null;
}

/** How many documents the `never-matched` rule wants looked at. */
const ENOUGH_LOOKS = 200;
/** And how many judgements before "it always says no" is a claim. */
const ENOUGH_JUDGEMENTS = 10;
/**
 * How many emails the judged watch is given.
 *
 * Comfortably past the threshold, and asserted *exactly* in the sentence the
 * verdict produces. The count is of documents, one per subject the judge was
 * asked about — so a regression that collapsed several subjects onto one row
 * would still clear the threshold and still read as this verdict, while
 * reporting a smaller number. Pinning the number is what notices.
 */
const JUDGED_EMAILS = ENOUGH_JUDGEMENTS + 4;

/**
 * A judge that answers, and always says no.
 *
 * The distinction the verdict rests on: a judge that could not be *reached*
 * decides nothing and must not count, where one that answers and refuses is
 * saying something about the proposition. So this is a real completion server
 * returning a real verdict rather than an outage.
 */
function alwaysDeclines(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const payload = JSON.stringify({
        id: "judge-stub",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: '{"decision":"not_matched","because":"it is not one of those"}',
            },
          },
        ],
      });
      res.writeHead(200, { "content-type": "application/json" }).end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/**
 * A watch whose arm nominates every email, and whose judge refuses each one.
 *
 * Lexical rather than semantic, so what is measured is the runtime's own
 * bookkeeping rather than an embedder's opinion: the term is one every
 * document below carries, so nomination is deterministic.
 */
function everyEmailJudged(fingerprint: string): unknown {
  return {
    watch: {
      name: "judged-by-nobody",
      firing_policy: "stays_active",
      ontology_fingerprint: fingerprint,
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          recall: { lexical: { terms: ["quotation"], match: "token" } },
          judge: {
            proposition: "the message is about a delivery that has already arrived",
            output_schema: { because: "string" },
          },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
    },
  };
}

/**
 * A watch whose arm takes nothing up at all.
 *
 * The term appears in no document, so every event is `ignored` — which is the
 * class the decline count is built from, and the one shape that produces a
 * watch looking at everything and admitting none of it.
 */
function nothingEverMatches(fingerprint: string): unknown {
  return {
    watch: {
      name: "arm-that-admits-nothing",
      firing_policy: "stays_active",
      ontology_fingerprint: fingerprint,
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          recall: { lexical: { terms: ["zzzunmatchable"], match: "token" } },
          judge: {
            proposition: "the message is about a thing that never happens",
            output_schema: { because: "string" },
          },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
    },
  };
}

let harness: SyntheticE2EHarness;
let judge: { server: Server; url: string };

beforeEach(async () => {
  judge = await alwaysDeclines();
  harness = new SyntheticE2EHarness({
    gatewayMode: "experimental",
    universe: "e2e-minimal",
    extraInference: {
      backends: { judgestub: { type: "http", url: judge.url } },
      assignments: { "watch-judge": "judgestub/always-declines" },
    },
    // A budget high enough that the judge is never deferred: a deferral is not
    // a decision and is not counted, so a capped run would stall short of the
    // threshold and the test would time out reporting nothing useful. Under
    // `gateway`, where the knob lives — the config schema is strict, so a
    // top-level `watch` block is stripped at boot with only a log line.
    extraGatewayConfig: {
      gateway: { watch: { judge: { dailyCap: 500, perWatchDailyCap: 500 } } },
    },
  });
  await harness.start();
}, 240_000);

afterEach(async () => {
  await harness.destroy();
  await new Promise<void>((done) => judge.server.close(() => done()));
}, 15_000);

async function fingerprint(): Promise<string> {
  const { fingerprint } = await harness.gatewayJson<{ fingerprint: string }>(
    "/admin/watch/ontology",
  );
  return fingerprint;
}

async function addWatch(dsl: unknown): Promise<string> {
  const { watch } = await harness.gatewayJson<{ watch: { id: string } }>("/admin/watch/watches", {
    method: "POST",
    body: JSON.stringify({ dsl, fromSeq: 0 }),
  });
  return watch.id;
}

async function verdictOf(id: string): Promise<Verdict | null> {
  const { watches } = await harness.gatewayJson<{ watches: WatchRow[] }>("/admin/watch/watches");
  return watches.find((watch) => watch.id === id)?.verdict ?? null;
}

/**
 * Move a watch's install date back, in the store the gateway is running on.
 *
 * The one thing about these verdicts that cannot be produced in a test: they
 * wait for a week of silence on purpose, and the alternative to stating the
 * date is a suite that takes one. Written straight to the definitions table
 * because there is no surface for it — a watch's install date is not a thing
 * an operator sets.
 */
function backdate(id: string, iso: string): void {
  // A generous busy timeout, because this is a second writer on a file the
  // engine holds a transaction on across awaits, right after 210 documents
  // went through it — and this has no way to take the lease they take.
  const db = new DatabaseConstructor(join(harness.getConfigDir(), "watch.db"), { timeout: 30_000 });
  try {
    const changed = db.prepare("UPDATE watch_defs SET added_at = ? WHERE id = ?").run(iso, id);
    // Said rather than left to become a timeout: no rows means the watch is
    // not where this thinks it is, and the symptom would otherwise be three
    // minutes of polling and a message about the wrong thing.
    if (changed.changes !== 1) throw new Error(`backdate matched ${changed.changes} watches`);
  } finally {
    db.close();
  }
}

/** Push `count` emails, each with the term the judged watch's arm looks for. */
async function pushEmails(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await harness.pushDocument({
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      externalId: `verdict-fixture-${index}`,
      title: `Quotation ${index} for the spring works`,
      content: `A quotation for the spring works, item ${index}.`,
    });
  }
}

/**
 * Poll the verdict until it settles on `want`, or say what it settled on.
 *
 * `want` is the whole verdict, sentence included, and that is deliberate. The
 * `judge-declines-everything` name appears the moment the tenth judgement is
 * recorded, so a poll landing between the tenth and the last would see the
 * right name carrying a smaller count — and an assertion made after the wait
 * would read a race as a regression. Waiting for the sentence waits for the
 * run to finish; a real collapse then times out saying what it read instead.
 */
async function waitForVerdict(
  id: string,
  want: { name: string; because?: string },
  timeoutMs = 180_000,
): Promise<Verdict> {
  const deadline = Date.now() + timeoutMs;
  let last: Verdict | null = null;
  while (Date.now() < deadline) {
    last = await verdictOf(id);
    if (last?.name === want.name && (want.because === undefined || last.because === want.because)) {
      return last;
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(
    `watch ${id} never reached ${want.name}; it reads ${last?.name ?? "no verdict"} — ${last?.because ?? ""}`,
  );
}

describe("the verdicts a real runtime produces about a watch that is not working", () => {
  test("says the judge refuses everything, from a judge that really did", async () => {
    // No age gate on this one, and deliberately: a judge that has answered
    // ten times and refused every one has said something about the
    // proposition whatever the calendar says.
    const id = await addWatch(everyEmailJudged(await fingerprint()));
    await pushEmails(JUDGED_EMAILS);

    // The sentence is what is waited for, so it is not re-asserted here: a
    // wrong one times out saying what it read instead, which is the same
    // information one deadline later.
    const verdict = await waitForVerdict(id, {
      name: "judge-declines-everything",
      because: `its arm nominated ${JUDGED_EMAILS} documents and the judge refused every one`,
    });

    expect(verdict.actionable, "the one surface built to alarm was told not to").toBe(true);
    expect(verdict.label.trim()).not.toBe("");
  }, 300_000);

  test("says it admitted none, from an arm that really admitted none", async () => {
    const id = await addWatch(nothingEverMatches(await fingerprint()));
    await pushEmails(ENOUGH_LOOKS + 10);
    // Everything above is what the watch did; this is the only thing stated.
    backdate(id, "2026-01-01T00:00:00.000Z");

    const verdict = await waitForVerdict(id, { name: "never-matched" });

    expect(verdict.because).toMatch(/looked at \d+ events over \d+ days and admitted none/);
    expect(verdict.actionable).toBe(true);
    expect(verdict.label.trim()).not.toBe("");
  }, 300_000);
});

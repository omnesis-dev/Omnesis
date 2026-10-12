// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { annotationVerificationContext } from "../../../gateway/src/brain/annotation-verification.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  note,
  preserveCurrentOwner,
  sourceInterpretations,
} from "./brain-bench/index.js";
import { startVerdictServer, type VerdictServer } from "./brain-bench/verdict-servers.js";

compressCognitionCadences();
const documents = [
  note({
    externalId: "dial-inspection",
    title: "Dial inspection",
    content: "The glass dial has twelve divisions.",
  }),
  note({
    externalId: "rack-inspection",
    title: "Rack inspection",
    content: "The copper rack has seven shelves.",
  }),
];
let bench: BrainBench | undefined;
let healthy: VerdictServer | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await bench?.destroy();
  await stop?.();
  await healthy?.close();
}, 60_000);

it("bounds overlapping remote verifications and closes timed-out calls before retries", async () => {
  healthy = await startVerdictServer({ role: "entailment", policy: "accept-all" });
  const requests: Array<{
    started: number;
    claim: string;
    closed?: number;
    response: ServerResponse;
  }> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const wire = body
        ? z
            .object({ messages: z.array(z.object({ content: z.string() })) })
            .safeParse(JSON.parse(body))
        : null;
      const prompt = wire?.success ? wire.data.messages.at(-1)?.content : undefined;
      const lastLine = prompt?.split("\n").at(-1);
      const packet = lastLine?.startsWith("{")
        ? z
            .object({
              assessment: z.string().optional(),
              claim: z.string(),
              context: z.string().optional(),
            })
            .safeParse(JSON.parse(lastLine))
        : null;
      const targeted =
        packet?.success &&
        packet.data.assessment === "annotation_atomic" &&
        packet.data.context === annotationVerificationContext("doc_annotation") &&
        documents.some((doc) => packet.data.claim === doc.content);
      if (req.method === "POST" && targeted) {
        const request = { started: performance.now(), claim: packet.data.claim, response: res };
        requests.push(request);
        // Response close, not request close: consuming a request body is not cancellation.
        res.once("close", () => {
          requests.find((item) => item === request)!.closed = performance.now();
        });
        return;
      }
      const response = await fetch(`${healthy!.url}${req.url}`, {
        method: req.method,
        ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
      });
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(await response.text());
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server address unavailable");
  bench = await BrainBench.start({
    experimental: true,
    brain: {
      workerConcurrency: 2,
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeedsPerBatch: 1, maxFrontierItems: 1 },
    },
    extraInference: {
      backends: { cancellation: { type: "http", url: `http://127.0.0.1:${address.port}` } },
      assignments: { "entailment-verifier": `cancellation/${healthy.modelId}` },
    },
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: documents.map((doc) => ({
          docTitle: doc.title,
          plan: (ctx) => ({
            calls: [
              call("annotation_search", { docId: ctx.subject }),
              call("annotate_durable", {
                docId: ctx.subject,
                claimType: "inspection",
                claimText: doc.content,
                evidenceDocId: ctx.subject,
                evidenceQuote: doc.content,
                confidence: 0.8,
                claimBasis: "quoted",
              }),
            ],
          }),
        })),
      }),
    },
  });
  await bench.pushAll(documents);
  await bench.drainUntilQuiet({ timeoutMs: 100_000, stallMs: 65_000 });
  expect(requests).toHaveLength(3);
  expect(requests.slice(0, 2).map((request) => request.claim)).toContain(requests[2]!.claim);
  expect(requests[0]!.claim).not.toBe(requests[1]!.claim);
  expect(requests.every((request) => request.closed !== undefined)).toBe(true);
  // Both independent remote operations enter before either transport closes.
  // The third is the existing global collection-CAS retry, not extra admission.
  expect(requests[1]!.started).toBeLessThan(requests[0]!.closed!);
  for (const request of requests) expect(request.started + 25_000).toBeLessThan(request.closed!);
  const boundaries = requests
    .flatMap((request) => [
      { at: request.started, delta: 1 },
      { at: request.closed!, delta: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const boundary of boundaries) {
    active += boundary.delta;
    peak = Math.max(peak, active);
  }
  expect(peak).toBe(2);
  expect(active).toBe(0);
  const outcomes: string[][] = [];
  const runs = await bench.obs.runs({ kind: "synthesis", limit: 200 });
  const executed = await Promise.all(runs.items.map((run) => bench!.obs.executedTools(run.id)));
  for (const doc of documents) {
    const id = await bench.docId(doc.externalId);
    const { annotations } = await bench.obs.docAnnotations(id);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({ verificationState: "unverified", lastVerifiedAt: null });
    // Later maintenance can complete this source again without annotation work.
    // Bind to the actual canonical invocations, not the latest completion run.
    const producingRuns = executed.filter((steps) =>
      steps.some((step) => step.tool === "annotate_durable" && step.args.docId === id),
    );
    expect(producingRuns).toHaveLength(1);
    const steps = producingRuns[0]!.filter(
      (step) =>
        step.args.docId === id && ["annotation_search", "annotate_durable"].includes(step.tool),
    );
    const writes = steps.filter((step) => step.tool === "annotate_durable");
    outcomes.push(
      writes.map((step) =>
        step.result?.kind === "error" ? String(step.result.code) : String(step.result?.resultType),
      ),
    );
    if (doc.content === requests[2]!.claim) {
      // The first committed annotation changes the existing collection CAS.
      // The second tool must refresh its own collection read before trying again.
      expect(steps.map((step) => step.tool)).toEqual([
        "annotation_search",
        "annotate_durable",
        "annotation_search",
        "annotate_durable",
      ]);
      expect(steps[1]!.result).toMatchObject({ kind: "error", code: "revision_conflict" });
      expect(steps[1]!.result?.message).toContain("doc_annotation");
      expect(steps[2]).toMatchObject({
        args: { docId: id },
        result: {
          kind: "structured",
          resultType: "annotation.search_results",
          data: { docId: id, annotations: [] },
        },
      });
    }
  }
  expect(outcomes.sort((a, b) => a.length - b.length)).toEqual([
    ["annotation.created"],
    ["revision_conflict", "annotation.created"],
  ]);
  // Each canonical invocation made one request, including the legitimate CAS
  // retry. Timed-out transports are closed and both saved owners are unverified.
  for (const request of requests) expect(request.response.destroyed).toBe(true);
  expect(outcomes.flat()).toHaveLength(requests.length);
}, 150_000);

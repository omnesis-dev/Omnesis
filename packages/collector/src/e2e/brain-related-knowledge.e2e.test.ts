// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { scheduleKnowledgeReview } from "../../../gateway/src/brain/knowledge/work-lifecycle.js";
import { enqueueKnowledgeWork } from "../../../gateway/src/brain/knowledge/work.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  structuredData,
  waitFor,
  type ExecutedTool,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import {
  complementaryEvidence,
  waitForComplementaryEvidence,
} from "./brain-bench/complementary-evidence.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterAll(async () => {
  await bench?.destroy();
}, 60_000);

const pageId = "flat-two-reference";
const VIEWING = "Flat 2 viewing notes";
const BROCHURE = "Flat 2 brochure";
const CORRECTION = "Flat 2 service charge correction";
const CORRECTION_QUOTE =
  "The service charge for Flat 2 is £800 per quarter, £3,200 annually. The brochure's per-quarter figure was an error.";
const brochureClaim = "Flat 2 has a service charge of £3,200 per quarter.";
const correctedClaim =
  "Flat 2 has a service charge of £800 per quarter (£3,200 a year); the brochure's per-quarter figure was an error.";

/**
 * A correction recorded on a different document than the one a page cites
 * shares no dependency with the page. The annotation write queues the page for
 * review and names it so the run can target it for repair, and a later save
 * that repeats the corrected figure is shown the correction before it lands.
 */
it("carries a correction recorded on another document into the page that cites the corrected source", async () => {
  const ids = { brochure: "", brochureRevision: "", correction: "", correctionRevision: "" };
  let viewingMarkup = "";
  let viewingVersions: Record<string, string> = {};
  let annotationId = "";
  let phase: "written" | "corrected" | "reviewing" = "written";
  let reverting = true;
  const charge = (claim: string, source: string) =>
    `<claim id="charge" refs="source:${source}">${claim}</claim>`;
  const page = knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source?.title === BROCHURE) {
        ids.brochure = item.source.id;
        ids.brochureRevision = item.source.contentHash;
        // A source can be offered again after its proposed page was adopted.
        // Inspect this frontier's library rather than trying to create it again.
        const frontier = steps.findLastIndex((step) => step.name === "knowledge_next_frontier");
        const listed = steps.slice(frontier + 1).findLast((step) => step.name === "knowledge_list");
        if (!listed) return { calls: [call("knowledge_list", { kind: "wiki" })] };
        const pages = z.array(z.object({ id: z.string() })).parse(structuredData(listed.result));
        if (pages.some((page) => page.id === pageId)) return { calls: [] };
        const support = complementaryEvidence(VIEWING, steps);
        if (!support.evidence) return { calls: support.calls };
        viewingMarkup = `<claim id="viewing" refs="${support.evidence.ref}">${support.evidence.text}</claim>`;
        viewingVersions = { [support.evidence.ref]: support.evidence.revision };
        return {
          calls: [
            ...support.calls,
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_candidates", {}),
            call("knowledge_propose_page", {
              identityKey: pageId,
              title: "Flat 2",
              scope: "Flat 2: running costs and viewing arrangements",
              evidenceVersions: {
                [ids.brochure]: item.source.contentHash,
                [support.evidence.id]: support.evidence.revision,
              },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id"),
              creationAssessment: {
                reason: "No inspected page covers this flat.",
                relatedPageIds: [],
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: "Flat 2",
                markdown: charge(brochureClaim, ids.brochure) + viewingMarkup,
                expectedRevision: 0,
                inputVersions: {
                  [`source:${ids.brochure}`]: item.source.contentHash,
                  ...viewingVersions,
                },
              },
            }),
          ],
        };
      }
      if (item.source?.title === CORRECTION) {
        ids.correction = item.source.id;
        ids.correctionRevision = item.source.contentHash;
        return {
          calls: [
            call("annotation_search", { docId: ids.correction }),
            call("annotate_durable", {
              docId: ids.correction,
              claimType: "running-cost",
              claimText:
                "The agent corrected the brochure: the service charge for Flat 2 is £800 per quarter, £3,200 annually.",
              evidenceDocId: ids.correction,
              evidenceQuote: CORRECTION_QUOTE,
              confidence: 0.8,
              claimBasis: "quoted",
            }),
          ],
        };
      }
      if (item.source) return { calls: [] };
      if (item.id !== pageId) return preserveCurrentOwner(item, ctx, steps);
      const save = (markdown: string, versions: Record<string, string>) =>
        call("knowledge_save", {
          inputFingerprint: item.inputFingerprint,
          placementAssessment: { status: "standalone", reason: "A self-contained flat page." },
          node: {
            id: pageId,
            kind: "wiki",
            title: item.node!.title,
            markdown,
            expectedRevision: item.node!.revision,
            inputVersions: versions,
          },
        });
      // Before the correction exists, a routine review keeps the page as written.
      // Placement is assessed against a library read in the same run.
      const library = call("knowledge_list", { kind: "wiki" });
      if (phase === "written") return { calls: [library, save(item.node!.markdown, {})] };
      // The repair the correction's run targeted: state the corrected figure.
      if (phase === "corrected")
        return {
          calls: [
            library,
            save(charge(correctedClaim, ids.correction) + viewingMarkup, {
              [`source:${ids.correction}`]: ids.correctionRevision,
            }),
          ],
        };
      // A later review that would put the brochure's figure back, then the
      // retained page once the correction has been shown.
      return {
        calls: [
          library,
          reverting
            ? save(charge(brochureClaim, ids.brochure) + viewingMarkup, {
                [`source:${ids.brochure}`]: ids.brochureRevision,
              })
            : save(item.node!.markdown, {}),
        ],
      };
    },
    targets(item, steps) {
      if (item.source?.title !== CORRECTION) return [];
      const written = steps.find((step) => step.name === "annotate_durable");
      const data = z
        .object({
          id: z.string(),
          pagesToReconcile: z.array(z.object({ id: z.string() })).optional(),
        })
        .parse(structuredData(written?.result));
      annotationId = data.id;
      return [data.id, ...(data.pagesToReconcile ?? []).map((related) => related.id)];
    },
  });
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
    syncSources: false,
    entailment: "accept-all",
    // In a corpus of a few documents every shared word exceeds the common-term
    // share, so lexical search would drop the very terms these records share.
    extraGatewayConfig: { search: { bm25: { commonTokenThreshold: 0 } } },
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error(`Unexpected decision ${key}`);
            return [
              key,
              { type: "score" as const, score: question.criteria.length - 1, confidence: 1 },
            ];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic: (ctx, steps) => {
        const last = steps.at(-1);
        if (
          phase === "reviewing" &&
          reverting &&
          last?.name === "knowledge_save" &&
          (last.result as { code?: unknown } | null)?.code === "claim_invalid"
        ) {
          reverting = false;
          return { kind: "tool", name: "knowledge_next_frontier", args: {} };
        }
        return page(ctx, steps);
      },
    },
  });
  const steps = async (): Promise<ExecutedTool[]> => {
    const runs = bench!.sql
      .prepare<[], { run_id: string }>(
        "SELECT DISTINCT run_id FROM knowledge_batches WHERE run_id IS NOT NULL",
      )
      .all();
    return (await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))).flat();
  };
  const pageText = () =>
    (
      bench!.sql.prepare("SELECT plain_text FROM knowledge_nodes WHERE id=?").get(pageId) as
        { plain_text: string } | undefined
    )?.plain_text;
  const searchable = async (text: string, title: string) => {
    let last: unknown = null;
    try {
      await waitFor(
        `indexed knowledge mirror: ${title}`,
        async () => {
          // Mirrors reach the index through the indexer's periodic sweep of
          // unindexed documents, and search reads a published snapshot; run
          // both now instead of waiting for their schedules.
          await bench!.harness.gatewayJson("/admin/index/reindex-missing", { method: "POST" });
          await bench!.harness.refreshSearchSnapshot();
          const response = await bench!.harness.gatewayJson<{
            results: Array<{ title: string; sourceId?: string }>;
          }>("/search", {
            method: "POST",
            body: JSON.stringify({ text, limit: 10, filters: { documentTypes: ["knowledge"] } }),
          });
          last = response.results.map((result) => [result.title, result.sourceId]);
          return response.results.some((result) => result.title === title) ? true : null;
        },
        60_000,
      );
    } catch (error) {
      const mirrors = bench!.sql
        .prepare(
          "SELECT d.title,json_extract(d.metadata,'$.extra.knowledgeRevision') AS mirrored,n.revision FROM documents d LEFT JOIN knowledge_nodes n ON n.id=d.external_id WHERE d.source_id='brain-knowledge'",
        )
        .all();
      throw new Error(
        `${String(error)}; last search=${JSON.stringify(last)}; mirrors=${JSON.stringify(mirrors)}`,
        { cause: error },
      );
    }
  };

  try {
    // The page is written from the brochure, before any correction exists.
    await bench.pushAndSettle([
      email({
        externalId: "flat-two-viewing",
        title: VIEWING,
        content: "The viewing of Flat 2 is booked for Saturday morning.",
      }),
    ]);
    await waitForComplementaryEvidence(bench, VIEWING);
    await bench.push(
      email({
        externalId: "flat-two-brochure",
        title: BROCHURE,
        content: `Two bedrooms and a south-facing balcony. ${brochureClaim}`,
      }),
    );
    await expect.poll(pageText, { timeout: 90_000 }).toContain("£3,200 per quarter");
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
    // Reproduce a delayed review of the source after its candidate was adopted.
    // It must settle discovery using the existing page, without recreating it.
    bench.withWriteHandle((db) => {
      const now = Date.now();
      enqueueKnowledgeWork(
        db,
        {
          id: "flat-two-brochure-review",
          subjectId: ids.brochure,
          subjectKind: "source",
          reason: "review",
          inputRevision: ids.brochureRevision,
          tier: "immediate",
          dueAt: now,
        },
        now,
      );
    });
    await expect
      .poll(
        () =>
          bench!.sql
            .prepare("SELECT status FROM knowledge_work WHERE id='flat-two-brochure-review'")
            .get(),
        { timeout: 90_000 },
      )
      .toEqual({ status: "completed" });
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
    expect(
      (await steps()).filter(
        (step) =>
          step.tool === "knowledge_save" &&
          (step.args.node as { id?: string; expectedRevision?: number } | undefined)?.id ===
            pageId &&
          (step.args.node as { expectedRevision?: number }).expectedRevision === 0,
      ),
    ).toHaveLength(1);
    await searchable("Flat 2 service charge quarter", "Flat 2");

    // The agent's correction arrives on its own document.
    phase = "corrected";
    await bench.push(
      email({
        externalId: "flat-two-correction",
        title: CORRECTION,
        content: `The letting agent here. ${CORRECTION_QUOTE}`,
      }),
    );
    await expect.poll(pageText, { timeout: 120_000 }).toContain("£800 per quarter");
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
    const written = (await steps()).find((step) => step.tool === "annotate_durable");
    expect(written?.result?.data).toMatchObject({
      id: annotationId,
      pagesToReconcile: [expect.objectContaining({ id: pageId })],
    });
    const completion = (await steps()).find(
      (step) =>
        step.tool === "knowledge_discovery_complete" && step.args.id === `source:${ids.correction}`,
    );
    expect(completion?.args.targets).toEqual(expect.arrayContaining([annotationId, pageId]));

    // The annotation also queued the page for an ordinary review.
    const reviews = () =>
      bench!.sql
        .prepare<[string], { status: string }>(
          "SELECT status FROM knowledge_work WHERE subject_kind='node' AND subject_id=? AND reason='review'",
        )
        .all(pageId);
    await expect
      .poll(() => reviews().some((work) => work.status === "completed"), { timeout: 120_000 })
      .toBe(true);
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });

    // A later review repeating the brochure's figure is shown the correction.
    await searchable("service charge brochure error", "running-cost");
    phase = "reviewing";
    bench.withWriteHandle((db) => {
      const current = db.prepare("SELECT revision FROM knowledge_nodes WHERE id=?").get(pageId) as {
        revision: number;
      };
      const now = Date.now();
      scheduleKnowledgeReview(
        db,
        {
          id: pageId,
          expectedRevision: current.revision,
          nextReviewAt: now,
          decision: "now",
          workId: "flat-two-review",
        },
        now,
      );
    });
    await expect.poll(() => reverting, { timeout: 90_000 }).toBe(false);
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
    const refused = (await steps()).filter(
      (step) =>
        step.tool === "knowledge_save" &&
        (step.args.node as { id?: string } | undefined)?.id === pageId &&
        step.result?.code === "claim_invalid",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.result).toMatchObject({
      code: "claim_invalid",
      message: expect.stringContaining(`annotation:${annotationId}`),
    });
    expect(pageText()).toContain("£800 per quarter");
    expect(pageText()).not.toContain("£3,200 per quarter");
    expect(
      bench.sql.prepare("SELECT status FROM knowledge_work WHERE id='flat-two-review'").get(),
    ).toMatchObject({ status: "completed" });
  } catch (error) {
    const trace = (await steps()).map((step) =>
      [step.tool, step.result?.kind, step.result?.code, step.result?.message?.slice(0, 160)].join(
        " ",
      ),
    );
    throw new Error(`${String(error)}; tools=${JSON.stringify(trace)}`, { cause: error });
  }
}, 420_000);

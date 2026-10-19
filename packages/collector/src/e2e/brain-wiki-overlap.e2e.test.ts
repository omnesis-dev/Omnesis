// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { buildKnowledgeDocumentInput } from "../../../gateway/src/brain/knowledge/mirror.js";
import { readKnowledgeSourceRevision } from "../../../gateway/src/brain/knowledge/source-revision.js";
import { saveKnowledgeNode } from "../../../gateway/src/brain/knowledge/storage.js";
import { upsertDocuments } from "../../../gateway/src/data/repositories/DocumentRepository.js";
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

compressCognitionCadences();
let bench: BrainBench | undefined;
afterAll(async () => {
  await bench?.destroy();
}, 60_000);

const existingId = "studio-rehearsals";
const draftId = "northstar-quartet-rehearsals";
const BOOKING = "Rehearsal room booking";
const SCHEDULE = "Rehearsal schedule change";
const bookingClaim =
  "The quartet rehearses in Room 3 at the riverside studio on Thursday evenings.";
const sundayClaim =
  "Starting in May the quartet also rehearses in Room 3 at the riverside studio on Sundays.";
/** Distinct subjects that fill the first page of the library read. */
const UNRELATED = [
  "bicycle",
  "orchard",
  "pottery",
  "aquarium",
  "lighthouse",
  "beekeeping",
  "sailing",
  "glacier",
  "telescope",
  "bakery",
  "archery",
  "falconry",
  "vineyard",
  "origami",
  "kayaking",
  "ceramics",
  "weaving",
  "mosaic",
  "compost",
  "chess",
  "fencing",
  "quilting",
  "terrarium",
  "calligraphy",
  "birdwatching",
  "lacrosse",
  "bonsai",
  "cartography",
  "mushroom",
  "printmaking",
];

/**
 * The library read is paged, so with more pages than one page holds the run
 * may never see the existing page on a draft's subject. A new page whose
 * subject an unread current page already covers is refused naming that page;
 * the run then enriches the existing page and settles the candidate as merged,
 * and the library gains no near-duplicate.
 */
it("refuses a near-duplicate new page beyond the first library page and merges into the existing one", async () => {
  const ids = { booking: "", bookingRevision: "", schedule: "", scheduleRevision: "" };
  let candidateId = "";
  const page = knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source?.title === SCHEDULE) {
        const schedule = item.source;
        ids.schedule = schedule.id;
        ids.scheduleRevision = schedule.contentHash;
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_candidates", {}),
            call("knowledge_propose_page", {
              identityKey: draftId,
              title: "Quartet rehearsal schedule",
              scope: "When and where the quartet rehearses at the riverside studio",
              evidenceVersions: {
                [ids.booking]: ids.bookingRevision,
                [schedule.id]: schedule.contentHash,
              },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id"),
              creationAssessment: {
                reason: "No inspected page covers the quartet's rehearsals.",
                relatedPageIds: [],
              },
              node: {
                id: draftId,
                kind: "wiki",
                title: "Quartet rehearsal schedule",
                markdown: `<claim id="thursday" refs="source:${ids.booking}">${bookingClaim}</claim>\n\n<claim id="sunday" refs="source:${schedule.id}">${sundayClaim}</claim>`,
                expectedRevision: 0,
                inputVersions: {
                  [`source:${ids.booking}`]: ids.bookingRevision,
                  [`source:${schedule.id}`]: schedule.contentHash,
                },
              },
            }),
            // The refusal names the existing page; read it before deciding.
            call("knowledge_fetch", { id: existingId }),
          ],
        };
      }
      if (item.source) return { calls: [] };
      if (item.id !== existingId) return preserveCurrentOwner(item, ctx, steps);
      // A later review of the enriched page keeps it as it is.
      const enriched = item.node!.markdown.includes(sundayClaim);
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_save", {
            inputFingerprint: item.inputFingerprint,
            placementAssessment: {
              status: "standalone",
              reason: "A self-contained rehearsal page.",
            },
            node: {
              id: existingId,
              kind: "wiki",
              title: item.node!.title,
              markdown: enriched
                ? item.node!.markdown
                : `${item.node!.markdown}\n\n<claim id="sunday" refs="source:${ids.schedule}">${sundayClaim}</claim>`,
              expectedRevision: item.node!.revision,
              inputVersions: enriched ? {} : { [`source:${ids.schedule}`]: ids.scheduleRevision },
            },
          }),
        ],
      };
    },
    expectedRefusals: (item) =>
      item.source?.title === SCHEDULE ? [{ tool: "knowledge_save", code: "claim_invalid" }] : [],
    targets: (item) => (item.source?.title === SCHEDULE ? [existingId] : []),
  });
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
    syncSources: false,
    entailment: "accept-all",
    // In a corpus this small, lexical search would otherwise drop the very
    // terms the pages share as too common.
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
        // After enriching the existing page, settle the candidate into it.
        const enriched = steps.findIndex(
          (step) =>
            step.name === "knowledge_save" &&
            (step.args?.node as { id?: unknown } | undefined)?.id === existingId &&
            (step.result as { kind?: unknown } | null)?.kind === "structured",
        );
        if (enriched >= 0 && !steps.some((step) => step.name === "knowledge_candidate_decide")) {
          // The save changed the library, so the decision rereads it first.
          const since = steps.slice(enriched + 1);
          if (!since.some((step) => step.name === "knowledge_list"))
            return { kind: "tool", name: "knowledge_list", args: { kind: "wiki" } };
          const listed = since.find((step) => step.name === "knowledge_candidates");
          if (!listed) return { kind: "tool", name: "knowledge_candidates", args: {} };
          const candidate = z
            .object({ items: z.array(z.object({ id: z.string(), revision: z.number() })) })
            .parse(structuredData(listed.result))
            .items.find((item) => item.id === candidateId)!;
          return {
            kind: "tool",
            name: "knowledge_candidate_decide",
            args: {
              id: candidate.id,
              expectedRevision: candidate.revision,
              status: "merged",
              nodeId: existingId,
            },
          };
        }
        const proposed = steps.find((step) => step.name === "knowledge_propose_page");
        if (proposed && !candidateId)
          candidateId = z.object({ id: z.string() }).parse(structuredData(proposed.result)).id;
        return page(ctx, steps);
      },
    },
  });
  const steps = async (): Promise<ExecutedTool[]> => {
    const runs = bench!.sql
      .prepare<
        [],
        { run_id: string }
      >("SELECT run_id FROM knowledge_batches WHERE run_id IS NOT NULL GROUP BY run_id ORDER BY MIN(created_at)")
      .all();
    return (await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))).flat();
  };
  const wikiCount = () =>
    bench!.sql.prepare("SELECT COUNT(*) FROM knowledge_nodes WHERE kind='wiki'").pluck().get();

  try {
    await bench.pushAndSettle([
      email({ externalId: "rehearsal-booking", title: BOOKING, content: bookingClaim }),
    ]);
    ids.booking = await bench.docId("rehearsal-booking");

    // An existing page on the rehearsals, after thirty unrelated pages that
    // sort first and fill the library's first page.
    bench.withWriteHandle((db) =>
      db
        .transaction(() => {
          ids.bookingRevision = readKnowledgeSourceRevision(db, ids.booking)!;
          const pages = UNRELATED.map((subject, index) => ({
            id: `archive-${String(index).padStart(2, "0")}-${subject}`,
            title: `${subject[0]!.toUpperCase()}${subject.slice(1)} notes`,
            markdown: `<claim id="note" refs="">Reference notes about ${subject} collected for the archive.</claim>`,
            inputVersions: {},
          }));
          pages.push({
            id: existingId,
            title: "Riverside studio rehearsals",
            markdown: `<claim id="thursday" refs="source:${ids.booking}">${bookingClaim}</claim>`,
            inputVersions: { [`source:${ids.booking}`]: ids.bookingRevision },
          });
          for (const seeded of pages) {
            const { node } = saveKnowledgeNode(
              db,
              { ...seeded, kind: "wiki", expectedRevision: 0 },
              Date.now(),
            );
            upsertDocuments(db, [buildKnowledgeDocumentInput(node)]);
          }
        })
        .immediate(),
    );
    expect(wikiCount()).toBe(31);
    await waitFor(
      "indexed knowledge mirror: Riverside studio rehearsals",
      async () => {
        await bench!.harness.gatewayJson("/admin/index/reindex-missing", { method: "POST" });
        await bench!.harness.refreshSearchSnapshot();
        const response = await bench!.harness.gatewayJson<{ results: Array<{ title: string }> }>(
          "/search",
          {
            method: "POST",
            body: JSON.stringify({
              text: "quartet rehearses riverside studio",
              limit: 10,
              filters: { documentTypes: ["knowledge"] },
            }),
          },
        );
        return response.results.some((result) => result.title === "Riverside studio rehearsals")
          ? true
          : null;
      },
      60_000,
    );

    await bench.push(
      email({ externalId: "rehearsal-schedule", title: SCHEDULE, content: sundayClaim }),
    );
    await expect
      .poll(
        () =>
          bench!.sql
            .prepare("SELECT status,node_id AS nodeId FROM knowledge_candidates WHERE id=?")
            .get(candidateId),
        { timeout: 120_000 },
      )
      .toEqual({ status: "merged", nodeId: existingId });
    await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });

    const all = await steps();
    // The library's first page never showed the existing page.
    const listed = all.find((step) => step.tool === "knowledge_list");
    expect(JSON.stringify(listed?.result?.data)).not.toContain(existingId);
    const refused = all.filter(
      (step) =>
        step.tool === "knowledge_save" &&
        (step.args.node as { id?: string } | undefined)?.id === draftId,
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.result).toMatchObject({
      code: "claim_invalid",
      message: expect.stringContaining(
        `"id":"${existingId}","title":"Riverside studio rehearsals"`,
      ),
    });
    expect(
      bench.sql
        .prepare("SELECT plain_text FROM knowledge_nodes WHERE id=?")
        .pluck()
        .get(existingId),
    ).toContain("also rehearses in Room 3");
    expect(
      bench.sql.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(draftId),
    ).toBeUndefined();
    expect(wikiCount()).toBe(31);
  } catch (error) {
    const trace = (await steps()).map((step) =>
      [step.tool, step.result?.kind, step.result?.code, step.result?.message?.slice(0, 200)].join(
        " ",
      ),
    );
    throw new Error(`${String(error)}; tools=${JSON.stringify(trace)}`, { cause: error });
  }
}, 420_000);

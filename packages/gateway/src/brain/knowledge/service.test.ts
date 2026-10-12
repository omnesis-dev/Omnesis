// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { createAnnotationStorageTables, createDocAnnotation } from "../storage/annotations.js";
import {
  witnessSources,
  ContextualAssessmentError,
} from "../../inference/contextual-entailment.js";
import { AnnotationAssessmentError } from "../../inference/annotation-entailment.js";
import { ANNOTATION_CONTEXT_VERIFIER } from "../annotation-verification.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { KnowledgeReferenceReader } from "./reference-reader.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { resolveBrainSettings } from "../config.js";
import { KnowledgeService, type KnowledgeProposal } from "./service.js";
import {
  createKnowledgeTables,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  getKnowledgeNode,
  recordKnowledgeSourceChange,
  purgeKnowledgeBySource,
} from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { proposeKnowledgeCandidate, getKnowledgeCandidate } from "./discovery.js";
import { directKnowledgeGate } from "./writer.js";
import { WikiPublicationReads } from "./wiki-publication.js";
import { knowledgeHash } from "./storage-validation.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run("evidence", "Workshop Friday.", "v1");
  createKnowledgeTables(db);
});
afterEach(() => db.close());
const proposal = (id: string, refs = "source:evidence"): KnowledgeProposal => ({
  id,
  kind: "wiki",
  title: "Workshop",
  markdown: `<claim id="date" refs="${refs}">Workshop Friday.</claim>`,
  expectedRevision: 0,
  inputVersions: { [refs]: refs.startsWith("source:") ? "v1" : 1 },
});
function service(verifier: EntailCapability | null = null) {
  return new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    getEntailmentVerifier: async () => verifier,
    clock: () => 100,
    log: createLogger("knowledge-test"),
  });
}
const verifier: EntailCapability = {
  verify: async () => ({ label: "entailment", probability: 1 }),
  dispose: () => {},
};
it("names the exact unavailable reference in a rejected save and accepts its correction", async () => {
  const brain = service(verifier);
  const mistyped = "source:evidenc";
  await expect(brain.save(proposal("project", mistyped))).rejects.toMatchObject({
    code: "reference_invalid",
    message: `Reference "${mistyped}" is unavailable. Check the ID and selector against search or fetch results before retrying.`,
  });
  expect(getKnowledgeNode(db, "project")).toBeNull();
  await expect(brain.save(proposal("project"))).resolves.toMatchObject({ node: { id: "project" } });
});

it("does not distinguish missing, withdrawn or privacy-hidden references in errors", async () => {
  const brain = service();
  const capture = (ref: string) => {
    try {
      brain.reference(ref);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("Expected reference rejection");
  };
  const missing = capture("source:unknown");
  db.exec("INSERT INTO documents VALUES('unknown','Private text','v1')");
  db.exec(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('unknown','v1',1,100)",
  );
  expect(capture("source:unknown")).toBe(missing);
  const absentNode = capture("wiki:unavailable");
  await brain.save(proposal("unavailable"));
  db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='unavailable'").run(
    JSON.stringify({ withdrawn: true }),
  );
  expect(capture("wiki:unavailable")).toBe(absentNode);
  db.prepare("UPDATE knowledge_nodes SET fields_json='{}' WHERE id='unavailable'").run();
  // The row still exists, but a pending privacy deletion hides it immediately.
  db.exec("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('unavailable',101)");
  expect(capture("wiki:unavailable")).toBe(absentNode);
});

it.each(["source:evidence#evidence:absent", "wiki:absent#claim:detail"])(
  "preserves the exact selector in the unavailable error for %s",
  (ref) => {
    expect(() => service().reference(ref)).toThrow(`Reference "${ref}" is unavailable`);
  },
);

it.each(["purge", "revision", "invalidation"] as const)(
  "rechecks the saved node after asynchronous projection: %s",
  async (change) => {
    const brain = service(verifier);
    let entered!: () => void;
    let release!: () => void;
    const projecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    brain.deps.mirror = {
      refresh: async () => {
        entered();
        await pending;
      },
    };
    const saving = brain.save(proposal("project"));
    await projecting;
    // The canonical write did commit; only the asynchronous projection remains.
    expect(getKnowledgeNode(db, "project")?.revision).toBe(1);
    if (change === "purge") purgeKnowledgeBySource(db, "evidence", 101);
    else if (change === "revision")
      await service(verifier).save({
        ...proposal("project"),
        expectedRevision: 1,
        title: "Updated workshop",
      });
    else {
      db.prepare("UPDATE documents SET content_hash='v2' WHERE id='evidence'").run();
      recordKnowledgeSourceChange(db, { documentId: "evidence", contentHash: "v2" }, 101);
    }
    release();
    await expect(saving).rejects.toMatchObject({
      code: change === "purge" ? "reference_invalid" : "revision_conflict",
    });
    if (change === "invalidation") expect(getKnowledgeNode(db, "project")?.validity).toBe("stale");
  },
);
it("rejects uncovered prose and never treats a whole-page reference as verified evidence", async () => {
  const brain = service(verifier);
  const input = proposal("project");
  input.markdown += "\nAn unsupported assertion.";
  await expect(brain.save(input)).rejects.toThrow("Every nonblank");
  expect(getKnowledgeNode(db, "project")).toBeNull();
  await brain.save(proposal("project"));
  expect(brain.reference("wiki:project").verified).toBe(false);
  expect(brain.reference("wiki:project#claim:date").verified).toBe(true);
  await brain.save(proposal("overview", "wiki:project"));
  expect(getKnowledgeClaims(db, "overview")[0]?.verification).toBe("unverified");
});
it("does not accept model-supplied verification or verification time", async () => {
  const input = proposal("project");
  Object.assign(input, {
    claims: [
      {
        id: "date",
        verification: { status: "verified", fingerprint: "fabricated", verifier: "model" },
      },
    ],
    metadata: { lastVerifiedAt: 999999 },
  });
  await service().save(input);
  expect(getKnowledgeClaims(db, "project")[0]?.verification).toBe("unverified");
  expect(getKnowledgeNode(db, "project")?.metadata.lastVerifiedAt).toBeNull();
});
it("stamps meaningful verification time only after real verifier success", async () => {
  await service(verifier).save(proposal("project"));
  expect(getKnowledgeNode(db, "project")?.metadata.lastVerifiedAt).toBe(100);
});
it("rejects generated corpus mirrors and evidence from a source pending removal", async () => {
  db.exec("ALTER TABLE documents ADD COLUMN source_id TEXT");
  db.prepare("UPDATE documents SET source_id=? WHERE id=?").run("brain-knowledge", "evidence");
  const brain = service(verifier);
  expect(() => brain.reference("source:evidence")).toThrow();
  await expect(
    brain.evidence({ documentId: "evidence", contentHash: "v1", quote: "Workshop Friday." }),
  ).rejects.toThrow();
  db.prepare("UPDATE documents SET source_id=? WHERE id=?").run("fictional-source", "evidence");
  await brain.evidence({ documentId: "evidence", contentHash: "v1", quote: "Workshop Friday." });
  db.exec(
    "CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO removed_sources VALUES('fictional-source')",
  );
  expect(() => brain.reference("source:evidence")).toThrow();
  await expect(brain.save(proposal("project"))).rejects.toThrow();
});
it("does not admit arbitrary canonical fields from model arguments", async () => {
  const input = proposal("project");
  Object.assign(input, { canonicalFields: { state: "resolved" } });
  await service().save(input);
  expect(getKnowledgeNode(db, "project")?.canonicalFields).toEqual({});
});
it("fences an asynchronous verdict when upstream proof changes without a semantic version change", async () => {
  await service(verifier).save(proposal("project"));
  const racingVerifier: EntailCapability = {
    verify: async () => {
      await service().save({ ...proposal("project"), expectedRevision: 1 });
      db.prepare(
        "UPDATE knowledge_claims SET verification='unverified' WHERE node_id='project'",
      ).run();
      return { label: "entailment" };
    },
    dispose: () => {},
  };
  await expect(
    service(racingVerifier).save(proposal("overview", "wiki:project#claim:date")),
  ).rejects.toThrow("Claim support changed during verification");
  expect(getKnowledgeNode(db, "project")?.meaningRevision).toBe(1);
  expect(getKnowledgeNode(db, "overview")).toBeNull();
});
it("versions, verifies, and invalidates individual claims while committing the page atomically", async () => {
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run("materials", "Bring paper.", "m1");
  let checks = 0;
  const brain = service({
    verify: async () => {
      checks++;
      return { label: "entailment" };
    },
    dispose: () => {},
  });
  const page = {
    ...proposal("project"),
    markdown:
      '<claim id="date" refs="source:evidence">Workshop Friday.</claim> <claim id="materials" refs="source:materials">Bring paper.</claim>',
    inputVersions: { "source:evidence": "v1", "source:materials": "m1" },
  };
  await brain.save(page);
  await brain.save({
    ...proposal("overview", "wiki:project#claim:materials"),
    markdown: '<claim id="summary" refs="wiki:project#claim:materials">Bring paper.</claim>',
  });
  expect(checks).toBe(3);
  db.prepare(
    "UPDATE documents SET content='Workshop Saturday.',content_hash='v2' WHERE id='evidence'",
  ).run();
  recordKnowledgeSourceChange(db, { documentId: "evidence", contentHash: "v2" }, 101);
  expect(brain.reference("wiki:project#claim:date").stale).toBe(true);
  expect(brain.reference("wiki:project#claim:materials")).toMatchObject({
    revision: 1,
    stale: false,
    verified: true,
  });
  expect(getKnowledgeNode(db, "overview")?.validity).toBe("current");
  const current = getKnowledgeNode(db, "project")!;
  await brain.save({
    ...page,
    expectedRevision: current.revision,
    markdown: page.markdown.replace("Friday", "Saturday"),
    inputVersions: { "source:evidence": "v2", "source:materials": "m1" },
  });
  expect(checks).toBe(4);
  expect(brain.reference("wiki:project#claim:date").revision).toBeGreaterThan(1);
  expect(brain.reference("wiki:project#claim:materials").revision).toBe(1);
  expect(getKnowledgeNode(db, "overview")).toMatchObject({ revision: 1, validity: "current" });
  expect(getKnowledgeClaims(db, "overview")[0]?.verification).toBe("verified");
});
it("verifies any-support claims using one sufficient verified alternative", async () => {
  await service().save(proposal("unverified"));
  await service(verifier).save({
    ...proposal("combined"),
    markdown:
      '<claim id="date" refs="source:evidence wiki:unverified#claim:date">Workshop Friday.</claim>',
    inputVersions: { "source:evidence": "v1", "wiki:unverified#claim:date": 1 },
    claims: [{ id: "date", supportLogic: "any" }],
  });
  expect(getKnowledgeClaims(db, "combined")[0]?.verification).toBe("verified");
  expect(service().reference("wiki:combined#claim:date").verified).toBe(true);
});

it.each(["abandoned", "reassigned"])(
  "rejects publication if maintenance ownership is %s during verification",
  async (change) => {
    createKnowledgeWorkTables(db);
    db.exec(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','running',1,1)",
    );
    db.prepare("INSERT INTO documents VALUES(?,?,?)").run("materials", "Bring paper.", "m1");
    const candidate = proposeKnowledgeCandidate(
      db,
      {
        id: "candidate",
        identityKey: "project:workshop",
        title: "Workshop",
        scope: "Planning",
        evidenceVersions: { evidence: "v1", materials: "m1" },
      },
      1,
    );
    const reads = new WikiPublicationReads(db);
    reads.library();
    reads.candidatesRead([candidate.id], true);
    const creationReceipt = reads.receipt(candidate.id, {
      reason: "The workshop planning scope combines its date and materials requirements.",
      relatedPageIds: [],
    });
    const verify = vi.fn(async () => {
      if (change === "abandoned") db.exec("UPDATE knowledge_batches SET status='abandoned'");
      else db.exec("UPDATE knowledge_batches SET run_id='replacement'");
      return { label: "entailment" as const, probability: 1 };
    });
    const brain = service({ verify, dispose: () => {} });
    await expect(
      brain.save(
        {
          ...proposal("new-page"),
          markdown:
            '<claim id="date" refs="source:evidence">Workshop Friday.</claim> <claim id="materials" refs="source:materials">Bring paper.</claim>',
          inputVersions: { "source:evidence": "v1", "source:materials": "m1" },
        },
        {
          candidateId: candidate.id,
          expectedCandidateRevision: candidate.revision,
          creationReceipt,
        },
        { batchId: "batch", runId: "run" },
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(verify).toHaveBeenCalled();
    expect(getKnowledgeNode(db, "new-page")).toBeNull();
    expect(getKnowledgeCandidate(db, candidate.id)?.status).toBe("proposed");
  },
);
it("does not accept model-supplied review completion time", async () => {
  const input = proposal("project");
  input.metadata = { lastReviewedAt: 999999 };
  await service(verifier).save(input);
  expect(getKnowledgeNode(db, "project")?.metadata.lastReviewedAt).toBeNull();
});
it.each(["during", "after"])(
  "never substitutes a rejected alternative when the accepted any-support witness loses proof %s verification",
  async (timing) => {
    db.prepare("INSERT INTO documents VALUES(?,?,?)").run("other", "Bring paper.", "o1");
    await service(verifier).save(proposal("accepted"));
    await service(verifier).save({
      ...proposal("rejected"),
      markdown: '<claim id="materials" refs="source:other">Bring paper.</claim>',
      inputVersions: { "source:other": "o1" },
    });
    const input: KnowledgeProposal = {
      ...proposal("combined"),
      markdown:
        '<claim id="date" refs="wiki:rejected#claim:materials wiki:accepted#claim:date">Workshop Friday.</claim>',
      inputVersions: { "wiki:rejected#claim:materials": 1, "wiki:accepted#claim:date": 1 },
      claims: [{ id: "date", supportLogic: "any" }],
    };
    const withdrawProof = () =>
      db.exec("UPDATE knowledge_claims SET verification='unverified' WHERE node_id='accepted'");
    const brain = service({
      verify: async ({ evidence }) => {
        if ((JSON.parse(evidence) as { claim: string }).claim === "Bring paper.")
          return { label: "neutral", probability: 1 };
        if (timing === "during") withdrawProof();
        return { label: "entailment", probability: 1 };
      },
      dispose: () => {},
    });
    if (timing === "during") {
      await expect(brain.save(input)).rejects.toMatchObject({ code: "revision_conflict" });
      expect(getKnowledgeNode(db, "combined")).toBeNull();
    } else {
      await brain.save(input);
      expect(getKnowledgeClaims(db, "combined")[0]?.witnessRefs).toEqual([
        "wiki:accepted#claim:date",
      ]);
      withdrawProof();
      expect(brain.reference("wiki:combined#claim:date").verified).toBe(false);
      await expect(
        service(verifier).save(proposal("descendant", "wiki:combined#claim:date")),
      ).resolves.toBeDefined();
      expect(getKnowledgeClaims(db, "descendant")[0]?.verification).toBe("unverified");
    }
  },
);

it("evaluates shared diamond proof only once per depth and never caches across reads", async () => {
  const brain = service(verifier);
  let refs = ["source:evidence"];
  for (let depth = 0; depth < 8; depth++) {
    const next: string[] = [];
    for (const side of ["left", "right"]) {
      const id = `${side}-${depth}`;
      await brain.save({
        ...proposal(id),
        markdown: `<claim id="date" refs="${refs.join(" ")}">Workshop Friday.</claim>`,
        inputVersions: Object.fromEntries(
          refs.map((ref) => [ref, ref.startsWith("source:") ? "v1" : 1]),
        ),
      });
      next.push(`wiki:${id}#claim:date`);
    }
    refs = next;
  }
  const prepared = vi.spyOn(db, "prepare");
  expect(brain.reference(refs[0]!).verified).toBe(true);
  expect(
    prepared.mock.calls.filter(
      ([sql]) =>
        sql.startsWith("SELECT content,content_hash,") && sql.endsWith("FROM documents WHERE id=?"),
    ),
  ).toHaveLength(1);
  prepared.mockRestore();
  db.exec("UPDATE knowledge_claims SET verification='unverified' WHERE node_id='left-0'");
  expect(brain.reference(refs[0]!).verified).toBe(false);
});

it.each(["asserted", "disputed", "unsupported"] as const)(
  "keeps %s epistemic state distinct from verification",
  async (epistemicStatus) => {
    const brain = service(verifier);
    await brain.save({
      ...proposal("state"),
      claims: [
        { id: "date", attribution: "Workshop coordinator", modality: "reported", epistemicStatus },
      ],
    });
    expect(getKnowledgeClaims(db, "state")[0]).toMatchObject({
      attribution: "Workshop coordinator",
      modality: "reported",
      epistemicStatus,
      verification: epistemicStatus === "asserted" ? "verified" : "unverified",
    });
    expect(brain.reference("wiki:state#claim:date").verified).toBe(epistemicStatus === "asserted");
  },
);

it("requires structural coverage on every new synthesis kind", async () => {
  // Structural checking precedes owner resolution; no fake canonical owner needed.
  for (const kind of [
    "wiki",
    "root",
    "loop",
    "doc_annotation",
    "person_annotation",
    "brief",
  ] as const)
    await expect(
      service().save({ ...proposal(kind), kind, markdown: "An uncovered factual sentence." }),
    ).rejects.toThrow("Every nonblank synthesis");
});

it("retains no-reference questions as unsupported rather than fabricated proof", async () => {
  const brain = service(verifier);
  await brain.save({
    ...proposal("question"),
    markdown: '<claim id="date" refs="">Could the workshop move?</claim>',
    inputVersions: {},
    claims: [{ id: "date", modality: "question", epistemicStatus: "unsupported" }],
  });
  expect(brain.reference("wiki:question#claim:date").verified).toBe(false);
  expect(getKnowledgeClaims(db, "question")[0]).toMatchObject({
    modality: "question",
    epistemicStatus: "unsupported",
    verification: "unverified",
  });
});

it("preserves attribution and uncertainty when stable claim state is omitted", async () => {
  const brain = service(verifier);
  const saved = await brain.save({
    ...proposal("retained"),
    claims: [
      {
        id: "date",
        attribution: "Workshop coordinator",
        modality: "proposal",
        epistemicStatus: "disputed",
      },
    ],
  });
  await brain.save({ ...proposal("retained"), expectedRevision: saved.node.revision });
  expect(getKnowledgeClaims(db, "retained")[0]).toMatchObject({
    attribution: "Workshop coordinator",
    modality: "proposal",
    epistemicStatus: "disputed",
    verification: "unverified",
  });
});

it("retains all omitted claim state on title-only edits and supports explicit clearing", async () => {
  const brain = service(verifier);
  const initial = await brain.save({
    ...proposal("complete-state"),
    claims: [
      {
        id: "date",
        supportLogic: "any",
        relations: { "source:evidence": "context" },
        validFrom: 10,
        validUntil: 200,
        attribution: "Workshop coordinator",
        modality: "proposal",
        epistemicStatus: "disputed",
      },
    ],
  });
  const updated = await brain.save({
    ...proposal("complete-state"),
    title: "Updated heading",
    expectedRevision: initial.node.revision,
  });
  expect(getKnowledgeClaims(db, "complete-state")[0]).toMatchObject({
    supportLogic: "any",
    validFrom: 10,
    validUntil: 200,
    attribution: "Workshop coordinator",
    modality: "proposal",
    epistemicStatus: "disputed",
  });
  expect(getKnowledgeDependencies(db, "complete-state")).toMatchObject([
    { ref: "source:evidence", relation: "context" },
  ]);
  await brain.save({
    ...proposal("complete-state"),
    expectedRevision: updated.node.revision,
    claims: [
      {
        id: "date",
        supportLogic: "all",
        relations: {},
        validFrom: null,
        validUntil: null,
        attribution: null,
        modality: "observation",
        epistemicStatus: "asserted",
      },
    ],
  });
  expect(getKnowledgeClaims(db, "complete-state")[0]).toMatchObject({
    supportLogic: "all",
    validFrom: null,
    validUntil: null,
    attribution: null,
    modality: "observation",
    epistemicStatus: "asserted",
    verification: "verified",
  });
  expect(getKnowledgeDependencies(db, "complete-state")).toMatchObject([
    { ref: "source:evidence", relation: "supports" },
  ]);
});

it("retains relations only for surviving refs and defaults new refs to supports", async () => {
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run("additional", "Workshop Friday.", "v2");
  const brain = service();
  const saved = await brain.save({
    ...proposal("relations"),
    claims: [{ id: "date", relations: { "source:evidence": "context" } }],
  });
  const added = await brain.save({
    ...proposal("relations", "source:evidence source:additional"),
    expectedRevision: saved.node.revision,
    inputVersions: { "source:evidence": "v1", "source:additional": "v2" },
  });
  expect(getKnowledgeDependencies(db, "relations")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ref: "source:evidence", relation: "context" }),
      expect.objectContaining({ ref: "source:additional", relation: "supports" }),
    ]),
  );
  await brain.save({
    ...proposal("relations", "source:additional"),
    expectedRevision: added.node.revision,
    inputVersions: { "source:additional": "v2" },
  });
  expect(getKnowledgeDependencies(db, "relations")).toMatchObject([
    { ref: "source:additional", relation: "supports" },
  ]);
  expect(getKnowledgeDependencies(db, "relations")).toHaveLength(1);
});

it.each([
  { reason: "Missing", ref: "source:evidence", supplied: undefined },
  { reason: "Stale", ref: "source:evidence", supplied: "old-version" },
  { reason: "Missing", ref: "wiki:upstream#claim:date", supplied: undefined },
  { reason: "Stale", ref: "wiki:upstream#claim:date", supplied: 0 },
])(
  "identifies $reason dependency versions for $ref and explains receipt recovery without refreshing overrides",
  async ({ reason, ref, supplied }) => {
    const verify = vi.fn(verifier.verify);
    const brain = service({ ...verifier, verify });
    if (ref.startsWith("wiki:")) await brain.save(proposal("upstream"));
    verify.mockClear();
    const input = {
      ...proposal("dependent", ref),
      inputVersions: supplied === undefined ? {} : { [ref]: supplied },
    };
    const unchanged = structuredClone(input);
    const saving = brain.save(input);
    await expect(saving).rejects.toMatchObject({
      code: "revision_conflict",
      message: expect.stringContaining(`${reason} dependency version for "${ref}"`),
    });
    await expect(saving).rejects.toMatchObject({
      message: expect.stringContaining(`knowledge_reference with {"ref":"${ref}"}`),
    });
    await expect(saving).rejects.toMatchObject({
      message: expect.stringContaining(
        `omit node.inputVersions["${ref}"] (or the whole map) to use its read receipt`,
      ),
    });
    await expect(saving).rejects.toMatchObject({
      message: expect.stringContaining("Explicit overrides are never refreshed silently"),
    });
    await expect(saving).rejects.toMatchObject({
      message: expect.stringContaining(
        "Scoped owner synthesis tools still require explicit inputVersions",
      ),
    });
    expect(verify).not.toHaveBeenCalled();
    expect(getKnowledgeNode(db, "dependent")).toBeNull();
    expect(input).toEqual(unchanged);
    const current = brain.reference(ref);
    const saved = await brain.save({ ...input, inputVersions: { [ref]: current.revision } });
    expect(saved.node.revision).toBe(1);
  },
);

it("keeps selected evidence references concise but sends their source framing to the verifier", async () => {
  const source = "Draft workshop agenda; confirmation pending.\nWorkshop Friday.";
  db.prepare("UPDATE documents SET content=? WHERE id='evidence'").run(source);
  const verify = vi.fn(async (_input: { claim: string; evidence: string }) => ({
    label: "neutral" as const,
    probability: 1,
  }));
  const brain = service({ verify, dispose() {} });
  const selected = await brain.evidence({
    documentId: "evidence",
    contentHash: "v1",
    quote: "Workshop Friday.",
  });
  expect(brain.reference(selected.ref)).toMatchObject({
    ref: selected.ref,
    revision: "v1",
    contentHash: "v1",
    text: "Workshop Friday.",
    stale: false,
    verified: true,
  });
  await expect(brain.save(proposal("framed", selected.ref))).rejects.toThrow("not entailed");
  expect(verify).toHaveBeenCalledOnce();
  expect(JSON.parse(verify.mock.calls[0]![0].evidence)).toMatchObject({
    sources: [{ selectedQuotes: ["Workshop Friday."], text: source, truncated: false }],
    verifiedReferences: [],
  });
  expect(getKnowledgeClaims(db, "framed")[0]?.verification).not.toBe("verified");
});

it("rechecks identical claims after section or page attribution changes and preserves scoped reference evidence", async () => {
  const verify = vi.fn(
    async ({ context }: { claim: string; evidence: string; context?: string }) => ({
      label: context?.includes("Unrelated satellite")
        ? ("neutral" as const)
        : ("entailment" as const),
      probability: 1,
    }),
  );
  const brain = service({ verify, dispose: () => {} });
  const initial = {
    ...proposal("scoped"),
    title: "Workshop",
    markdown: '<claim id="date" refs="source:evidence">## Workshop\n\nWorkshop Friday.</claim>',
  };
  await brain.save(initial);
  await brain.save({ ...initial, expectedRevision: 1 });
  expect(verify).toHaveBeenCalledTimes(1);
  const previous = getKnowledgeClaims(db, "scoped")[0]!;
  await expect(
    brain.save({ ...initial, expectedRevision: 2, title: "Unrelated satellite" }),
  ).rejects.toMatchObject({ code: "claim_invalid" });
  await expect(
    brain.save({
      ...initial,
      expectedRevision: 2,
      markdown:
        '<claim id="heading" refs="source:evidence">## Unrelated satellite</claim>\n\n<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
    }),
  ).rejects.toMatchObject({ code: "claim_invalid" });
  expect(getKnowledgeNode(db, "scoped")?.revision).toBe(2);
  await brain.save({ ...initial, expectedRevision: 2, title: "Historical workshop" });
  expect(getKnowledgeClaims(db, "scoped")[0]!.meaningRevision).toBeGreaterThan(
    previous.meaningRevision,
  );
  expect(brain.reference("wiki:scoped#claim:date").text).toContain(
    '"pageTitle":"Historical workshop"',
  );
  expect(brain.reference("wiki:scoped#claim:date").verified).toBe(true);
});

it.each([
  "entailment-verifier",
  "contextual-entailment-verifier-v3",
  "contextual-entailment-verifier-v4",
])("rejudges legacy wiki proof policy %s before supporting other claims", async (legacyMarker) => {
  const verify = vi.fn(verifier.verify);
  const brain = service({ verify, dispose: () => {} });
  await brain.save(proposal("legacy"));
  db.prepare("UPDATE knowledge_claims SET verifier=? WHERE node_id=?").run(legacyMarker, "legacy");
  expect(brain.reference("wiki:legacy#claim:date").verified).toBe(false);
  await brain.save({ ...proposal("legacy"), expectedRevision: 1 });
  expect(verify).toHaveBeenCalledTimes(2);
  expect(brain.reference("wiki:legacy#claim:date").verified).toBe(true);
});

it("checks historical root statements in context without turning a generic title into currentness", async () => {
  const verify = vi.fn(async (_input: { claim: string; evidence: string; context?: string }) => ({
    label: "entailment" as const,
    probability: 1,
  }));
  await service({ verify, dispose: () => {} }).save({
    ...proposal("root-history"),
    kind: "root",
    title: "Life overview",
    markdown:
      '<claim id="date" refs="source:evidence">The workshop was planned for Friday.</claim>',
  });
  expect(verify.mock.calls[0]![0].claim).toBe("The workshop was planned for Friday.");
  expect(JSON.parse(verify.mock.calls[0]![0].context!)).toMatchObject({
    pageTitle: "Life overview",
  });
});

it("cannot launder unverified enclosing assertions through a verified nested wiki claim", async () => {
  const brain = service(verifier);
  await brain.save({
    ...proposal("nested"),
    markdown:
      '<claim id="parent" refs="source:evidence">Guaranteed prize next year: <claim id="date" refs="source:evidence">Workshop Friday.</claim></claim>',
    claims: [{ id: "parent", epistemicStatus: "unsupported" }],
  });
  expect(getKnowledgeClaims(db, "nested").find((claim) => claim.id === "date")?.verification).toBe(
    "stale",
  );
  expect(brain.reference("wiki:nested#claim:date").verified).toBe(false);
  await brain.save(proposal("downstream", "wiki:nested#claim:date"));
  expect(
    db.prepare("SELECT verification FROM knowledge_claims WHERE node_id='downstream'").get(),
  ).toEqual({ verification: "unverified" });
  expect(getKnowledgeClaims(db, "downstream")[0]?.verification).toBe("stale");
});

it.each(["wiki", "loop"] as const)(
  "rechecks enclosing %s proof inside the writer when it changes during downstream verification",
  async (kind) => {
    if (kind === "loop") {
      createBriefsStorageTables(db);
      createOpenLoop(
        db,
        {
          id: "nested",
          title: "Workshop",
          createdByRun: "seed",
          confidence: 0.8,
          importance: 0.5,
          docs: ["evidence"],
        },
        1,
      );
    }
    await service(verifier).save({
      ...proposal("nested"),
      kind,
      ...(kind === "loop" ? { ownerId: "nested" } : {}),
      markdown:
        '<claim id="parent" refs="source:evidence">Workshop: <claim id="date" refs="source:evidence">Workshop Friday.</claim></claim>',
    });
    expect(service().reference(`${kind}:nested#claim:date`).verified).toBe(true);
    const brain = service({
      verify: async () => {
        db.exec(
          "UPDATE knowledge_claims SET verification='unverified' WHERE node_id='nested' AND id='parent'",
        );
        return { label: "entailment", probability: 1 };
      },
      dispose: () => {},
    });
    await expect(
      brain.save(proposal("downstream", `${kind}:nested#claim:date`)),
    ).rejects.toMatchObject({
      code: kind === "loop" ? "revision_conflict" : "reference_invalid",
    });
    expect(getKnowledgeNode(db, "downstream")).toBeNull();
    expect(brain.reference(`${kind}:nested#claim:date`).verified).toBe(false);
  },
);

async function nestedContextFixture() {
  db.prepare("INSERT INTO documents VALUES('scope','Archive scope.','v1')").run();
  db.prepare("INSERT INTO documents VALUES('separate','Unrelated inventory.','v1')").run();
  const brain = service(verifier);
  const input: KnowledgeProposal = {
    ...proposal("nested-context"),
    markdown:
      '<claim id="parent" refs="source:scope">Archive: <claim id="child" refs="source:evidence">Workshop Friday.</claim></claim>\n<claim id="separate" refs="source:separate">Unrelated inventory.</claim>',
    inputVersions: { "source:scope": "v1", "source:evidence": "v1", "source:separate": "v1" },
    claims: [{ id: "parent", attribution: "Archive guide", validFrom: 10 }],
  };
  await brain.save(input);
  await brain.save(proposal("context-dependent", "wiki:nested-context#claim:child"));
  return { brain, input };
}
it("projects implicit parent source invalidation through a selected child immediately", async () => {
  await nestedContextFixture();
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='scope'").run();
  // Read fences must work even before the bounded physical cascade runs.
  expect(
    getKnowledgeClaims(db, "nested-context").find((claim) => claim.id === "child")?.verification,
  ).toBe("stale");
  expect(getKnowledgeNode(db, "context-dependent")?.validity).toBe("stale");
  recordKnowledgeSourceChange(db, { documentId: "scope", contentHash: "v2" }, 101);
  expect(service().reference("wiki:nested-context#claim:child").verified).toBe(false);
});
it("binds inherited parent semantics and invalidates child dependents on metadata-only changes", async () => {
  const { brain, input } = await nestedContextFixture();
  const previous = getKnowledgeClaims(db, input.id).find((claim) => claim.id === "child")!;
  await brain.save({ ...input, claims: undefined, expectedRevision: 1 });
  expect(
    getKnowledgeClaims(db, input.id).find((claim) => claim.id === "child")?.meaningRevision,
  ).toBe(previous.meaningRevision);
  expect(getKnowledgeNode(db, "context-dependent")?.validity).toBe("current");
  expect(brain.reference("wiki:nested-context#claim:child").text).toContain("Archive guide");
  await brain.save({
    ...input,
    expectedRevision: 2,
    claims: [{ id: "parent", attribution: "Revised archive guide", validFrom: 20 }],
  });
  expect(
    getKnowledgeClaims(db, input.id).find((claim) => claim.id === "child")!.meaningRevision,
  ).toBeGreaterThan(previous.meaningRevision);
  expect(getKnowledgeNode(db, "context-dependent")?.validity).toBe("stale");
});
it("does not inherit an unrelated sibling's source invalidation", async () => {
  await nestedContextFixture();
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='separate'").run();
  recordKnowledgeSourceChange(db, { documentId: "separate", contentHash: "v2" }, 101);
  expect(
    getKnowledgeClaims(db, "nested-context").find((claim) => claim.id === "child")?.verification,
  ).toBe("verified");
  expect(getKnowledgeNode(db, "context-dependent")?.validity).toBe("current");
});
it("hides child references and downstream pages when a parent's source is pending deletion", async () => {
  await nestedContextFixture();
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('scope','v1',1,101)",
  ).run();
  expect(getKnowledgeNode(db, "context-dependent")).toBeNull();
  expect(() => service().reference("wiki:nested-context#claim:child")).toThrow();
});
it("changes a nested claim's meaning when its enclosing prose changes", async () => {
  const { brain, input } = await nestedContextFixture();
  const before = getKnowledgeClaims(db, input.id).find((claim) => claim.id === "child")!;
  await brain.save({
    ...input,
    expectedRevision: 1,
    markdown: input.markdown.replace("Archive: ", "Previous archive: "),
  });
  const after = getKnowledgeClaims(db, input.id).find((claim) => claim.id === "child")!;
  expect(after.text).toBe(before.text);
  expect(after.meaningRevision).toBeGreaterThan(before.meaningRevision);
  expect(getKnowledgeNode(db, "context-dependent")?.validity).toBe("stale");
});

it("sends source record title and dates to verification without rewriting reference text", async () => {
  db.exec(
    "ALTER TABLE documents ADD COLUMN title TEXT; ALTER TABLE documents ADD COLUMN source_created_at TEXT; ALTER TABLE documents ADD COLUMN source_updated_at TEXT; UPDATE documents SET title='Workshop notice',source_created_at='2026-01-03'",
  );
  const verify = vi.fn(async (_input: { claim: string; evidence: string }) => ({
    label: "entailment" as const,
  }));
  const brain = service({ verify, dispose() {} });
  expect(brain.reference("source:evidence")).toMatchObject({
    text: "Workshop Friday.",
    sourceMetadata: { title: "Workshop notice", sourceCreatedAt: "2026-01-03" },
  });
  await brain.save(proposal("framed-date"));
  expect(JSON.parse(verify.mock.calls[0]![0].evidence)).toMatchObject({
    sources: [
      { title: "Workshop notice", sourceCreatedAt: "2026-01-03", text: "Workshop Friday." },
    ],
  });
});

it("refuses oversized combined source support before spending a verifier call", async () => {
  const refs: string[] = [];
  for (let i = 0; i < 7; i++) {
    const id = `large-${i}`;
    db.prepare("INSERT INTO documents VALUES(?,?,?)").run(id, "x".repeat(40_000), "v1");
    refs.push(`source:${id}`);
  }
  const verify = vi.fn(async () => ({ label: "entailment" as const }));
  const brain = service({ verify, dispose() {} });
  await expect(
    brain.save({
      ...proposal("oversized"),
      markdown: `<claim id="fact" refs="${refs.join(" ")}">Combined statement.</claim>`,
      inputVersions: Object.fromEntries(refs.map((ref) => [ref, "v1"])),
    }),
  ).rejects.toThrow("bounded verifier evidence budget");
  expect(verify).not.toHaveBeenCalled();
  expect(getKnowledgeNode(db, "oversized")).toBeNull();
});

it.each([
  "entailment-verifier",
  "annotation-context-verifier-v1",
  "annotation-context-verifier-v2",
])("canonical annotation saves rejudge prior authority policy %s", async (legacyMarker) => {
  createAnnotationStorageTables(db);
  const text = "The first robotic arm was calibrated. Calibration of the second arm is planned.";
  db.prepare("UPDATE documents SET content=? WHERE id='evidence'").run(text);
  createDocAnnotation(
    db,
    {
      id: "note",
      docId: "evidence",
      claimType: "calibration",
      claimText: "Both robotic arms were calibrated.",
      evidenceDocId: "evidence",
      evidenceQuote: text,
      confidence: 0.8,
      claimBasis: "synthesized",
      createdByRun: "seed",
    },
    1,
  );
  let verdict: "neutral" | "entailment" = "neutral";
  const verify = vi.fn(async (input: { claim: string; evidence: string; context?: string }) => {
    expect(JSON.parse(input.context!)).toMatchObject({ kind: "document annotation" });
    expect(input).toHaveProperty("assessment", "annotation_atomic");
    return { label: verdict };
  });
  const brain = service({ verify, dispose() {} });
  const input: KnowledgeProposal = {
    id: "note",
    ownerId: "note",
    kind: "doc_annotation",
    title: "calibration",
    markdown: '<claim id="fact" refs="source:evidence">Both robotic arms were calibrated.</claim>',
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
  };
  await expect(brain.save(input)).rejects.toThrow("not entailed");
  expect(getKnowledgeNode(db, "note")).toBeNull();
  // The scripted positive establishes only the marker/reuse protocol, not claim quality.
  verdict = "entailment";
  const saved = await brain.save(input);
  expect(getKnowledgeClaims(db, "note")[0]?.verifier).toBe(ANNOTATION_CONTEXT_VERIFIER);
  const calls = verify.mock.calls.length;
  await brain.save({ ...input, expectedRevision: saved.node.revision });
  expect(verify).toHaveBeenCalledTimes(calls);
  expect(brain.reference("annotation:note#claim:fact").verified).toBe(true);
  db.prepare("UPDATE knowledge_claims SET verifier=? WHERE node_id='note'").run(legacyMarker);
  expect(brain.reference("annotation:note#claim:fact").verified).toBe(false);
  verdict = "neutral";
  await expect(
    brain.save({ ...input, expectedRevision: getKnowledgeNode(db, "note")!.revision }),
  ).rejects.toThrow("not entailed");
  expect(verify).toHaveBeenCalledTimes(calls + 1);
  expect(getKnowledgeClaims(db, "note")[0]?.verifier).toBe(legacyMarker);
});

it("returns the evidence registration version without acknowledging a later source write", async () => {
  const gate = directKnowledgeGate(db);
  const register = gate["knowledge.evidence"];
  const guardedGate = {
    ...gate,
    "knowledge.evidence": async (...args: Parameters<typeof register>) => {
      const result = await register(...args);
      db.prepare(
        "UPDATE documents SET content_hash='v2',content='Workshop Saturday.' WHERE id='evidence'",
      ).run();
      return result;
    },
  } satisfies typeof gate;
  const brain = new KnowledgeService({
    db,
    writeGate: guardedGate,
    getSettings: () => resolveBrainSettings(),
    clock: () => 100,
    log: createLogger("knowledge-test"),
  });
  const registered = await brain.evidence({
    documentId: "evidence",
    contentHash: "v1",
    quote: "Workshop Friday.",
  });
  expect(registered.revision).toBe("v1");
  expect(registered.quote).toBe("Workshop Friday.");
  await expect(brain.save(proposal("raced-quote", registered.ref))).rejects.toThrow();
  expect(getKnowledgeNode(db, "raced-quote")).toBeNull();
});

it.each([
  [
    new ContextualAssessmentError("witness_outside_authority", "scripted-judge"),
    "witness_outside_authority",
  ],
  [new Error("Sensitive source text must not enter operational logs"), "verifier_unavailable"],
  [
    new AnnotationAssessmentError("candidate_span", "scripted-judge"),
    "assessment_schema, annotationFailure=candidate_span",
  ],
  [
    Object.assign(new AnnotationAssessmentError("coverage", "scripted-judge"), {
      annotationFailure: "Sensitive source text",
    }),
    "assessment_schema",
  ],
])(
  "records content-free per-claim verification failures while preserving unverified status",
  async (failure, category) => {
    const log = createLogger("knowledge-test");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const brain = new KnowledgeService({
      db,
      writeGate: directKnowledgeGate(db),
      getSettings: () => resolveBrainSettings(),
      clock: () => 100,
      log,
      getEntailmentVerifier: async () => ({
        verify: async () => {
          throw failure;
        },
        dispose: () => {},
      }),
    });
    await brain.save(proposal("diagnostic"));
    expect(getKnowledgeClaims(db, "diagnostic")[0]?.verification).toBe("unverified");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        `^Knowledge claim verification unavailable; retaining unverified claim \\(category=${category}, target=${knowledgeHash(["diagnostic", "date"])}, fingerprint=[a-f0-9]{64}, evidence=1/1\\)$`,
      ),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('"diagnostic"');
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Sensitive source text");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Workshop Friday");
  },
);

it("correlates unavailable alternatives and proposal changes without exposing target identifiers", async () => {
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run(
    "second-evidence",
    "Workshop Friday.",
    "v1",
  );
  const log = createLogger("knowledge-test");
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const verify = vi.fn(async () => {
    throw new Error("Untrusted provider detail");
  });
  const brain = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 100,
    log,
    getEntailmentVerifier: async () => ({ verify, dispose: () => {} }),
  });
  const input: KnowledgeProposal = {
    ...proposal("private-node-identifier", "source:evidence source:second-evidence"),
    inputVersions: { "source:evidence": "v1", "source:second-evidence": "v1" },
    claims: [{ id: "date", supportLogic: "any" }],
  };
  await brain.save(input);
  await brain.save({ ...input, expectedRevision: 1 });
  await brain.save({ ...input, expectedRevision: 2, title: "Proposed workshop" });
  const messages = warn.mock.calls.map(([message]) => message);
  const fields = messages.map(
    (message) =>
      /target=([a-f0-9]{64}), fingerprint=([a-f0-9]{64}), evidence=(\d+\/\d+)/.exec(message)!,
  );
  expect(fields).toHaveLength(6);
  expect(fields.map((field) => field[1])).toEqual(Array(6).fill(knowledgeHash([input.id, "date"])));
  expect(fields.map((field) => field[3])).toEqual(["1/2", "2/2", "1/2", "2/2", "1/2", "2/2"]);
  expect(fields[0]![2]).toBe(fields[2]![2]);
  expect(fields[4]![2]).not.toBe(fields[0]![2]);
  expect(fields[4]![2]).toBe(fields[5]![2]);
  expect(messages.join("\n")).not.toMatch(
    /private-node-identifier|second-evidence|Workshop|Untrusted provider/,
  );
  expect(getKnowledgeClaims(db, input.id)[0]?.verification).toBe("unverified");
  expect(verify).toHaveBeenCalledTimes(6);
});

it("preserves unavailable claim handling when the diagnostic sink throws", async () => {
  const brain = service({
    verify: async () => {
      throw new Error("Untrusted provider detail");
    },
    dispose: () => {},
  });
  vi.spyOn(brain.deps.log, "warn").mockImplementation(() => {
    throw new Error("Log sink failed");
  });
  await brain.save(proposal("unavailable-log-sink"));
  expect(getKnowledgeClaims(db, "unavailable-log-sink")[0]?.verification).toBe("unverified");
});

it("rejudges an annotation when an enclosing qualification changes outside identical claim text", async () => {
  createAnnotationStorageTables(db);
  const source = "Only after inspection, the panel may be installed.";
  db.prepare("UPDATE documents SET content=? WHERE id='evidence'").run(source);
  createDocAnnotation(
    db,
    {
      id: "qualified-note",
      docId: "evidence",
      claimType: "assembly-status",
      claimText: source,
      evidenceDocId: "evidence",
      evidenceQuote: source,
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "seed",
    },
    1,
  );
  const verify = vi.fn(async (input: { claim: string; evidence: string; context?: string }) => {
    expect(input).toHaveProperty("assessment", "annotation_atomic");
    const context = JSON.parse(input.context!);
    expect(context.enclosingContext.annotation.text).toContain("inspection");
    expect(input.evidence).not.toContain("Without inspection");
    return {
      label:
        input.claim !== "the panel may be installed." ||
        context.enclosingContext.annotation.text.startsWith("Only after")
          ? ("entailment" as const)
          : ("neutral" as const),
    };
  });
  const brain = service({ verify, dispose() {} });
  const proposal: KnowledgeProposal = {
    id: "qualified-note",
    ownerId: "qualified-note",
    kind: "doc_annotation",
    title: "assembly-status",
    markdown:
      '<claim id="condition" refs="source:evidence">Only after inspection: <claim id="fact" refs="source:evidence">the panel may be installed.</claim></claim>',
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
  };
  const saved = await brain.save(proposal);
  await brain.save({ ...proposal, expectedRevision: saved.node.revision });
  expect(verify).toHaveBeenCalledTimes(2);
  await expect(
    brain.save({
      ...proposal,
      expectedRevision: getKnowledgeNode(db, proposal.id)!.revision,
      markdown: proposal.markdown.replace("Only after inspection", "Without inspection"),
    }),
  ).rejects.toThrow("not entailed");
  expect(verify).toHaveBeenCalledTimes(4);
  expect(getKnowledgeNode(db, proposal.id)!.plainText).toContain("Only after inspection");
});

it("keeps unverified annotation siblings out of selected-claim witness authority", async () => {
  createAnnotationStorageTables(db);
  createDocAnnotation(
    db,
    {
      id: "note-with-sibling",
      docId: "evidence",
      claimType: "workshop-note",
      claimText: "Workshop Friday. The courtyard contains a telescope.",
      evidenceDocId: "evidence",
      evidenceQuote: "Workshop Friday.",
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "seed",
    },
    1,
  );
  const brain = service({
    verify: async () => ({ label: "entailment" }),
    dispose() {},
  });
  await brain.save({
    id: "note-with-sibling",
    ownerId: "note-with-sibling",
    kind: "doc_annotation",
    title: "workshop-note",
    markdown:
      '<claim id="fact" refs="source:evidence">Workshop Friday.</claim> <claim id="sibling" refs="">The courtyard contains a telescope.</claim>',
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
  });
  const view = brain.reference("annotation:note-with-sibling#claim:fact");
  expect(view.verified).toBe(true);
  expect(view.text).toBe("Workshop Friday.");
  expect(view.interpretationContext?.annotation?.text).toContain(
    "The courtyard contains a telescope.",
  );
  const verifier = vi.fn(async (input: { evidence: string }) => {
    expect(input.evidence).toContain("The courtyard contains a telescope.");
    expect(witnessSources(input.evidence)).toEqual(["Workshop Friday."]);
    return { label: "neutral" as const };
  });
  const dependent = service({ verify: verifier, dispose() {} });
  await expect(
    dependent.save({
      ...proposal("dependent", view.ref),
      markdown: `<claim id="date" refs="${view.ref}">The courtyard contains a telescope.</claim>`,
      inputVersions: { [view.ref]: view.revision },
    }),
  ).rejects.toThrow("not entailed");
  expect(verifier).toHaveBeenCalledTimes(1);
});

it("verifies split loop claims in final context and exposes only the selected assertion as evidence", async () => {
  createBriefsStorageTables(db);
  createOpenLoop(
    db,
    {
      id: "display",
      title: "Prepare the display",
      description: "Assembly proposed Monday; approved Friday.",
      createdByRun: "seed",
      confidence: 0.8,
      importance: 0.5,
      docs: ["evidence"],
    },
    1,
  );
  const verify = vi.fn(async (input: { claim: string; context?: string }) => {
    const context = JSON.parse(input.context!);
    expect(context.pageTitle).toBe("Prepare the display");
    expect(context.outcome.text).toContain("approved Friday");
    return {
      label: input.claim.includes("Later") ? ("neutral" as const) : ("entailment" as const),
    };
  });
  const brain = service({ verify, dispose() {} });
  const input: KnowledgeProposal = {
    id: "display",
    ownerId: "display",
    kind: "loop",
    title: "Prepare the display",
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
    markdown:
      '<claim id="approval" refs="source:evidence">The display was approved Friday.</claim>\n<claim id="assembly" refs="source:evidence">Later, assembly was proposed.</claim>',
  };
  await expect(brain.save(input)).rejects.toThrow("not entailed");
  expect(getKnowledgeNode(db, "display")).toBeNull();
  const saved = await brain.save({
    ...input,
    markdown: input.markdown.replace("Later, assembly", "Earlier, assembly"),
  });
  expect(getKnowledgeClaims(db, "display").every((c) => c.verifier === CONTEXTUAL_VERIFIER)).toBe(
    true,
  );
  const selected = new KnowledgeReferenceReader(db).reference("loop:display#claim:assembly");
  expect(selected.verified).toBe(true);
  expect(selected.text).toBe("Earlier, assembly was proposed.");
  expect(selected.interpretationContext?.outcome?.text).toContain("approved Friday");
  expect(witnessSources(selected.verifierEvidence!)).toEqual(["Earlier, assembly was proposed."]);
  db.prepare(
    "UPDATE knowledge_claims SET verifier='entailment-verifier' WHERE node_id='display' AND id='assembly'",
  ).run();
  expect(brain.reference("loop:display#claim:assembly").verified).toBe(false);
  const before = verify.mock.calls.length;
  await brain.save({
    ...input,
    expectedRevision: saved.node.revision,
    markdown: input.markdown.replace("Later, assembly", "Earlier, assembly"),
  });
  expect(verify.mock.calls.length).toBe(before + 1);
});

it.each(["resolution", "verification"] as const)(
  "cancels expired %s and retains only an unverified claim",
  async (stage) => {
    vi.useFakeTimers();
    let stageSignal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const verify = vi.fn(async (input: Parameters<EntailCapability["verify"]>[0]) => {
      stageSignal = input.signal;
      await blocked;
      return { label: "entailment" as const, probability: 1 };
    });
    const brain = new KnowledgeService({
      db,
      writeGate: directKnowledgeGate(db),
      getSettings: () => resolveBrainSettings(),
      clock: () => 100,
      log: createLogger("knowledge-test"),
      getEntailmentVerifier: async (signal) => {
        if (stage === "resolution") {
          stageSignal = signal;
          await blocked;
        }
        return { verify, dispose: () => {} };
      },
    });
    try {
      const saving = brain.save(proposal("expired-verification"));
      await vi.advanceTimersByTimeAsync(45_000);
      await saving;
      expect(stageSignal?.aborted).toBe(true);
      expect(getKnowledgeClaims(db, "expired-verification")[0]?.verification).toBe("unverified");
      expect(verify).toHaveBeenCalledTimes(stage === "resolution" ? 0 : 1);
      finish!();
      await vi.advanceTimersByTimeAsync(0);
      expect(getKnowledgeClaims(db, "expired-verification")[0]?.verification).toBe("unverified");
    } finally {
      finish?.();
      vi.useRealTimers();
    }
  },
);

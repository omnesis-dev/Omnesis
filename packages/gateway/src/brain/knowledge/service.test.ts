// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { KnowledgeService, type KnowledgeProposal } from "./service.js";
import {
  createKnowledgeTables,
  getKnowledgeClaims,
  getKnowledgeNode,
  recordKnowledgeSourceChange,
  purgeKnowledgeBySource,
} from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { proposeKnowledgeCandidate, getKnowledgeCandidate } from "./discovery.js";
import { directKnowledgeGate } from "./writer.js";

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
    const candidate = proposeKnowledgeCandidate(
      db,
      {
        id: "candidate",
        identityKey: "project:workshop",
        title: "Workshop",
        scope: "Planning",
        evidenceVersions: { evidence: "v1" },
      },
      1,
    );
    const brain = service({
      verify: async () => {
        if (change === "abandoned") db.exec("UPDATE knowledge_batches SET status='abandoned'");
        else db.exec("UPDATE knowledge_batches SET run_id='replacement'");
        return { label: "entailment", probability: 1 };
      },
      dispose: () => {},
    });
    await expect(
      brain.save(
        proposal("new-page"),
        { candidateId: candidate.id, expectedCandidateRevision: candidate.revision },
        { batchId: "batch", runId: "run" },
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
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
        if (evidence === "Bring paper.") return { label: "neutral", probability: 1 };
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
    prepared.mock.calls.filter(([sql]) => sql === "SELECT content FROM documents WHERE id=?"),
  ).toHaveLength(1);
  prepared.mockRestore();
  db.exec("UPDATE knowledge_claims SET verification='unverified' WHERE node_id='left-0'");
  expect(brain.reference(refs[0]!).verified).toBe(false);
});

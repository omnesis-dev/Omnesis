// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { ContextualAssessmentError } from "../../inference/contextual-entailment.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createBriefClaimsTables } from "../storage/brief-claims.js";
import { createBrief, getBrief } from "../storage/briefs.js";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables, getKnowledgeNode } from "./storage.js";
import { materializeKnowledgeOwner } from "./owner-adapters.js";
import { KnowledgeService, type KnowledgeProposal } from "./service.js";
import { directKnowledgeGate } from "./writer.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,source_id TEXT,metadata TEXT,title TEXT,source_created_at TEXT,source_updated_at TEXT); INSERT INTO documents VALUES('evidence','Orion opens in July. Lyra is still being planned.','v1','fixture','{}','Exhibit notice','2026-06-01','2026-06-01')",
  );
  createBriefsStorageTables(db);
  createBriefClaimsTables(db);
  createKnowledgeTables(db);
  createBrief(
    db,
    {
      id: "card",
      createdByRun: "seed",
      kind: "info",
      title: "Exhibit plans",
      body: "Orion opens in July.",
      citations: ["evidence"],
      confidence: 0.9,
      urgency: 0.5,
    },
    1,
  );
  materializeKnowledgeOwner(db, "card", 1);
});
afterEach(() => db.close());
function proposal(): KnowledgeProposal {
  const node = getKnowledgeNode(db, "card")!;
  return {
    id: "card",
    ownerId: "card",
    kind: "brief",
    title: node.title,
    markdown: node.markdown,
    expectedRevision: node.revision,
    inputVersions: { "source:evidence": "v1" },
  };
}
function service(
  getEntailmentVerifier: () => Promise<EntailCapability | null>,
  log = createLogger("brief-context-test"),
) {
  return new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 100,
    log,
    getEntailmentVerifier,
  });
}
const positive = (): EntailCapability => ({
  verify: async () => ({ label: "entailment" }),
  dispose() {},
});

test("canonical brief save checks the proposed complete title and prose before projection", async () => {
  const seen: Array<{ claim: string; context?: string }> = [];
  const brain = service(async () => ({
    dispose() {},
    verify: async (input) => {
      seen.push(input);
      return {
        label: input.context && input.claim.includes("Lyra opens") ? "neutral" : "entailment",
      };
    },
  }));
  await expect(brain.save({ ...proposal(), title: "Lyra opens in July" })).rejects.toThrow(
    "complete displayed brief",
  );
  expect(getBrief(db, "card")?.title).toBe("Exhibit plans");
  expect(seen[0]?.context).toContain("asOf");
  expect(JSON.parse(seen[0]!.claim)).toMatchObject({ title: "Lyra opens in July" });
  await expect(brain.save(proposal())).resolves.toMatchObject({ node: { title: "Exhibit plans" } });
});

test.each(["source", "metadata", "owner"])(
  "canonical brief save rejects %s changes during verification",
  async (change) => {
    let changed = false;
    const brain = service(async () => ({
      dispose() {},
      verify: async () => {
        if (!changed) {
          changed = true;
          if (change === "source")
            db.exec("UPDATE documents SET content_hash='v2' WHERE id='evidence'");
          else if (change === "metadata")
            db.exec("UPDATE documents SET source_created_at='2026-07-03' WHERE id='evidence'");
          else db.exec("UPDATE briefs SET title='Concurrent title' WHERE id='card'");
        }
        return { label: "entailment" };
      },
    }));
    await expect(brain.save(proposal())).rejects.toMatchObject({ code: "revision_conflict" });
    expect(getKnowledgeNode(db, "card")?.revision).toBe(1);
  },
);

test.each(["resolver", "verifier"])("canonical brief holds on %s outage", async (outage) => {
  const brain = service(async () => {
    if (outage === "resolver") throw new Error("offline");
    return {
      dispose() {},
      verify: async () => {
        throw new Error("offline");
      },
    };
  });
  await expect(brain.save(proposal())).rejects.toThrow("verification is unavailable");
  expect(getKnowledgeNode(db, "card")?.revision).toBe(1);
});

test("canonical brief preserves the no-assigned-verifier contract", async () => {
  await expect(service(async () => null).save(proposal())).resolves.toMatchObject({
    node: { id: "card" },
  });
});

test("canonical brief rejects a changed derived support version after contextual verification", async () => {
  const brain = service(async () => positive());
  await brain.save({
    id: "exhibit",
    kind: "wiki",
    title: "Exhibit plan",
    markdown: '<claim id="opening" refs="source:evidence">Orion opens in July.</claim>',
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
  });
  const ref = "wiki:exhibit#claim:opening";
  const version = brain.reference(ref).revision;
  let changed = false;
  const racing = service(async () => ({
    dispose() {},
    verify: async (input) => {
      if (input.context && !changed) {
        changed = true;
        db.exec(
          "UPDATE knowledge_claims SET meaning_revision=meaning_revision+1 WHERE node_id='exhibit'",
        );
      }
      return { label: "entailment" };
    },
  }));
  await expect(
    racing.save({
      ...proposal(),
      markdown: proposal().markdown.replace("source:evidence", ref),
      inputVersions: { [ref]: version },
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(getKnowledgeNode(db, "card")?.revision).toBe(1);
});

test("historical unchanged brief proof maintenance omits the additional display judgment", async () => {
  db.exec("UPDATE briefs SET state='retired' WHERE id='card'");
  const contexts: Array<string | undefined> = [];
  const brain = service(async () => ({
    dispose() {},
    verify: async (input) => {
      contexts.push(input.context);
      return { label: "entailment" };
    },
  }));
  await brain.save(proposal());
  expect(contexts.every((context) => context === undefined)).toBe(true);
  await expect(brain.save({ ...proposal(), title: "New historical prose" })).rejects.toThrow();
  expect(getBrief(db, "card")?.title).toBe("Exhibit plans");
});

test.each([
  [
    new ContextualAssessmentError("witness_outside_authority", "private-model-id"),
    "protocol",
    "witness_outside_authority",
  ],
  [new Error("private-body credential=secret timeout 429"), "unknown", undefined],
  [new DOMException("private-body", "AbortError"), "cancelled", undefined],
] as const)(
  "brief refusal exposes only bounded %s diagnostics and preserves the node",
  async (error, category, protocol) => {
    const log = createLogger("brief-diagnostic-test");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const brain = service(
      async () => ({
        dispose() {},
        verify: async () => {
          throw error;
        },
      }),
      log,
    );
    await expect(brain.save(proposal())).rejects.toMatchObject({
      code: "claim_invalid",
      message: expect.stringContaining(`category=${category}`),
    });
    expect(getKnowledgeNode(db, "card")?.revision).toBe(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Brief verification unavailable; preserving existing brief",
      { category, ...(protocol ? { protocol } : {}) },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-body|private-model-id|secret/);
  },
);

test("the real service deadline yields a bounded timeout refusal without changing the brief", async () => {
  vi.useFakeTimers();
  const log = createLogger("brief-deadline-test");
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  try {
    const brain = service(async () => ({ dispose() {}, verify: () => new Promise(() => {}) }), log);
    const saving = brain.save(proposal());
    const rejected = expect(saving).rejects.toMatchObject({
      code: "claim_invalid",
      message: expect.stringContaining("category=timeout"),
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Brief verification unavailable; preserving existing brief",
      { category: "timeout" },
    );
    expect(getKnowledgeNode(db, "card")?.revision).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("verifier resolution failure logs once with no provider detail", async () => {
  const log = createLogger("brief-resolution-test");
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  await expect(
    service(async () => {
      throw new Error("secret-provider-detail");
    }, log).save(proposal()),
  ).rejects.toMatchObject({ message: expect.stringContaining("category=unknown") });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-provider-detail");
});

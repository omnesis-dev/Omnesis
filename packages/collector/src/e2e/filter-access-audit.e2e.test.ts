// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * "Who can read this document?" and a document's filter details, against
 * what agents connected over MCP really read, through a real collector and a
 * spawned gateway.
 *
 * The `repository-filters` universe's GitHub account is read by a build
 * before versions, then resynced in place while its last thread cannot be
 * read again: that thread stays at version 0, too old for the repository
 * field, and every other record carries its repository's id at version 2,
 * except the `sketches` records, whose repository GitHub gave no id for.
 * Five levels cover every reason a verdict can give, for Answer and for
 * Direct:
 *
 *  - "Hide personal": Answer and Direct, each hiding the owner maya-reeves on
 *    both accounts;
 *  - "Work only": Direct only, sharing only the owner northstar-labs;
 *  - "Commits only": Answer and Direct, each sharing the commits account alone;
 *  - "Answers only": Answer only, sharing only the owner northstar-labs;
 *  - "Spare level": no agent; Direct hiding one repository, and Answer.
 *
 * Asserted: the audit lists every level, the one with no agent included,
 * with its agents and an Answer and a Direct verdict, and its two fixed
 * notes; each verdict has the reason the level's rules give; and for every
 * level an agent is connected to, `readable` is exactly what that agent
 * reads: a Direct verdict against the agent's own fetch and search, an
 * Answer verdict against what the Omnesis agent answering it fetched and
 * found by search, its model a scripted one that asks for every record by id. An agent whose level does
 * not grant a permission cannot use it at all. The filter details route
 * reports a present, a too old and an unknown repository, and neither route
 * answers an external agent's credential.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  answerReads,
  closeAgents,
  connectAgent,
  createLevel,
  declaredVersion,
  documentAudit,
  expectDirectReads,
  grantRule,
  markerKey,
  ownerPortal,
  readRecords,
  resyncInPlace,
  saveFilters,
  saveLevelFilters,
  sourceFilter,
  type DocumentAudit,
  type RecordSet,
  type StoredRecord,
} from "./filter-e2e-reads.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AuthorizedMcpClient, PortalSession } from "./mcp-oauth-helper.js";
import type { FilterRef, SourceFilter } from "@omnesis/types";

const THREADS = "github:maya-reeves";
const COMMITS = "github-commits:maya-reeves";
const FIELD = "extra.repositoryIds";
const QUERY = "zqfilter";

/** Each record's repository and its owner, by the start of its key; `null` where GitHub gave no id. */
const REPOSITORIES: Record<string, { repository: string; owner: string } | null> = {
  atlas: { repository: "4101", owner: "owner:9001" },
  docs: { repository: "4102", owner: "owner:9001" },
  archive: { repository: "4201", owner: "owner:9002" },
  garden: { repository: "5201", owner: "owner:7001" },
  fork: { repository: "5202", owner: "owner:7001" },
  sketches: null,
};

type Code =
  | "permission-not-granted"
  | "account-not-shared"
  | "readable"
  | "hidden-by-item"
  | "not-included"
  | "record-too-old"
  | "detail-unknown";

/** What a level grants for one permission, as the suite set it up. */
interface Grant {
  /** Accounts the permission shares; `null` is every account. */
  shared: string[] | null;
  /** The filter on each of `sourceIds`. */
  filter?: { action: "share" | "hide"; ids: string[]; sourceIds: string[] };
}

/** A level: enough to say what each of its verdicts must be. */
interface LevelPlan {
  name: string;
  /** Whether an agent is connected to it. */
  agent: boolean;
  answer?: Grant;
  direct?: Grant;
}

const HIDE_PERSONAL: Grant = {
  shared: null,
  filter: { action: "hide", ids: ["owner:7001"], sourceIds: [THREADS, COMMITS] },
};
const WORK_ONLY: Grant = {
  shared: null,
  filter: { action: "share", ids: ["owner:9001"], sourceIds: [THREADS, COMMITS] },
};

const PLANS: LevelPlan[] = [
  { name: "Hide personal", agent: true, answer: HIDE_PERSONAL, direct: HIDE_PERSONAL },
  { name: "Work only", agent: true, direct: WORK_ONLY },
  {
    name: "Commits only",
    agent: true,
    answer: { shared: [COMMITS] },
    direct: { shared: [COMMITS] },
  },
  { name: "Answers only", agent: true, answer: WORK_ONLY },
  {
    name: "Spare level",
    agent: false,
    answer: { shared: null },
    direct: {
      shared: null,
      filter: { action: "hide", ids: ["4101"], sourceIds: [THREADS] },
    },
  },
];

/** The verdict a level's grant for one permission gives a record. */
function expectedCode(grant: Grant | undefined, record: StoredRecord): Code {
  if (!grant) return "permission-not-granted";
  if (grant.shared && !grant.shared.includes(record.sourceId)) return "account-not-shared";
  if (!grant.filter?.sourceIds.includes(record.sourceId)) return "readable";
  if (record.version < 2) return "record-too-old";
  const repository = REPOSITORIES[record.key.split("-")[0]!];
  if (repository === undefined) throw new Error(`No repository for ${record.key}`);
  if (repository === null) return "detail-unknown";
  const matched = grant.filter.ids.some(
    (id) => id === repository.repository || id === repository.owner,
  );
  if (grant.filter.action === "hide") return matched ? "hidden-by-item" : "readable";
  return matched ? "readable" : "not-included";
}

const filtersOf = (grant: Grant | undefined): SourceFilter[] =>
  (grant?.filter?.sourceIds ?? []).map((sourceId) =>
    sourceFilter(
      sourceId,
      grant!.filter!.action,
      grant!.filter!.ids.map((id): FilterRef => ({ capability: "tree", field: FIELD, id })),
    ),
  );

const rulesOf = (plan: LevelPlan) =>
  (["answer", "direct"] as const).flatMap((capability) => {
    const grant = plan[capability];
    if (!grant) return [];
    return [
      grantRule(
        capability,
        grant.shared ? { mode: "allowlist", sourceIds: grant.shared } : undefined,
      ),
    ];
  });

/** Whether an agent is refused a tool outright. */
async function refused(call: () => Promise<{ isError?: unknown }>): Promise<boolean> {
  try {
    return (await call()).isError === true;
  } catch {
    return true;
  }
}

describe("who can read a document, against what agents really read", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let portal: PortalSession;
  let records: RecordSet;
  let tooOld: StoredRecord;
  const agents = new Map<string, AuthorizedMcpClient>();
  const levelIds = new Map<string, string>();

  const audit = (record: StoredRecord) => documentAudit(harness, record);
  const record = (key: string) => {
    const found = records.get(key);
    if (!found) throw new Error(`No record ${key}`);
    return found;
  };

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "repository-filters",
      extraInference: {
        backends: { auditAnswers: { type: "http", url: model.url } },
        assignments: {
          agent: `auditAnswers/${model.modelId}`,
          "privacy-reviewer": `auditAnswers/${model.modelId}`,
        },
      },
    });
    await harness.start();
    // Read first by a build before versions, then resynced in place by the
    // current one, which cannot read the account's last thread again.
    const current = new Map([THREADS, COMMITS].map((id) => [id, declaredVersion(harness, id)]));
    for (const sourceId of [THREADS, COMMITS]) {
      harness.setSourceVersion(sourceId, undefined);
      await harness.triggerSyncAndWait(sourceId, 120_000);
      harness.setSourceVersion(sourceId, current.get(sourceId));
      await resyncInPlace(harness, sourceId);
    }
    process.env.OMNESIS_SYNTH_READ_IMPAIRMENT = `${THREADS}:degraded:1`;
    try {
      for (const sourceId of [THREADS, COMMITS])
        await harness.triggerSyncAndWait(sourceId, 120_000);
    } finally {
      delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
    }
    records = readRecords(harness, [THREADS, COMMITS], markerKey(/BODY_([A-Z_]+)/));
    const old = [...records.values()].filter((candidate) => candidate.version === 0);
    expect(old.map((candidate) => candidate.sourceId)).toEqual([THREADS]);
    tooOld = old[0]!;
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();

    portal = await ownerPortal(harness);
    for (const plan of PLANS) {
      const filters = { answer: filtersOf(plan.answer), direct: filtersOf(plan.direct) };
      if (!plan.agent) {
        const id = await createLevel(harness, portal, plan.name, rulesOf(plan));
        await saveLevelFilters(harness, portal, id, filters);
        levelIds.set(plan.name, id);
        continue;
      }
      const agent = await connectAgent(harness, plan.name, rulesOf(plan));
      await saveFilters(harness, agent, filters);
      agents.set(plan.name, agent);
    }
  }, 400_000);

  afterAll(async () => {
    await closeAgents([...agents.values()]);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("every level is listed with its agents, two verdicts and the page's two notes", async () => {
    const result = await audit(record("atlas-issue"));
    expect(result).toMatchObject({
      documentId: record("atlas-issue").id,
      title: expect.stringContaining("zqfilter TITLE_ATLAS_ISSUE"),
      sourceId: THREADS,
      sourceVersion: 2,
      notes: {
        answer:
          'For Answer, "readable" means the document is within what Omnesis may use when answering that agent. Whether a given answer is then released is decided separately, by the privacy policy\'s review.',
        owner: "This page is for you, the owner. It is never available to an external agent.",
      },
    });
    const names = result.levels.map((level) => level.name);
    expect(names).toEqual(
      [...names].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase())),
    );
    for (const plan of PLANS) {
      const level = result.levels.find((candidate) => candidate.name === plan.name);
      expect(level, plan.name).toBeDefined();
      const agent = agents.get(plan.name);
      expect(level!.agents, plan.name).toEqual(
        agent ? [{ id: agent.grantId, name: expect.any(String), kind: "connection" }] : [],
      );
      if (!agent) expect(level!.id).toBe(levelIds.get(plan.name));
    }
  }, 120_000);

  test("each verdict gives the reason the level's rules give, and is what its agent reads", async () => {
    const all = [...records.values()];
    const audits = new Map<string, DocumentAudit>();
    for (const candidate of all) audits.set(candidate.key, await audit(candidate));
    const seen = { answer: new Set<string>(), direct: new Set<string>() };

    for (const plan of PLANS) {
      const readable = { answer: [] as string[], direct: [] as string[] };
      for (const candidate of all) {
        const level = audits.get(candidate.key)!.levels.find((entry) => entry.name === plan.name)!;
        for (const capability of ["answer", "direct"] as const) {
          const verdict = level[capability];
          const label = `${plan.name}: ${capability} on ${candidate.key}`;
          seen[capability].add(verdict.code);
          expect(verdict.code, label).toBe(expectedCode(plan[capability], candidate));
          expect(verdict.readable, label).toBe(verdict.code === "readable");
          if (verdict.readable) readable[capability].push(candidate.key);
        }
      }

      const agent = agents.get(plan.name);
      if (!agent) continue;
      if (plan.direct) await expectDirectReads(harness, agent, records, readable.direct, QUERY);
      else {
        // A level without Direct gives its agent no Direct tool at all.
        expect(readable.direct).toEqual([]);
        expect(
          await refused(() =>
            agent.client.callTool({
              name: "fetch_many",
              arguments: { documents: [{ documentId: record("atlas-issue").id }] },
            }),
          ),
          `${plan.name} fetched through Direct`,
        ).toBe(true);
      }
      if (plan.answer) {
        for (const sourceId of [THREADS, COMMITS]) {
          const account: RecordSet = new Map(
            [...records].filter(([, candidate]) => candidate.sourceId === sourceId),
          );
          const want = readable.answer.filter((key) => account.has(key)).sort();
          const found = want.filter((key) =>
            account.get(key)!.content.toLowerCase().includes(QUERY),
          );
          let reads = await answerReads(model, agent, account, QUERY);
          // The agent's search reads the index, which may still be catching up.
          for (let attempt = 0; attempt < 10; attempt++) {
            if (JSON.stringify(reads.searched) === JSON.stringify(found)) break;
            await harness.reindexMissing();
            await harness.refreshSearchSnapshot();
            reads = await answerReads(model, agent, account, QUERY);
          }
          expect(reads.fetched, `${plan.name}: Answer fetch of ${sourceId}`).toEqual(want);
          expect(reads.searched, `${plan.name}: Answer search of ${sourceId}`).toEqual(found);
        }
      } else {
        // A level without Answer gives its agent nothing to ask.
        expect(readable.answer).toEqual([]);
        expect(
          await refused(() =>
            agent.client.callTool({
              name: "ask_omnesis",
              arguments: {
                question: "Read the invented records.",
                requestId: randomUUID(),
                workflowName: "Invented filter check",
                workflowPurpose: "Read invented authorized evidence.",
              },
            }),
          ),
          `${plan.name} asked through Answer`,
        ).toBe(true);
      }
    }
    // Every reason a verdict can give was met, for each permission.
    const reasons = [
      "account-not-shared",
      "detail-unknown",
      "hidden-by-item",
      "not-included",
      "permission-not-granted",
      "readable",
      "record-too-old",
    ];
    expect([...seen.answer].sort()).toEqual(reasons);
    expect([...seen.direct].sort()).toEqual(reasons);
  }, 900_000);

  test("each verdict says why, naming the entry that decided it", async () => {
    const level = async (key: string, name: string) =>
      (await audit(record(key))).levels.find((entry) => entry.name === name)!.direct;
    expect(await level("atlas-issue", "Hide personal")).toEqual({
      readable: true,
      code: "readable",
      text: "Readable",
    });
    expect(await level("atlas-issue", "Work only")).toEqual({
      readable: true,
      code: "readable",
      text: "Readable: owner northstar-labs lets it through",
    });
    expect(await level("garden-issue", "Hide personal")).toEqual({
      readable: false,
      code: "hidden-by-item",
      text: "Hidden by: owner maya-reeves",
    });
    expect(await level("atlas-issue", "Spare level")).toEqual({
      readable: false,
      code: "hidden-by-item",
      text: "Hidden by: repository northstar-labs/atlas-api",
    });
    expect(await level("garden-issue", "Work only")).toEqual({
      readable: false,
      code: "not-included",
      text: "Not included by this level's share-only filter",
    });
    expect(await level(tooOld.key, "Work only")).toEqual({
      readable: false,
      code: "record-too-old",
      text: "This record is too old for this filter and has not been resynced",
    });
    expect(await level("sketches-commit", "Hide personal")).toEqual({
      readable: false,
      code: "detail-unknown",
      text: "Its repository is unknown",
    });
    expect(await level("atlas-issue", "Commits only")).toEqual({
      readable: false,
      code: "account-not-shared",
      text: "This account is not shared",
    });
    expect(await level("atlas-issue", "Answers only")).toEqual({
      readable: false,
      code: "permission-not-granted",
      text: "Direct is not granted on this level",
    });
    const answer = async (key: string, name: string) =>
      (await audit(record(key))).levels.find((entry) => entry.name === name)!.answer;
    expect(await answer("atlas-issue", "Answers only")).toEqual({
      readable: true,
      code: "readable",
      text: "Readable: owner northstar-labs lets it through",
    });
    expect(await answer("garden-issue", "Hide personal")).toEqual({
      readable: false,
      code: "hidden-by-item",
      text: "Hidden by: owner maya-reeves",
    });
    expect(await answer("atlas-issue", "Commits only")).toEqual({
      readable: false,
      code: "account-not-shared",
      text: "This account is not shared",
    });
    expect(await answer("atlas-issue", "Work only")).toEqual({
      readable: false,
      code: "permission-not-granted",
      text: "Answer is not granted on this level",
    });
  }, 120_000);

  test("a document's filter details: present, too old and unknown", async () => {
    const details = (candidate: StoredRecord) =>
      harness.gatewayJson<{
        documentId: string;
        sourceVersion: number;
        fields: Array<{ field: string; state: string; stateText: string; items: unknown[] }>;
      }>(`/admin/documents/${encodeURIComponent(candidate.id)}/filter-details`);
    const repositoryNoun = { one: "repository", many: "repositories" };

    expect(await details(record("atlas-commit"))).toEqual({
      documentId: record("atlas-commit").id,
      sourceVersion: 2,
      fields: [
        {
          field: FIELD,
          noun: repositoryNoun,
          state: "present",
          stateText: "",
          items: [{ id: "4101", label: "northstar-labs/atlas-api", listed: true }],
        },
      ],
    });
    expect(await details(tooOld)).toEqual({
      documentId: tooOld.id,
      sourceVersion: 0,
      fields: [
        {
          field: FIELD,
          noun: repositoryNoun,
          state: "too-old",
          stateText:
            "Written before this source recorded its repositories. Resync the source to add them.",
          items: [],
        },
      ],
    });
    expect(await details(record("sketches-commit"))).toEqual({
      documentId: record("sketches-commit").id,
      sourceVersion: 2,
      fields: [
        {
          field: FIELD,
          noun: repositoryNoun,
          state: "unknown",
          stateText: "Not recorded",
          items: [],
        },
      ],
    });
    const missing = await harness.gatewayFetch("/admin/documents/doc_missing/access");
    expect(missing.status).toBe(404);
  }, 60_000);

  test("an external agent's credential reaches neither route", async () => {
    const agent = agents.get("Hide personal")!;
    const token = agent.provider.tokens()?.access_token;
    expect(token).toBeTruthy();
    for (const route of ["access", "filter-details"]) {
      const response = await fetch(
        `${harness.gatewayUrl}/admin/documents/${encodeURIComponent(record("atlas-issue").id)}/${route}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect([401, 403], route).toContain(response.status);
      expect(await response.text()).not.toContain("zqfilter");
    }
  }, 60_000);
});

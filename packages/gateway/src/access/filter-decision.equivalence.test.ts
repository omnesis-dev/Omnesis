// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every way an external agent reaches a document gives the same verdict as
 * the decision the owner's "who can read this" page shows.
 *
 * One account fixture holds a document for each reason a level can or cannot
 * read it, and saved levels hold the filters that produce those reasons, for
 * Answer and for Direct. For every level, permission and document the test
 * asks: the decision itself, the same grant as a set predicate, the document
 * port's fetch, the URL port's lookup, a filtered search through the search
 * pipeline over a real index copy on a real search worker, and the audit page.
 * They must all agree, and the reasons named in {@link CASES} must be the ones
 * the decision gives.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.js";
import {
  createGatewayDocumentByUrlPort,
  createGatewayDocumentPort,
  createGatewaySearchPort,
} from "../agent/ports.js";
import {
  buildFilterCopyBatch,
  refreshFilterListCopy,
  writeFilterCopyBatch,
} from "../indexer/filter-copy.js";
import { createIndexDatabase, upsertChunks } from "../indexer/db.js";
import { SearchPipeline } from "../search/pipeline.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import { createCorpusAuthorization, type CorpusAuthorization } from "./corpus-authorization.js";
import { documentAccessGrant } from "./document-inclusion.js";
import {
  decideDocumentAccess,
  documentAccessInclusionSql,
  type DocumentAccessGrant,
} from "./filter-decision.js";
import {
  LEDGER_PROFILE,
  PARLEY_PROFILE,
  directory,
  folder,
  hide,
  insertDocument,
  label,
  person,
  publishList,
  publishProfile,
  shareOnly,
} from "./filter-test-utils.js";
import { readDocumentAccessAudit } from "./source-filter-editor.js";
import { createAccessLevel } from "./store-levels.js";
import { getLevelCapabilities } from "./store-rules.js";
import type { Db } from "../data/types.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";
import type { SourceFilter } from "@omnesis/types";
import type { AccessGrantRuleInput } from "./types.js";

const LEDGER = "ledger:northstar";
const PARLEY = "parley:studio";
const ALMANAC = "almanac:home";
const LAPTOP = "dev-laptop";
const MAYA = "+15550100123";
const JAMIE = "+15550100456";
const NOW = 1_800_000_000_000;

/** A source type whose label filter a later declaration no longer offers. */
const ALMANAC_PROFILE = {
  documentTypes: ["note"],
  personRoles: [],
  metadataFields: [
    {
      path: "extra.labelIds",
      type: "string-array",
      description: "Label ids.",
      filter: {
        capability: "membership",
        minVersion: 0,
        scope: "global",
        noun: { one: "label", many: "labels" },
        picker: "search",
      },
    },
  ],
} as unknown as DocumentEventProfile;

let dir: string;
let db: Db;
let index: Db;
let pool: SearchWorkerPool;
let pipeline: SearchPipeline;
const levels = new Map<string, string>();

function entry(
  id: string,
  extra: Record<string, unknown>,
  options: { version?: number; streamId?: string; people?: unknown } = {},
): void {
  insertDocument(db, {
    id,
    sourceId: LEDGER,
    version: options.version ?? 3,
    streamId: options.streamId,
    metadata: {
      documentType: "entry",
      ...(options.people === undefined ? {} : { people: options.people }),
      extra,
    },
  });
}

/** Every document, with a URL and a chunk the search finds by one shared word. */
function seedDocuments(): void {
  entry("finance-mail", { labelIds: ["L-finance"], folderIds: ["invoices"] });
  entry("clients-mail", { labelIds: ["L-clients"], folderIds: ["clients"] });
  entry("old-mail", {}, { version: 1 });
  entry("unlisted-folder-mail", { labelIds: [], folderIds: ["vanished"] });
  entry("session", { directory: "/home/maya/work/atlas-api" }, { streamId: LAPTOP });
  entry("session-no-folder", {}, { streamId: LAPTOP });
  entry("session-no-device", { directory: "/home/maya/work" });
  entry(
    "maya-mail",
    {},
    {
      people: [
        { role: "sender", emails: ["maya@example.org"] },
        { role: "recipient", emails: ["jamie@example.io"] },
      ],
    },
  );
  entry("stranger-mail", {}, { people: [{ role: "sender", name: "Someone" }] });
  entry("no-people-mail", {});
  insertDocument(db, {
    id: "orphan-attachment",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "gone" } },
  });
  insertDocument(db, {
    id: "finance-attachment",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "finance-mail" } },
  });
  insertDocument(db, {
    id: "team-day",
    sourceId: PARLEY,
    metadata: {
      documentType: "day",
      people: [{ role: "participant", phones: [JAMIE] }],
      extra: { chatId: "c-team" },
    },
  });
  insertDocument(db, {
    id: "almanac-note",
    sourceId: ALMANAC,
    metadata: { documentType: "note", extra: { labelIds: ["A-private"] } },
  });
  const ids = documentIds();
  for (const id of ids) {
    db.prepare("UPDATE documents SET source_url = ? WHERE id = ?").run(
      `https://example.org/doc/${id}`,
      id,
    );
  }
  const rows = db
    .prepare<[], { id: string; source_id: string }>("SELECT id, source_id FROM documents")
    .all();
  upsertChunks(
    index,
    rows.map((row) => ({
      id: `chunk-${row.id}`,
      documentId: row.id,
      sourceId: row.source_id,
      chunkIndex: 0,
      content: `invented telescope survey ${row.id.replace(/-/g, " ")}`,
      title: row.id,
      sourceCreatedAt: "2027-03-01T09:00:00.000Z",
      embedding: null,
    })),
  );
}

function documentIds(): string[] {
  return db
    .prepare<[], { id: string }>("SELECT id FROM documents ORDER BY id")
    .all()
    .map((row) => row.id);
}

/** Accounts read in full by a new enough collector, with their lists, so every field is usable. */
function seedAccounts(): void {
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at) VALUES ('00000000-0000-4000-8000-0000000000c1', 'Invented collector', 'collector', 1)",
  ).run();
  for (const [id, type] of [
    [LEDGER, "ledger"],
    [PARLEY, "parley"],
    [ALMANAC, "almanac"],
  ] as const) {
    db.prepare(
      "INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at) VALUES (?, ?, ?, '00000000-0000-4000-8000-0000000000c1', 1, 1)",
    ).run(id, type, id.split(":")[1]);
    db.prepare(
      "INSERT INTO sync_state (source_id, device_id, source_version) VALUES (?, '', 5)",
    ).run(id);
    db.prepare(
      `INSERT INTO source_inventories
         (id, source_id, cursor_row, started_at, first_received_at, observed_at, completed_at, min_source_version, full_read_at)
       VALUES (?, ?, '', '2027-03-01T09:00:00.000Z', 1, 1, 1, 5, 1)`,
    ).run(`inventory-${type}`, id);
  }
  publishProfile(db, "ledger", 5, LEDGER_PROFILE);
  publishProfile(db, "parley", 1, PARLEY_PROFILE);
  publishProfile(db, "almanac", 1, ALMANAC_PROFILE);
  publishList(db, { sourceId: LEDGER, field: "extra.labelIds" }, [
    { id: "L-finance", label: "Finance" },
    { id: "L-clients", label: "Clients" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [
    { id: "finance", label: "Finance" },
    { id: "invoices", label: "Invoices", parentId: "finance" },
    { id: "clients", label: "Clients" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: LAPTOP }, [
    { id: "/home/maya/work", label: "~/work" },
    { id: "/home/maya/work/atlas-api", label: "~/work/atlas-api", parentId: "/home/maya/work" },
  ]);
  publishList(db, { sourceId: PARLEY, field: "extra.chatId" }, [
    {
      id: "c-team",
      label: "Studio team",
      members: [
        { type: "phone", value: MAYA },
        { type: "phone", value: JAMIE },
      ],
    },
  ]);
  publishList(db, { sourceId: ALMANAC, field: "extra.labelIds" }, [
    { id: "A-private", label: "Private" },
  ]);
}

type Sources = AccessGrantRuleInput["sources"];

/**
 * The levels, by name. Each grants Direct and (unless noted) Answer over the
 * same accounts, with the same filter for both.
 */
const LEVELS: Array<{
  name: string;
  sources?: Sources;
  directOnly?: boolean;
  filter?: (capability: "direct" | "answer") => SourceFilter;
}> = [
  { name: "Direct only", directOnly: true },
  { name: "Chats only", sources: { mode: "allowlist", sourceIds: [PARLEY] } },
  { name: "Hide finance label", filter: () => hide(LEDGER, [label("L-finance")]) },
  { name: "Share clients label", filter: () => shareOnly(LEDGER, [label("L-clients")]) },
  { name: "Share finance folder", filter: () => shareOnly(LEDGER, [folder("finance")]) },
  { name: "Hide clients folder", filter: () => hide(LEDGER, [folder("clients")]) },
  {
    name: "Hide work folder",
    filter: () => hide(LEDGER, [directory(LAPTOP, "/home/maya/work")]),
  },
  {
    name: "Hide a sender",
    filter: () => hide(LEDGER, [person("Maya", ["email", "maya@example.org"])]),
  },
  {
    name: "Hide a chat member",
    filter: () => hide(PARLEY, [person("Maya", ["phone", MAYA])]),
  },
  {
    name: "Hide private almanac",
    filter: () =>
      hide(ALMANAC, [{ capability: "membership", field: "extra.labelIds", id: "A-private" }]),
  },
];

function saveLevels(): void {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  try {
    for (const level of LEVELS) {
      const sources = level.sources ?? { mode: "all" as const, sourceIds: [] };
      const rule = (capability: "direct" | "answer"): AccessGrantRuleInput => {
        const filter = level.filter?.(capability);
        const scopePolicies = filter
          ? [{ ...filter, audience: { accessLevel: "new", capability } }]
          : undefined;
        return capability === "answer"
          ? {
              capability,
              sources,
              release: { mode: "unreviewed" },
              ...(scopePolicies ? { scopePolicies } : {}),
            }
          : { capability, sources, ...(scopePolicies ? { scopePolicies } : {}) };
      };
      const created = createAccessLevel(
        db,
        {
          name: level.name,
          rules: level.directOnly ? [rule("direct")] : [rule("direct"), rule("answer")],
          actorTokenId: "owner",
        },
        NOW,
      );
      if (!created.ok) throw new Error(`${level.name}: ${created.error}`);
      levels.set(level.name, created.value.id);
    }
  } finally {
    vi.unstubAllEnvs();
  }
}

/** The one reason each case's document has under its level, for both permissions. */
const CASES: Array<{
  level: string;
  document: string;
  code: string;
  cause?: string;
  capabilities?: Array<"direct" | "answer">;
}> = [
  {
    level: "Direct only",
    document: "finance-mail",
    code: "permission-not-granted",
    capabilities: ["answer"],
  },
  { level: "Direct only", document: "finance-mail", code: "readable", capabilities: ["direct"] },
  { level: "Chats only", document: "finance-mail", code: "account-not-shared" },
  { level: "Chats only", document: "team-day", code: "readable" },
  { level: "Hide finance label", document: "clients-mail", code: "readable" },
  { level: "Hide finance label", document: "team-day", code: "readable" },
  { level: "Share clients label", document: "clients-mail", code: "readable" },
  { level: "Share finance folder", document: "finance-mail", code: "readable" },
  { level: "Hide finance label", document: "finance-mail", code: "hidden-by-item" },
  { level: "Hide finance label", document: "finance-attachment", code: "hidden-by-item" },
  { level: "Hide work folder", document: "session", code: "hidden-by-item" },
  { level: "Hide a sender", document: "maya-mail", code: "hidden-by-item" },
  { level: "Hide a chat member", document: "team-day", code: "hidden-by-item" },
  { level: "Share clients label", document: "finance-mail", code: "not-included" },
  { level: "Hide finance label", document: "old-mail", code: "record-too-old" },
  {
    level: "Hide work folder",
    document: "session-no-folder",
    code: "detail-unknown",
    cause: "absent",
  },
  {
    level: "Hide clients folder",
    document: "unlisted-folder-mail",
    code: "detail-unknown",
    cause: "not-listed",
  },
  {
    level: "Hide work folder",
    document: "session-no-device",
    code: "detail-unknown",
    cause: "device-unknown",
  },
  {
    level: "Hide a sender",
    document: "stranger-mail",
    code: "detail-unknown",
    cause: "person-unreadable",
  },
  { level: "Hide a sender", document: "no-people-mail", code: "detail-unknown", cause: "absent" },
  {
    level: "Hide finance label",
    document: "orphan-attachment",
    code: "detail-unknown",
    cause: "parent-missing",
  },
  {
    level: "Hide private almanac",
    document: "almanac-note",
    code: "detail-unknown",
    cause: "filter-unusable",
  },
];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-filter-equivalence-"));
  db = createDatabase(join(dir, "corpus.db")) as unknown as Db;
  index = createIndexDatabase(join(dir, "index.db"));
  seedAccounts();
  saveLevels();
  seedDocuments();
  // The almanac's next declaration drops its label field: the saved filter
  // can no longer be applied, and every record of the account is unknown.
  publishProfile(db, "almanac", 2, {
    ...ALMANAC_PROFILE,
    metadataFields: [],
  } as DocumentEventProfile);
  refreshFilterListCopy({ corpusDb: db, indexDb: index });
  writeFilterCopyBatch(index, buildFilterCopyBatch(db, documentIds()));
  pool = new SearchWorkerPool({
    indexDbPath: join(dir, "index.db"),
    configDir: dir,
    concurrency: 1,
    maxInflightBeforeFallback: 4,
    heartbeatIntervalMs: 1000,
    heartbeatWarnGapMs: 10000,
    workerUrl: new URL("../workers/search-worker.ts", import.meta.url),
    workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
  });
  await pool.start();
  pipeline = new SearchPipeline({ indexDb: index });
  pipeline.setGatewayDb(db);
  pipeline.setSearchPool(pool);
}, 60_000);

afterAll(async () => {
  await pool?.dispose();
  index?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function authorization(
  levelId: string,
  capability: "direct" | "answer",
): CorpusAuthorization | null {
  return createCorpusAuthorization(
    {
      principalId: "invented-principal",
      grantId: `grant-${levelId}`,
      grantRevision: 1,
      credentialId: "invented-credential",
      accessTokenId: "invented-token",
    },
    getLevelCapabilities(db, levelId),
    capability,
  );
}

function grantFor(auth: CorpusAuthorization | null): DocumentAccessGrant {
  return auth
    ? documentAccessGrant(db, auth)
    : { capabilityGranted: false, permittedSourceIds: null, filters: [] };
}

/** The set predicate's members, for one grant. */
function inclusionSet(grant: DocumentAccessGrant): Set<string> {
  const inclusion = documentAccessInclusionSql(db, grant, "d.id", "d.source_id", { row: "d" });
  return new Set(
    db
      .prepare<unknown[], { id: string }>(`SELECT d.id FROM documents d WHERE ${inclusion.sql}`)
      .all(...inclusion.params)
      .map((row) => row.id),
  );
}

describe("one document per reason", () => {
  it.each(
    CASES.flatMap((entry) =>
      (entry.capabilities ?? (["direct", "answer"] as const)).map((capability) => ({
        ...entry,
        capability,
      })),
    ),
  )(
    "$level, $capability, $document: $code $cause",
    ({ level, document, code, cause, capability }) => {
      const decision = decideDocumentAccess(
        db,
        grantFor(authorization(levels.get(level)!, capability)),
        document,
      );
      expect(decision.reason.code).toBe(code);
      expect(decision.readable).toBe(code === "readable");
      if (cause) expect(decision.reason).toMatchObject({ cause });
    },
  );
});

describe("every path agrees with the decision", () => {
  it.each(
    LEVELS.flatMap((level) =>
      (["direct", "answer"] as const).map((capability) => ({ name: level.name, capability })),
    ),
  )(
    "$name, $capability",
    async ({ name, capability }) => {
      const levelId = levels.get(name)!;
      const auth = authorization(levelId, capability);
      const grant = grantFor(auth);
      const ids = documentIds();
      const decided = new Set(ids.filter((id) => decideDocumentAccess(db, grant, id).readable));
      expect(inclusionSet(grant)).toEqual(decided);

      const audit = ids.map((id) => {
        const row = readDocumentAccessAudit(db, id, NOW)!.levels.find(
          (candidate) => candidate.id === levelId,
        )!;
        return { id, verdict: row[capability] };
      });
      for (const { id, verdict } of audit) {
        const decision = decideDocumentAccess(db, grant, id);
        expect({ id, readable: verdict.readable, code: verdict.code }).toEqual({
          id,
          readable: decision.readable,
          code: decision.reason.code,
        });
      }

      // An agent exists only where the permission is granted.
      if (!auth) {
        expect(decided.size).toBe(0);
        return;
      }
      // Each level reads some documents and, but for the unrestricted one, not all.
      expect(decided.size).toBeGreaterThan(0);
      expect(decided.size < ids.length).toBe(auth.restricted);
      const documents = createGatewayDocumentPort(db, undefined, undefined, auth);
      const urls = createGatewayDocumentByUrlPort(db, undefined, auth);
      const fetched = new Set<string>();
      const looked = new Set<string>();
      for (const id of ids) {
        if ((await documents.fetch(id)) !== null) fetched.add(id);
        if ((await urls.lookup(`https://example.org/doc/${id}`)).ref !== undefined) looked.add(id);
      }
      expect(fetched).toEqual(decided);
      expect(looked).toEqual(decided);

      const search = await createGatewaySearchPort(pipeline, undefined, db, auth).search({
        query: "telescope",
        limit: 50,
      });
      expect(new Set(search.results.map((ref) => ref.documentId))).toEqual(decided);
    },
    30_000,
  );
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
type Db = Database.Database;
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger, fullDiskAccessRemediation } from "@omnesis/core";
import {
  defineSource,
  listReadAccessDirectory,
  probeFileReadAccess,
  syncPage,
  SnapshotEnumeration,
  config as configSchema,
  type SourceInstance,
  type SyncProgress,
} from "@omnesis/source-sdk";
import { SyncError, type DocumentInput, type SyncIssue } from "@omnesis/types";
import { thingsIconUrl } from "./icons.js";
import { normalizeTask } from "./normalizer.js";
import { thingsStateSpec } from "./state.js";
import type {
  ThingsSyncCursor,
  RawThingsTask,
  RawThingsChecklistItem,
  RawThingsArea,
} from "./types.js";

const log = createLogger("source:things");

const PAGE_SIZE = 200;

const THINGS_TEMPORAL_STATUS = {
  from: "status",
  map: { open: "active", completed: "completed", canceled: "cancelled" },
  default: "active",
} as const;

/**
 * Schema version this source is written against. Bumped whenever the
 * SELECT projections / table names are revisited against a new Things
 * release. Stamped at sync start so a future Things 4 / iCloud schema
 * change is bisectable from the logs ("worked on `things-3-mac-2024-09`,
 * broken on `things-3-mac-2025-XX`"); does NOT gate runtime behaviour.
 */
const THINGS_ASSUMED_SCHEMA_VERSION = "things-3-mac-2024-09";

export function thingsPathValidationError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return "Cannot access the Things database; grant Full Disk Access in System Settings > Privacy & Security";
  }
  return "File does not exist";
}

/**
 * Tables + columns the source actively reads from. Probed once per
 * `create()` lifetime; missing items log at warn level so a Things schema
 * bump surfaces immediately instead of degrading silently.
 *
 * Tables marked `optional: true` (`TMTaskTag`, `TMTag`) cover features
 * that already degrade gracefully via try/catch — the warning is
 * informational rather than a defect signal.
 */
interface SchemaRequirement {
  table: string;
  columns: ReadonlyArray<string>;
  optional?: boolean;
}
const REQUIRED_SCHEMA: ReadonlyArray<SchemaRequirement> = [
  {
    table: "TMTask",
    columns: [
      "uuid",
      "title",
      "notes",
      "type",
      "status",
      "trashed",
      "creationDate",
      "userModificationDate",
      "startDate",
      "deadline",
      "stopDate",
      "start",
      "project",
      "area",
      "heading",
    ],
  },
  { table: "TMArea", columns: ["uuid", "title"] },
  { table: "TMChecklistItem", columns: ["uuid", "title", "status", "task", "index"] },
  { table: "TMTaskTag", columns: ["tasks", "tags"], optional: true },
  { table: "TMTag", columns: ["uuid", "title"], optional: true },
];

/**
 * Probe the Things SQLite schema and log a single warn line for every
 * table/column the source needs that's missing. Returns `true` when the
 * required (non-optional) schema is fully present.
 */
function probeThingsSchema(db: Db): boolean {
  let ok = true;
  for (const req of REQUIRED_SCHEMA) {
    let cols: { name: string }[];
    try {
      cols = db.prepare(`PRAGMA table_info("${req.table}")`).all() as {
        name: string;
      }[];
    } catch (err) {
      log.warn(
        `Things schema probe: cannot read PRAGMA table_info for ${req.table} — ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!req.optional) ok = false;
      continue;
    }
    if (cols.length === 0) {
      log[req.optional ? "info" : "warn"](
        `Things schema probe: table ${req.table} not present (${req.optional ? "optional — degraded but functional" : "REQUIRED — sync may fail"})`,
      );
      if (!req.optional) ok = false;
      continue;
    }
    const present = new Set(cols.map((c) => c.name));
    const missing = req.columns.filter((c) => !present.has(c));
    if (missing.length > 0) {
      log[req.optional ? "info" : "warn"](
        `Things schema probe: ${req.table} missing columns [${missing.join(", ")}] (${req.optional ? "optional" : "REQUIRED"})`,
      );
      if (!req.optional) ok = false;
    }
  }
  return ok;
}

/**
 * How long the Things database may sit unchanged before a stalled feed is a
 * better explanation than a quiet user. Deliberately generous: task lists
 * genuinely do go silent over a holiday, and a warning that cries wolf is one
 * the operator stops reading. The paired process check is what makes a window
 * this long useful — a fortnight of silence is merely suggestive, but a
 * fortnight of silence while Things is not running is diagnostic.
 */
const THINGS_QUIET_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

/** Group Container for Things 3 */
const THINGS_GROUP_CONTAINER = join(
  process.env.HOME ?? "~",
  "Library",
  "Group Containers",
  "JLMPQHK86H.com.culturedcode.ThingsMac",
);

/**
 * Find the Things 3 database path.
 * The path contains a variable `ThingsData-XXXXX/` subdirectory.
 */
export function findThingsDbPath(basePath: string): string | null {
  if (!existsSync(basePath)) return null;

  try {
    const entries = readdirSync(basePath).filter((e) => e.startsWith("ThingsData-"));
    for (const entry of entries) {
      const dbPath = join(basePath, entry, "Things Database.thingsdatabase", "main.sqlite");
      if (existsSync(dbPath)) return dbPath;
    }
  } catch {
    // permission denied or other error
  }
  return null;
}

// The cursor type is pinned on `create`'s return rather than as a type
// argument: TypeScript infers every type argument or none, so naming the
// cursor here would default the configuration schema's type and hand `create`
// an untyped bag.
export default defineSource({
  id: "things",
  name: "Things 3",
  description: "Tasks from Things 3 app",
  authType: "local",
  unitName: "tasks",
  contract: {
    // The host resolves the stored cursor against this before `sync` runs,
    // so a value from a build that could not read it never reaches `sync`.
    state: thingsStateSpec,
  },
  singleInstance: true,
  // Each Mac reads its local Things Cloud replica. Task UUIDs and modification
  // timestamps are stable across replicas. Private cursors let replicas make
  // independent progress; the gateway's lease, absence grace period, sibling
  // cursor invalidation, and source-version ordering provide deletion recovery
  // and prevent a lagging Mac from replacing fresher shared state.
  multiDevice: { mode: "replicated", replicaVersionPolicy: "source-updated-at" },
  supportedPlatforms: ["darwin"],
  icon: {
    sfSymbol: "checkmark.circle.fill",
    color: "#4A90D9",
    bgColor: "#15243A",
    url: thingsIconUrl,
  },
  documentTemporalProjections: [
    {
      slot: "scheduled",
      start: "scheduledAt",
      kind: "event",
      modality: "asserted",
      status: THINGS_TEMPORAL_STATUS,
    },
    {
      slot: "due",
      start: "dueAt",
      kind: "deadline",
      modality: "asserted",
      status: THINGS_TEMPORAL_STATUS,
    },
  ],
  config: configSchema.object({
    dbPath: configSchema.path({
      label: "Things database (optional)",
      // Member-scoped: it names a file on one Mac, and a second Mac hosting
      // this source has its own copy in its own container.
      scope: "member",
      provesLocalAvailabilityForAccount: "local",
      placeholder: "Use this Mac's detected Things database",
      // Not `mustExist: "file"`. Blank does not mean "unset" here — it means
      // "find the database this Mac already has", so the check has to run on
      // a blank value and answer a question about a path nobody supplied.
      // That is the one thing a declarative constraint cannot express, which
      // is what this hook exists for.
      checkWhenEmpty: true,
      check(value, probe) {
        const path = value.trim() ? probe.resolve(value) : findThingsDbPath(THINGS_GROUP_CONTAINER);
        if (!path) {
          return "Things database not found on this Mac; open Things or choose its main.sqlite file";
        }
        try {
          return statSync(path).isFile() ? null : "Path must be a file";
        } catch (error) {
          return thingsPathValidationError(error);
        }
      },
    }),
  }),

  async discover() {
    if (process.platform !== "darwin") return [];
    return findThingsDbPath(THINGS_GROUP_CONTAINER) !== null ? ["local"] : [];
  },

  async create({
    sourceId,
    providerId,
    dataCutoff,
    config,
  }): Promise<SourceInstance<ThingsSyncCursor>> {
    // The host resolves a declared path before handing it over, so what
    // arrives here is already absolute and tilde-free.
    const configuredPath = config?.dbPath;
    const dbPath = configuredPath?.trim()
      ? configuredPath
      : findThingsDbPath(THINGS_GROUP_CONTAINER);

    /**
     * Turn an error surfaced while opening or querying the Things database
     * into a typed `SyncError`, or rethrow it unchanged when it matches
     * neither condition this source recognises.
     *
     * A locked database (better-sqlite3's `SQLITE_BUSY`/`SQLITE_LOCKED`)
     * means Things.app itself is mid-write on the one store this source
     * reads — the whole cycle should retry rather than advance its cursor
     * past a read it never completed. A read macOS refuses at the OS level
     * is different: the grant behind it (Full Disk Access) is scoped to the
     * collector's own executable, so nothing short of the operator granting
     * it will change the outcome on a later cycle. Reporting either as an
     * empty success would hide it from every surface an operator might look
     * at.
     */
    function classifyThingsDbError(err: unknown): never {
      if (err instanceof SyncError) throw err;
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
        throw new SyncError(
          "transient",
          "The Things database is locked — Things.app is writing to it. Retrying next cycle.",
          { cause: err },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("authorization denied") || msg.includes("unable to open")) {
        throw new SyncError(
          "permission",
          "Cannot open the Things database — Full Disk Access required.",
          { remediation: fullDiskAccessRemediation(process.execPath) },
        );
      }
      throw err;
    }

    // A missing database (no Things on this Mac) is not a failure — the
    // caller returns an empty page. Anything else `classifyThingsDbError`
    // recognises is thrown as a typed `SyncError` instead.
    function openDb(): Db | null {
      if (!dbPath || !existsSync(dbPath)) return null;
      try {
        // `timeout: 0` turns off better-sqlite3's own busy-retry loop (a
        // default 5000ms per statement) so a lock surfaces as `SQLITE_BUSY`
        // immediately instead of blocking every query of the cycle — the
        // schema probe alone issues five — for up to five seconds each.
        // `classifyThingsDbError` already turns that into a typed retry
        // signal; sitting inside sqlite's own retry loop first would just
        // delay reaching it.
        return new Database(dbPath, { readonly: true, timeout: 0 });
      } catch (err) {
        classifyThingsDbError(err);
      }
    }

    // Cached lookup maps
    let projectTitles = new Map<string, string>();
    let areaTitles = new Map<string, string>();

    // Schema-probe one-shot. The first sync call probes the on-disk
    // schema and emits a single info line summarising what's present;
    // missing required columns log at warn level. Cached so the probe
    // doesn't run every cycle.
    // The probe verdict, not merely the fact that a probe happened. Things
    // hard-deletes with no tombstone, so every cycle publishes a full uuid
    // enumeration — and every query that enumeration is built from is written
    // against the schema this probe checks. A probe that failed and was thrown
    // away is the same defect that let Apple Notes filter on a guessed column:
    // the page query and the enumeration shrink together and agree with each
    // other, so nothing about the result looks wrong.
    let schemaOk: boolean | null = null;

    function buildLookupMaps(db: Db): void {
      try {
        const projects = db.prepare("SELECT uuid, title FROM TMTask WHERE type = 1").all() as {
          uuid: string;
          title: string;
        }[];
        projectTitles = new Map();
        for (const p of projects) {
          if (p.title) projectTitles.set(p.uuid, p.title);
        }
      } catch {
        // ignore
      }

      try {
        const areas = db.prepare("SELECT uuid, title FROM TMArea").all() as RawThingsArea[];
        areaTitles = new Map();
        for (const a of areas) {
          if (a.title) areaTitles.set(a.uuid, a.title);
        }
      } catch {
        // ignore
      }
    }

    return {
      async probeReadAccess(options) {
        if (dbPath) return probeFileReadAccess(dbPath, options);
        const listing = await listReadAccessDirectory(THINGS_GROUP_CONTAINER, options);
        if (listing.status !== "readable") return listing;
        const containers = listing.entries.filter(
          (entry) => entry.isDirectory() && entry.name.startsWith("ThingsData-"),
        );
        if (containers.length !== 1) return { status: "unavailable" };
        return probeFileReadAccess(
          join(
            THINGS_GROUP_CONTAINER,
            containers[0]!.name,
            "Things Database.thingsdatabase",
            "main.sqlite",
          ),
          options,
        );
      },
      watchPaths: dbPath ? [dbPath, `${dbPath}-wal`] : [],

      // Things.app IS the sync engine: it pulls from Things Cloud only while
      // running, with no background helper. Quit it and the SQLite file this
      // source reads freezes, while sync here keeps succeeding against the
      // frozen copy. Nothing is lost — the cursor is a high-water mark on
      // `userModificationDate`, so tasks added elsewhere arrive in full once the
      // app next runs — but until then they are invisible. So the collector
      // reopens it when it finds it quit; Things launches cleanly hidden and
      // needs nothing from the operator once open.
      freshness: {
        quietPeriodMs: THINGS_QUIET_PERIOD_MS,
        requiresProcess: {
          processName: "Things3",
          launch: {
            macosBundleId: "com.culturedcode.ThingsMac",
            failedHint:
              "Omnesis tried to open Things, but it isn't staying open, so it can't pull new tasks from Things Cloud. Open Things yourself and check that it stays running.",
          },
        },
        hint: "Things isn't running on this machine, so it can't pull new tasks from Things Cloud. Open Things to resume syncing.",
      },

      async sync(cursor) {
        const db = openDb();
        if (!db) {
          return syncPage([], cursor ?? { lastModifiedTimestamp: 0 });
        }

        try {
          const lastModified = cursor?.lastModifiedTimestamp ?? 0;
          const isBootstrap = lastModified === 0;

          // Re-probed while it is failing rather than latched once: a Things
          // upgrade mid-session can restore the schema, and a verdict frozen at
          // the first bad read would keep deletion detection off for the life
          // of the process.
          if (schemaOk !== true) {
            schemaOk = probeThingsSchema(db);
            log.info(
              `Things schema probe: assumed=${THINGS_ASSUMED_SCHEMA_VERSION} required-ok=${schemaOk}`,
            );
          }

          /**
           * Build this cycle's snapshot claim over the one Things store.
           *
           * Both emit paths funnel through here so they cannot disagree: the
           * no-change path (which publishes an enumeration even though nothing
           * was read) and the end-of-page path.
           */
          let snapshotIssues: SyncIssue[] | undefined;
          const enumerateSnapshot = (): string[] | undefined => {
            const snapshot = new SnapshotEnumeration(["tasks"]);
            if (schemaOk !== true) {
              snapshot.gap(
                "tasks",
                "the Things schema probe failed, so every query the enumeration is built from " +
                  "is filtering on columns this provider has not verified",
              );
            } else {
              const enumQuery = cutoffUnix
                ? "SELECT uuid FROM TMTask WHERE type IN (0, 1) AND trashed = 0 AND creationDate >= ?"
                : "SELECT uuid FROM TMTask WHERE type IN (0, 1) AND trashed = 0";
              const allRows = (
                cutoffUnix ? db.prepare(enumQuery).all(cutoffUnix) : db.prepare(enumQuery).all()
              ) as { uuid: string }[];
              snapshot.cover(
                "tasks",
                allRows.map((r) => r.uuid),
              );
            }
            const ids = snapshot.result();
            const issue = snapshot.withheldIssue();
            snapshotIssues = issue ? [issue] : [];
            if (ids === undefined) log.warn(snapshot.withheldReason()!);
            return ids;
          };

          buildLookupMaps(db);

          // Compute cutoff as Unix timestamp (seconds) for SQL filtering
          const cutoffUnix = dataCutoff ? Math.floor(new Date(dataCutoff).getTime() / 1000) : null;

          // Count delta queue (rows we'll process this cycle) on first
          // page; pin in cursor for subsequent pages so the progress
          // bar's `total` stays stable. Bootstrap counts everything (the
          // delta from 0 = source-total); incremental counts just rows
          // changed since last cursor.
          let totalTasks: number | undefined = cursor?.cycleQueueTotal;
          if (totalTasks === undefined) {
            try {
              const cutoffPart = cutoffUnix ? " AND creationDate >= ?" : "";
              const countQuery =
                "SELECT COUNT(*) as count FROM TMTask " +
                "WHERE type IN (0, 1) AND trashed = 0 " +
                "AND userModificationDate > ?" +
                cutoffPart;
              const params: number[] = cutoffUnix ? [lastModified, cutoffUnix] : [lastModified];
              const countRow = db.prepare(countQuery).get(...params) as { count: number };
              totalTasks = countRow.count;
            } catch {
              // ignore
            }
          }

          // Fetch tasks modified since cursor (tasks + projects, skip headings)
          const cutoffClause = cutoffUnix ? " AND creationDate >= ?" : "";
          const rows = db
            .prepare(
              `SELECT
                 uuid, title, notes, type, status, trashed,
                 creationDate, userModificationDate,
                 startDate, deadline, stopDate, start,
                 project, area, heading
               FROM TMTask
               WHERE type IN (0, 1)
                 AND userModificationDate > ?${cutoffClause}
               ORDER BY userModificationDate ASC
               LIMIT ?`,
            )
            .all(
              ...(cutoffUnix
                ? [lastModified, cutoffUnix, PAGE_SIZE + 1]
                : [lastModified, PAGE_SIZE + 1]),
            ) as RawThingsTask[];

          const hasMore = rows.length > PAGE_SIZE;
          const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

          if (pageRows.length === 0) {
            // No rows changed since last sync — but we still publish a full
            // uuid enumeration so the gateway can spot deletions (Things
            // hard-deletes don't bump userModificationDate on the deleted row,
            // since the row is gone). This path is the one that matters most
            // for a bad read: it vouches for the whole store having read none
            // of it.
            const presentExternalIds = enumerateSnapshot();
            return syncPage(
              [],
              { lastModifiedTimestamp: lastModified },
              { presentExternalIds, issues: snapshotIssues },
            );
          }

          // Fetch checklist items for all tasks in this page
          const taskUuids = pageRows.map((r) => r.uuid);
          const placeholders = taskUuids.map(() => "?").join(",");
          const checklistRows = db
            .prepare(
              `SELECT uuid, title, status, task, "index"
               FROM TMChecklistItem
               WHERE task IN (${placeholders})
               ORDER BY "index" ASC`,
            )
            .all(...taskUuids) as RawThingsChecklistItem[];

          const checklistMap = new Map<string, RawThingsChecklistItem[]>();
          for (const item of checklistRows) {
            if (!checklistMap.has(item.task)) checklistMap.set(item.task, []);
            checklistMap.get(item.task)!.push(item);
          }

          // Per-task tags via TMTaskTag → TMTag join. Things stores tags
          // as first-class objects; the source previously ignored them so
          // tag-based filtering had nothing to filter on. Bulk-fetch once
          // per page (mirrors the checklist pattern). Wrapped in try/catch
          // so older Things schemas without these tables degrade gracefully.
          const tagsByTask = new Map<string, string[]>();
          try {
            const tagRows = db
              .prepare(
                `SELECT tt.tasks as taskUuid, t.title as title
                 FROM TMTaskTag tt
                 JOIN TMTag t ON t.uuid = tt.tags
                 WHERE tt.tasks IN (${placeholders})
                   AND t.title IS NOT NULL`,
              )
              .all(...taskUuids) as { taskUuid: string; title: string }[];
            for (const r of tagRows) {
              const list = tagsByTask.get(r.taskUuid) ?? [];
              list.push(r.title);
              tagsByTask.set(r.taskUuid, list);
            }
          } catch (err) {
            log.debug(
              `Things tag fetch skipped (schema mismatch?): ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // Build documents
          const documents: DocumentInput[] = [];
          const deletedExternalIds: string[] = [];
          let maxModified = lastModified;

          for (const row of pageRows) {
            if (row.userModificationDate > maxModified) {
              maxModified = row.userModificationDate;
            }

            // Trashed items → deletions
            if (row.trashed) {
              deletedExternalIds.push(row.uuid);
              continue;
            }

            const projectTitle = row.project ? (projectTitles.get(row.project) ?? null) : null;
            const areaTitle = row.area ? (areaTitles.get(row.area) ?? null) : null;
            const checklist = checklistMap.get(row.uuid) ?? [];
            const taskTags = tagsByTask.get(row.uuid) ?? [];

            const doc = normalizeTask(
              row,
              checklist,
              projectTitle,
              areaTitle,
              providerId,
              sourceId,
              taskTags,
            );
            documents.push(doc);
          }

          // Snapshot reconciliation: on the final page of a sync run,
          // emit the full enumeration of currently-present TMTask UUIDs
          // so the gateway diffs against its known set and removes
          // hard-deleted rows. Things 3 hard-deletes on permanent
          // delete with no tombstone — snapshot is the only signal.
          // Skip on partial pages (`hasMore`) to avoid mass-deletion
          // races. Single SELECT, indexed, essentially free.
          let presentExternalIds: string[] | undefined;
          if (!hasMore) presentExternalIds = enumerateSnapshot();

          log.info(
            `Sync produced ${documents.length} docs, -${deletedExternalIds.length} (${isBootstrap ? "bootstrap" : "incremental"}, hasMore: ${hasMore}, snapshot: ${presentExternalIds?.length ?? "skipped"})`,
          );

          // Emit progress on every cycle that has work — bootstrap is
          // just an incremental with a bigger queue. Pin `cycleQueueTotal`
          // in the cursor while paging so `total` stays stable; clear it
          // when the cycle ends so the next cycle re-counts.
          const progress: SyncProgress | undefined =
            totalTasks !== undefined && totalTasks > 0
              ? {
                  phase: isBootstrap ? "bootstrap" : "incremental",
                  processed: documents.length,
                  total: totalTasks,
                }
              : undefined;

          return syncPage(
            documents,
            {
              lastModifiedTimestamp: maxModified,
              cycleQueueTotal: hasMore ? totalTasks : undefined,
            },
            {
              hasMore,
              deletedExternalIds,
              presentExternalIds,
              issues: snapshotIssues,
              progress,
            },
          );
        } catch (err) {
          classifyThingsDbError(err);
        } finally {
          db.close();
        }
      },
    };
  },
});

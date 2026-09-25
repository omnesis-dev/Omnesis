// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The live ontology, assembled from what the install actually declares.
 *
 * The package proves itself against a JSON snapshot in a fixture universe, and
 * that snapshot's format was chosen to be exactly what the gateway holds — so
 * this is the swap the design anticipated: a file becomes a few queries.
 *
 * - **Sources** come from `source_document_profiles`, the table a collector
 *   publishes its `DocumentEventProfile`s into at boot.
 * - **Provider identity** is *not* taken from the profile. A profile is a
 *   source's contract about its own documents; which provider owns the source
 *   is registry metadata, and copying it into the profile would create a second
 *   authority that can drift from the first. It is read from the corpus, which
 *   records the pair on every document it holds.
 * - **Analytics tables** come from the catalog, one read per table, because the
 *   catalog listing omits `semanticTimeColumn` and the validator needs it to
 *   know whether a table can be asked a temporal question at all.
 * - **People** are ids, canonical names and merge targets. Not aliases: a
 *   directory exists so a compiler can turn a name into an id, and the alias
 *   table is the corpus's own record of how a person has been addressed —
 *   copying it into something plans are validated against would put a great
 *   deal of personal data where it does not need to be.
 *
 * The fingerprint covers the declared surface only. A compiled watch records
 * the fingerprint it validated against and the runtime pauses on drift, so what
 * belongs in it is what a watch's *meaning* depends on: a source shipping a new
 * profile, a table gaining or losing a column. Neither people nor provider
 * identity qualify — both are read from the corpus and both would move the
 * fingerprint as it grows, pausing every watch in the install on an ordinary
 * sync.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { sourceTypeOf, trySourceType } from "@omnesis/types";
import {
  ANALYTICS_COLUMN_KEYS,
  canonicalJson,
  declaredSource,
  ontologySnapshotSchema,
} from "@omnesis/watch";
import { listSourceDocumentProfiles } from "../data/repositories/SourceDocumentProfileRepository.js";
import type { PersonDirectoryEntry } from "@omnesis/watch";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { AnalyticsDb } from "../analytics-db.js";
import type { Db } from "../data/types.js";

const log = createLogger("gateway").child("watch-v2:ontology");

/** What a built snapshot carries, in the shape `ontologySnapshotSchema` parses. */
export interface LiveOntologySnapshot {
  readonly fingerprint: string;
  readonly sources: readonly unknown[];
  /** Source ids the corpus holds documents for that publish no profile. */
  readonly unwatchableSources: readonly string[];
  readonly analyticsTables: readonly unknown[];
  readonly people: readonly unknown[];
}

/**
 * The declared half of the ontology, plus what it took to build.
 *
 * `cataloguedTables` is the count before anything was filtered — kept beside the
 * surface rather than inside the snapshot, because it says something about the
 * install rather than about the world a watch may be written against.
 */
interface DeclaredSurface extends Omit<LiveOntologySnapshot, "people" | "unwatchableSources"> {
  readonly cataloguedTables: number;
  /** Every source type the install has, watchable or not. */
  readonly connectedTypes: readonly string[];
}

export interface OntologyDeps {
  readonly db: Db;
  readonly analyticsDb: AnalyticsDb | null;
  /**
   * Which source types are chunked and embedded.
   *
   * A `semantic_match` on a source that is not indexed can never fire, and the
   * validator refuses it rather than accepting a watch that is dead on arrival.
   */
  readonly semanticallyIndexed: (sourceType: string) => boolean;
}

/**
 * Build the snapshot the validator and the engine read.
 *
 * Returned as plain data rather than an indexed `Ontology`: the caller decides
 * when to index it, and a snapshot is also the thing worth fingerprinting and
 * comparing.
 */
export async function buildOntologySnapshot(deps: OntologyDeps): Promise<LiveOntologySnapshot> {
  const declared = await declaredSurface(deps);
  return describable(withPeople(declared, readPeople(deps.db)), declared.connectedTypes);
}

/**
 * The declared surface as a snapshot: its three snapshot fields and the people,
 * and nothing else.
 *
 * Spelled out rather than spread, because the declared surface also carries how
 * many tables the catalog held — a fact about the install, not part of the world
 * a watch is validated against. Spreading it into the snapshot puts a key the
 * schema does not know into the thing whose whole job is to be strictly parsed.
 */
function withPeople(declared: DeclaredSurface, people: readonly unknown[]): LiveOntologySnapshot {
  return {
    fingerprint: declared.fingerprint,
    sources: declared.sources,
    // Provisional: what survives the parse decides which of these are really
    // unwatchable, so `describable` takes the difference again at the end.
    unwatchableSources: unwatchable(declared.connectedTypes, declared.sources),
    analyticsTables: declared.analyticsTables,
    people,
  };
}

/**
 * The connected types no surviving source describes.
 *
 * Taken against whatever `sources` currently holds rather than once at the
 * start, because a source whose profile the schema cannot read is dropped from
 * the ontology — and a source that is connected, indexed and publishing a
 * profile the validator cannot parse is exactly as unwatchable as one
 * publishing none, from the point of view of somebody asking why their watch
 * was refused.
 */
function unwatchable(
  connectedTypes: readonly string[],
  sources: readonly unknown[],
): readonly string[] {
  const described = new Set(sources.map((source) => (source as { sourceId: string }).sourceId));
  return connectedTypes.filter((type) => !described.has(type));
}

/**
 * The half of the ontology that comes from what sources and tables declare.
 *
 * Split out because it is the expensive half — a scan of the corpus for
 * provider ownership and one catalog round trip per analytics table — and the
 * half that only moves when a provider ships a new schema. The person directory
 * is neither, so it is read separately and far more often.
 */
async function declaredSurface(deps: OntologyDeps): Promise<DeclaredSurface> {
  const providers = providerBySourceType(deps.db);

  const sources = listSourceDocumentProfiles(deps.db)
    .map((entry) => ({
      sourceId: entry.sourceType,
      // A source that has produced no documents yet has no recorded provider.
      // Naming it after itself keeps the snapshot well-formed; nothing in the
      // DSL reads `providerId`, and a source with no documents has no events
      // for a watch to be wrong about.
      providerId: providers.get(entry.sourceType) ?? entry.sourceType,
      semanticallyIndexed: deps.semanticallyIndexed(entry.sourceType),
      profile: {
        documentTypes: entry.profile.documentTypes ?? [],
        personRoles: entry.profile.personRoles ?? [],
        metadataFields: entry.profile.metadataFields ?? [],
      },
    }))
    .sort(byString((s) => s.sourceId));

  const catalog = await tableSchemas(deps.analyticsDb);
  const analyticsTables = catalog.schemas.sort(byString((t) => t.tableName));

  // What a watch's meaning depends on, and nothing else. Deliberately not:
  //
  // - **people**, because a new contact is not a change to anyone's promise,
  //   and folding them in would drift the fingerprint on every sync;
  // - **`providerId`**, because it is read from the corpus rather than
  //   declared. It appears the moment a source produces its first document, so
  //   including it would move the fingerprint on a source's first sync and
  //   pause every watch in the install — the same failure as people, arrived at
  //   from a field that looks declarative and is not.
  //
  // What is left is what a source and a table actually promise.
  const declared = {
    sources: sources.map(declaredSource),
    analyticsTables,
  };
  const fingerprint = createHash("sha256")
    .update(canonicalJson(declared))
    .digest("hex")
    .slice(0, 32);

  return {
    fingerprint,
    sources,
    connectedTypes: connectedSourceTypes(deps.db, providers),
    analyticsTables,
    cataloguedTables: catalog.catalogued,
  };
}

/**
 * Every source type this install has, as the install itself records them.
 *
 * The `sources` table is the authority on what is connected, and it is asked
 * first: a source connected five minutes ago, or one whose first sync has not
 * landed, is connected all the same — and it is exactly then that its owner is
 * most likely to ask a watch about it. The corpus is asked too, because a
 * source removed from the table can still have documents until the sweep
 * finishes, and those documents are still searchable.
 *
 * Filtered through `trySourceType`, which is the one line keeping the account
 * half of a `<type>:<account>` id out of everything downstream — a compiler
 * prompt among them. A row whose id is not a well-formed type is dropped
 * rather than carried: it cannot name a real source, and an id the ontology
 * schema then refuses would take the whole assembly down.
 */
function connectedSourceTypes(db: Db, fromCorpus: Map<string, string>): readonly string[] {
  const rows = db.prepare<[], { type: string }>("SELECT DISTINCT type FROM sources").all();
  const types = new Set<string>();
  for (const value of [...rows.map((row) => row.type), ...fromCorpus.keys()]) {
    const type = trySourceType(value);
    if (type !== null) types.add(type);
  }
  return [...types].sort();
}

/** The person directory, as the validator reads it. */
function readPeople(db: Db): readonly unknown[] {
  return db
    .prepare<
      [],
      { id: string; canonical_name: string; is_self: number; merged_into: string | null }
    >("SELECT id, canonical_name, is_self, merged_into FROM people ORDER BY id")
    .all()
    .map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      aliases: [],
      isSelf: row.is_self === 1,
      ...(row.merged_into === null ? {} : { mergedInto: row.merged_into }),
    }));
}

/**
 * The people a compiler is shown, most-connected first and then by id.
 *
 * The whole directory goes into the snapshot, because the validator resolves
 * any person id a watch names. It cannot all go into the *prompt*: this
 * install's directory is fifty thousand people and rendering it produced a
 * prompt of roughly 780,000 tokens, which no model would accept — the request
 * came back as a flat 400 with the size nowhere in it.
 *
 * So the prompt gets a bound, and the bound is ranked rather than arbitrary.
 * `interaction_score_recent` is the corpus's own answer to "who does this
 * person actually deal with", and a watch is written about someone the
 * requester deals with. Self is always in it, ranked or not — the prompt marks
 * that entry as the user and a watch about "me" needs it to exist.
 *
 * Ordered by id in the result so the section is byte-stable between calls: it
 * sits in the prompt's cacheable prefix, and a set that reshuffled on every
 * score refresh would be a prefix no provider could serve from cache.
 */
export const DEFAULT_PROMPT_PEOPLE = 200;

export function promptPeopleDirectory(
  db: Db,
  limit: number = DEFAULT_PROMPT_PEOPLE,
): readonly PersonDirectoryEntry[] {
  return db
    .prepare<[number], { id: string; canonical_name: string; is_self: number }>(
      `SELECT id, canonical_name, is_self
         FROM people
        WHERE merged_into IS NULL
        ORDER BY is_self DESC, COALESCE(interaction_score_recent, 0) DESC, id
        LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      aliases: [],
      isSelf: row.is_self === 1,
      mergedInto: null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * How much of the install's substrate the DSL can actually address.
 *
 * A number first, and a warning second. The fraction is what carries: it rides
 * in `watch2 report`, where whoever is reading the week will see it, and one
 * that is not 1 is a question someone asks. A log line alone is addressed to
 * whoever happens to be reading at the moment it is emitted, which on a healthy
 * install is nobody — while the consequence, that a whole class of watch cannot
 * be written, surfaces much later as an unexplained validation failure. So the
 * line is emitted too, but only when the fraction says something is wrong, and
 * only once per distinct state.
 */
export interface OntologyCoverage {
  readonly tablesDescribed: number;
  readonly tablesTotal: number;
  readonly sourcesDescribed: number;
  readonly sourcesTotal: number;
  /** Column keys passed through unrecognised — the contract may have grown. */
  readonly unknownColumnKeys: readonly string[];
  /** Whether everything the install declares can be addressed by the DSL. */
  readonly complete: boolean;
  /**
   * Whether more of the install is undescribable than has ever been before.
   *
   * The fingerprint cannot answer this. It is hashed over the *declared*
   * surface, before the parse that turns it into the snapshot a watch is
   * validated against, so anything lost in the parse leaves it unchanged. A
   * column schema that cannot read most of the catalog therefore removes most
   * of the DSL surface with the fingerprint identical throughout. Coverage is
   * where that failure is visible, so coverage is where the alarm belongs.
   *
   * The quantity tracked is what the install has and *cannot* describe, not
   * what it can. Those come apart whenever the install itself changes size: a
   * table dropped from the catalog lowers the describable count without
   * anything having been lost, and an alarm on the count alone would call an
   * ordinary removal a regression — which is how an alarm becomes noise and
   * then becomes ignored.
   *
   * The mark it is measured against is this process's, so a fall that happened
   * across a restart reads as incomplete rather than as a fall. `complete` is
   * the half that survives a restart; this is the half that catches a fall in
   * an install that was never complete to begin with.
   */
  readonly regressed: boolean;
}

/**
 * What is wrong with this coverage, said with numbers, or null when nothing is.
 *
 * One function, so the log line and `watch2 report` cannot disagree about when
 * an install is in trouble. Numbers rather than an adjective, because "partly
 * describable" reads as benign however bad the fraction behind it is.
 */
export function coverageAlarm(coverage: OntologyCoverage): string | null {
  // Complete means nothing is missed, and nothing missed cannot be more than
  // has ever been missed — so this one condition covers both alarms.
  if (coverage.complete) return null;
  const parts = [
    `${coverage.tablesDescribed}/${coverage.tablesTotal} analytics table(s)`,
    `${coverage.sourcesDescribed}/${coverage.sourcesTotal} source(s)`,
  ];
  const lead = coverage.regressed ? "ontology coverage fell" : "ontology coverage is not complete";
  return `${lead}: ${parts.join(", ")} describable — watches over the rest cannot be written`;
}

/**
 * The live ontology, reassembled only as often as it actually moves.
 *
 * The runtime evaluates every few seconds and needs an ontology each time.
 * Rebuilding one from scratch at that cadence spends a real slice of the main
 * thread re-deriving something that changes when a provider ships a new schema
 * — which is to say, on a restart. So the two halves are refreshed on
 * different clocks.
 *
 * The **declared** half (source profiles, analytics table schemas, provider
 * ownership) is the expensive one and the slow-moving one, so it is rebuilt on
 * an interval. The **person directory** is neither, and it is re-read every
 * time: a watch naming someone who joined since the last rebuild would
 * otherwise be accepted by the admin route — which builds its own snapshot from
 * scratch — and then paused by the very next evaluation with `PERSON_UNKNOWN`.
 * Person-scoped watches are the flagship case and cannot be the ones that
 * break.
 *
 * Indexing is skipped when neither half has moved, since the same inputs
 * produce the same `Ontology`.
 */

export class LiveOntology {
  private coverageAt: OntologyCoverage | null = null;
  /** The least this process has ever failed to describe, so a fall has a floor. */
  private fewestMissed = { tables: Number.POSITIVE_INFINITY, sources: Number.POSITIVE_INFINITY };
  /** The last alarm said out loud, so a steady problem is stated once. */
  private warned: string | null = null;
  private declared: (DeclaredSurface & { atMs: number }) | null = null;
  private indexed: { key: string; snapshot: LiveOntologySnapshot } | null = null;
  private readonly refreshMs: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: OntologyDeps,
    options: { refreshMs?: number; now?: () => number } = {},
  ) {
    this.refreshMs = options.refreshMs ?? DEFAULT_DECLARED_REFRESH_MS;
    this.now = options.now ?? Date.now;
  }

  async current(): Promise<LiveOntologySnapshot> {
    const at = this.now();
    if (!this.declared || at - this.declared.atMs >= this.refreshMs) {
      this.declared = { ...(await declaredSurface(this.deps)), atMs: at };
    }
    const people = readPeople(this.deps.db);

    // Keyed on the inputs rather than the result: same declared surface, same
    // directory, same ontology — so there is nothing to gain from describing
    // and indexing it again.
    const key = `${this.declared.fingerprint}:${createHash("sha256")
      .update(JSON.stringify(people))
      .digest("hex")
      .slice(0, 32)}`;
    if (this.indexed?.key === key) return this.indexed.snapshot;

    const snapshot = describable(withPeople(this.declared, people), this.declared.connectedTypes);
    const tablesDescribed = snapshot.analyticsTables.length;
    const sourcesDescribed = snapshot.sources.length;
    const missedTables = this.declared.cataloguedTables - tablesDescribed;
    const missedSources = this.declared.sources.length - sourcesDescribed;
    const regressed =
      missedTables > this.fewestMissed.tables || missedSources > this.fewestMissed.sources;
    this.fewestMissed = {
      tables: Math.min(this.fewestMissed.tables, missedTables),
      sources: Math.min(this.fewestMissed.sources, missedSources),
    };
    this.coverageAt = {
      tablesDescribed,
      // The catalog's own count, not the count that survived being read. A
      // table dropped for having no primary key is just as invisible to a watch
      // as one dropped by the parse, and a denominator that excluded it would
      // report full coverage of an install missing most of its tables.
      tablesTotal: this.declared.cataloguedTables,
      sourcesDescribed,
      sourcesTotal: this.declared.sources.length,
      unknownColumnKeys: unknownColumnKeys(this.declared.analyticsTables),
      complete: missedTables === 0 && missedSources === 0,
      regressed,
    };
    // Said once per distinct state rather than once per assembly: an install
    // that is short of full is short of it every minute, and a line repeated
    // every minute is one a reader learns to skip.
    const alarm = coverageAlarm(this.coverageAt);
    if (alarm !== null && alarm !== this.warned) log.warn(alarm);
    this.warned = alarm;
    this.indexed = { key, snapshot };
    return snapshot;
  }

  /**
   * What the last assembly could describe. Null until one has run.
   */
  coverage(): OntologyCoverage | null {
    return this.coverageAt;
  }
}

/**
 * Column keys the snapshot passes through without modelling.
 *
 * Not an error — an unmodelled key is kept, and the table with it. But it is
 * worth counting: it means the source contract has grown a property the
 * validator cannot reason about yet, which is a thing to notice on purpose
 * rather than discover when someone wants to write a watch against it.
 */
function unknownColumnKeys(tables: readonly unknown[]): readonly string[] {
  const known = new Set<string>(ANALYTICS_COLUMN_KEYS);
  const seen = new Set<string>();
  for (const table of tables) {
    const columns = (table as { columns?: readonly Record<string, unknown>[] }).columns ?? [];
    for (const column of columns) {
      for (const key of Object.keys(column)) if (!known.has(key)) seen.add(key);
    }
  }
  return [...seen].sort();
}

/** How often the declared surface is rebuilt. It moves when a provider ships. */
const DEFAULT_DECLARED_REFRESH_MS = 60_000;

/**
 * The largest sub-snapshot this build can describe.
 *
 * A real install is messier than a fixture. Its catalog carries column types
 * the snapshot's closed union does not name; its people table carries rows
 * whose canonical name is empty. Neither should take the whole ontology down: a
 * watch cannot reference a table or a person the snapshot has no shape for, but
 * every *other* watch is still perfectly valid. So the entries that do not
 * describe are dropped and named, and what is left is what a watch may be
 * written against.
 *
 * Zod reports the path of every entry it rejected, so one parse tells us
 * exactly which array elements to drop. Bounded by the number of arrays it can
 * complain about — it converges or it gives up, rather than looping.
 *
 * Dropping *every* source is where that stops being a repair. An empty ontology
 * is a perfectly valid one, so it would be accepted, and every watch in the
 * install would fail its next validation and be paused — durably, with a note
 * about an unknown source, and with no indication that the install had simply
 * failed to describe itself. Better to raise: a runtime that cannot say what it
 * is watching should stop rather than quietly retire the watches.
 */
function describable(
  snapshot: LiveOntologySnapshot,
  connectedTypes: readonly string[],
): LiveOntologySnapshot {
  let current = snapshot;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parsed = ontologySnapshotSchema.safeParse(current);
    if (parsed.success) {
      if (snapshot.sources.length > 0 && current.sources.length === 0) {
        throw new Error(
          `the live ontology described none of its ${snapshot.sources.length} source(s)`,
        );
      }
      return current;
    }

    const dropped = new Map<string, Set<number>>();
    for (const issue of parsed.error.issues) {
      const [collection, index] = issue.path;
      if (typeof collection !== "string" || typeof index !== "number") continue;
      if (!dropped.has(collection)) dropped.set(collection, new Set());
      dropped.get(collection)!.add(index);
    }
    if (dropped.size === 0) {
      // Nothing entry-shaped to drop — the snapshot is wrong in a way this
      // cannot repair, and pretending otherwise would hide it.
      throw new Error(
        `the live ontology could not be assembled: ${parsed.error.issues
          .map((issue) => `${issue.path.join("/")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    for (const [collection, indices] of dropped) {
      log.warn(
        `${indices.size} ${collection} entr${indices.size === 1 ? "y" : "ies"} could not be described and were left out of the ontology`,
      );
    }
    const kept = without(current.sources, dropped.get("sources"));
    current = {
      ...current,
      sources: kept,
      // Recomputed rather than filtered. This list is a *difference*, so
      // dropping a source entry adds to it — and it is the one collection here
      // whose entries the repair loop cannot drop by index without changing
      // what the ontology says about the install.
      unwatchableSources: unwatchable(connectedTypes, kept),
      analyticsTables: without(current.analyticsTables, dropped.get("analyticsTables")),
      people: without(current.people, dropped.get("people")),
    };
  }
  throw new Error(
    "the live ontology could not be assembled after dropping what it could not describe",
  );
}

function without<T>(values: readonly T[], indices: Set<number> | undefined): readonly T[] {
  if (!indices || indices.size === 0) return values;
  return values.filter((_, index) => !indices.has(index));
}

/**
 * Which provider owns which source, as the corpus records it.
 *
 * Every document carries the pair, so the mapping is a fact the install already
 * holds rather than one anything has to be asked for. A source that has synced
 * nothing is simply absent.
 */
function providerBySourceType(db: Db): Map<string, string> {
  const rows = db
    .prepare<
      [],
      { provider_id: string; source_id: string }
    >("SELECT DISTINCT provider_id, source_id FROM documents")
    .all();

  const byType = new Map<string, string>();
  for (const row of rows) {
    // Source ids are `<type>` or `<type>:<account>`; the profile is declared
    // per type, and every account of a type shares its provider.
    const type = sourceTypeOf(row.source_id);
    if (!byType.has(type)) byType.set(type, row.provider_id);
  }
  return byType;
}

/**
 * Every catalogued table's full schema.
 *
 * One read per table rather than one listing, because the listing omits
 * `semanticTimeColumn` — and a table's temporal column is not decoration: it is
 * what decides whether the validator will let a watch ask a windowed question
 * of it. Table counts are in the dozens.
 */
async function tableSchemas(
  analyticsDb: AnalyticsDb | null,
): Promise<{ schemas: AnalyticsTableSchema[]; catalogued: number }> {
  if (!analyticsDb) return { schemas: [], catalogued: 0 };
  const catalog = await analyticsDb.getCatalog();
  const schemas: AnalyticsTableSchema[] = [];
  for (const entry of catalog) {
    const full = await analyticsDb.getRecordTableSchema(entry.tableName);
    if (!full) {
      log.warn(`analytics table ${entry.tableName} is catalogued but has no schema — skipped`);
      continue;
    }
    // A real catalog carries tables the snapshot cannot describe: a name that
    // is not snake_case, no primary key, an empty description. Skipping them
    // with a line is the honest response — a watch cannot reference a table the
    // validator has no shape for, and letting one malformed entry throw would
    // take the whole ontology down and pause every watch in the install.
    const candidate = {
      tableName: full.tableName,
      displayName: full.displayName || full.tableName,
      description: entry.description || full.displayName || full.tableName,
      columns: full.columns,
      primaryKey: full.primaryKey,
      semanticTimeColumn: full.semanticTimeColumn,
      ...(full.sourceId ? { sourceId: full.sourceId } : {}),
    };
    if (candidate.columns.length === 0 || candidate.primaryKey.length === 0) {
      log.warn(`analytics table ${full.tableName} has no columns or no primary key — skipped`);
      continue;
    }
    schemas.push(candidate as AnalyticsTableSchema);
  }
  // Both numbers, because they answer different questions. The schemas are what
  // a watch may be written against; `catalogued` is what the install actually
  // holds — and a coverage fraction whose denominator had already been filtered
  // would report full coverage of the tables that survived, which is the shape
  // of statement this metric exists to stop anyone making.
  return { schemas, catalogued: catalog.length };
}

function byString<T>(of: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = of(a);
    const right = of(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

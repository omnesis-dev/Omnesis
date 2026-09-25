// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ontology snapshot — the only shape in which the gateway substrate enters
 * this package.
 *
 * `@omnesis/watch` never imports the gateway. What the validator needs to
 * know about the world (which sources exist, which metadata fields they
 * declare, which person roles their normalizers actually write, what the
 * analytics tables look like, who the people are) arrives as *data*: a JSON
 * file, structurally identical to what `source_document_profiles` and
 * `_analytics_catalog.schema_json` hold in a live install. The integration
 * phase swaps the file for two queries and changes nothing else.
 *
 * The zod schemas below are the boundary guard. `snapshot.test.ts` asserts at
 * the type level that what they parse stays assignable to the source-sdk
 * interfaces, so a drift in the real contract reddens the build here rather
 * than silently letting a snapshot describe a world that cannot exist.
 */

import { PERSON_ROLES } from "@omnesis/types";
import { z } from "zod";

/** Dotted path under `metadata` — `tags`, `extra.threadId`. */
const metadataPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    "must be a dotted path under metadata",
  );

const documentMetadataFieldSpecSchema = z
  .object({
    path: metadataPathSchema,
    type: z.enum(["string", "number", "boolean", "string-array"]),
    description: z.string().min(1),
    allowedValues: z.array(z.string()).optional(),
    canonicalValues: z.array(z.string()).optional(),
    valueAliases: z.record(z.string(), z.array(z.string())).optional(),
    identifiesPeople: z.boolean().optional(),
  })
  // Open for the same reason the analytics columns are, and the stakes here are
  // higher: an unrecognised key on a metadata field fails its field, which fails
  // its profile, which drops the whole *source* — and if the new key is one
  // every source declares, every source drops and the ontology refuses to
  // assemble at all. A source contract that grows a field must cost nothing.
  .passthrough();

const documentEventProfileSchema = z
  .object({
    documentTypes: z.array(z.string().min(1)).optional(),
    personRoles: z.array(z.enum(PERSON_ROLES)).optional(),
    metadataFields: z.array(documentMetadataFieldSpecSchema).optional(),
  })
  .passthrough();

/**
 * The closed analytics column-type union, spelled exactly as the source-sdk
 * spells it (`DECIMAL(18,4)` — no space after the comma).
 */
const columnTypeSchema = z.union([
  z.enum([
    "VARCHAR",
    "INTEGER",
    "BIGINT",
    "DOUBLE",
    "FLOAT",
    "BOOLEAN",
    "DATE",
    "TIMESTAMP",
    "TIMESTAMPTZ",
    "INTERVAL",
    "JSON",
    "VARCHAR[]",
  ]),
  z.custom<`DECIMAL(${number},${number})`>(
    (value) => typeof value === "string" && /^DECIMAL\(\d{1,2},\d{1,2}\)$/.test(value),
    { message: "expected a closed analytics column type" },
  ),
]);

/**
 * Whether a string is one of the column types this ontology admits.
 *
 * The union is the only thing standing between a catalog and a type name
 * written into SQL text, and the TypeScript side of it is weaker than it looks:
 * the template literal `DECIMAL(${number},${number})` is satisfied at compile
 * time by `DECIMAL(1e3,-1)`. This runs the same runtime check the parser does,
 * so a caller about to interpolate a type can say so at the point it does it
 * rather than inheriting the guarantee from three packages away.
 */
export function isAnalyticsColumnType(value: string): boolean {
  return columnTypeSchema.safeParse(value).success;
}

/**
 * A column as the analytics catalog writes it.
 *
 * Every key here is one the source contract (`ColumnDefinition` in the
 * source-sdk) really declares, and each is checked for the type it promises —
 * a `nullable` that arrived as a string is a broken catalog and should say so.
 *
 * What this is deliberately **not** is closed. A column carrying a key this
 * does not know is passed through with a warning, never rejected, because the
 * cost of rejecting is not proportionate: an unknown key fails its column,
 * which fails its table, which removes the table from the DSL surface
 * entirely. A source shipping one new column property would silently delete
 * its whole table from every watch that could be written — which is precisely
 * what happened, to 48 of 52 tables, for one unmodelled `nullable`.
 *
 * The asymmetry is the point. A key this file knows about is worth being
 * strict about, because the validator reasons with it. A key it has never
 * heard of is worth keeping and mentioning, because the validator does not
 * reason with it and dropping a table over it trades a whole capability for a
 * detail nothing reads.
 */
export const analyticsColumnSchema = z
  .object({
    name: z.string().min(1),
    type: columnTypeSchema,
    description: z.string().optional(),
    allowedValues: z.array(z.string()).optional(),
    canonicalValues: z.array(z.string()).optional(),
    /** What the column's value points at — `person` marks a canonical person id. */
    references: z.enum(["document", "person", "source", "url"]).optional(),
    /** Whether the column can be NULL. */
    nullable: z.boolean().optional(),
    /** Credential material: the catalog preview redacts these values. */
    sensitive: z.boolean().optional(),
    /** Bookkeeping rather than meaning — excluded from change comparisons. */
    volatile: z.boolean().optional(),
    /** What a categorical column's values mean — the contract's two roles. */
    categoricalRole: z.enum(["series", "selector"]).optional(),
    /** Spoken aliases for a categorical column's values. */
    valueAliases: z.record(z.string(), z.array(z.string())).optional(),
    /** The upstream field this column was derived from. */
    sourceColumnId: z.string().optional(),
  })
  .passthrough();

/**
 * The column keys this snapshot models.
 *
 * Exported so a host assembling a snapshot can say which keys it passed
 * through unrecognised. A key appearing here that the source contract has
 * dropped, or missing one the contract has added, is drift — and the
 * conformance test in the gateway is what notices.
 */
export const ANALYTICS_COLUMN_KEYS = [
  "name",
  "type",
  "description",
  "allowedValues",
  "canonicalValues",
  "references",
  "nullable",
  "sensitive",
  "volatile",
  "categoricalRole",
  "valueAliases",
  "sourceColumnId",
] as const;

const analyticsTableSchemaSchema = z
  .object({
    tableName: z.string().regex(/^[a-z_][a-z0-9_]*$/, "analytics tables are snake_case"),
    displayName: z.string().min(1),
    description: z.string().min(1),
    columns: z.array(analyticsColumnSchema).min(1),
    primaryKey: z.array(z.string().min(1)).min(1),
    semanticTimeColumn: z.string().min(1).nullable(),
    /** Which source writes the table. */
    sourceId: z.string().min(1).optional(),
  })
  // Open for the same reason its columns are: the contract carries more than
  // the validator reads (a record-display spec, example queries), and a table
  // is far too valuable to lose over a key nothing here consults.
  .passthrough()
  .superRefine((table, ctx) => {
    const columns = new Set(table.columns.map((c) => c.name));
    for (const key of table.primaryKey) {
      if (!columns.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["primaryKey"],
          message: `primary key column '${key}' is not declared on '${table.tableName}'`,
        });
      }
    }
    if (table.semanticTimeColumn !== null && !columns.has(table.semanticTimeColumn)) {
      ctx.addIssue({
        code: "custom",
        path: ["semanticTimeColumn"],
        message: `semanticTimeColumn '${table.semanticTimeColumn}' is not a declared column`,
      });
    }
  });

const sourceOntologySchema = z
  .object({
    /** The real source id a DSL filter names: `gmail`, `whatsapp-messages`, … */
    sourceId: z.string().min(1),
    providerId: z.string().min(1),
    /**
     * Whether documents from this source are chunked and embedded. A
     * `semantic_match` block on a source that is not indexed can never fire, so
     * the validator refuses it rather than compiling a dead watch.
     */
    semanticallyIndexed: z.boolean(),
    profile: documentEventProfileSchema,
  })
  .passthrough();

const personDirectoryEntrySchema = z
  .object({
    /** The person id as stored: a bare UUID, with no prefix and no branding. */
    id: z.uuid(),
    canonicalName: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    isSelf: z.boolean(),
    /**
     * The canonical id this person was merged into, if any. The runtime
     * re-canonicalizes every person id at comparison time, so a DSL that
     * captured a since-merged id keeps working.
     */
    mergedInto: z.uuid().nullable().default(null),
  })
  .passthrough();

export const ontologySnapshotSchema = z
  .object({
    /**
     * Fingerprint of the ontology surface. A compiled watch stores the
     * fingerprint it was validated against; the runtime pauses on drift rather
     * than silently misfiring.
     */
    fingerprint: z.string().min(1),
    sources: z.array(sourceOntologySchema),
    /**
     * Sources the install has and a watch cannot name.
     *
     * They are connected and their documents are in the corpus — searchable,
     * readable, part of everything else the product does — and they publish no
     * document-event profile, so nothing here can say what one of their events
     * looks like. On a real install there are substantially more of these than
     * there are watchable sources.
     *
     * Carried so a refusal can tell the truth. Without them, a source that is
     * present and unwatchable and a source that does not exist are the same
     * absence, and the two answers owed could not be further apart: connect
     * something, versus the thing is already connected and cannot be watched
     * yet. Deliberately outside the fingerprint — this list grows when an
     * operator adds any source at all, and nothing validated against it.
     */
    unwatchableSources: z.array(z.string().min(1)).default([]),
    analyticsTables: z.array(analyticsTableSchemaSchema),
    people: z.array(personDirectoryEntrySchema),
  })
  // Open at the envelope too, and this one has the widest blast radius of all.
  // An unrecognised key here produces an issue with an empty path, which the
  // host's repair loop cannot attribute to any entry — so instead of dropping
  // one row it refuses to assemble the ontology at all, and every watch in the
  // install stops. One additive field on the snapshot envelope is not worth
  // that.
  .passthrough()
  .superRefine((snapshot, ctx) => {
    reportDuplicates(
      snapshot.sources.map((s) => s.sourceId),
      "sources",
      "source id",
      ctx,
    );
    reportDuplicates(
      snapshot.analyticsTables.map((t) => t.tableName),
      "analyticsTables",
      "analytics table",
      ctx,
    );
    reportDuplicates(
      snapshot.people.map((p) => p.id),
      "people",
      "person id",
      ctx,
    );
  });

function reportDuplicates(
  values: readonly string[],
  path: string,
  what: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", path: [path], message: `duplicate ${what} '${value}'` });
    }
    seen.add(value);
  }
}

export type DocumentMetadataFieldSpecSnapshot = z.infer<typeof documentMetadataFieldSpecSchema>;
export type DocumentEventProfileSnapshot = z.infer<typeof documentEventProfileSchema>;
export type AnalyticsTableSnapshot = z.infer<typeof analyticsTableSchemaSchema>;
export type SourceOntology = z.infer<typeof sourceOntologySchema>;
export type PersonDirectoryEntry = z.infer<typeof personDirectoryEntrySchema>;
export type OntologySnapshot = z.infer<typeof ontologySnapshotSchema>;

/**
 * Every question a validation asks of an ontology.
 *
 * Stated as an interface and taken by the validator in place of the class, so
 * that what a validation's answer *rests on* is a closed list rather than
 * whatever happens to be reachable from an `Ontology`. That is what makes the
 * dependency recordable: `RecordingOntology` implements this and nothing else,
 * so the slice it records is the whole slice the answer rests on. A check
 * reaching past this — into `snapshot` — would consult bytes no recording
 * could see, and a caller comparing those bytes across two ontologies would be
 * comparing less than it believes.
 *
 * `fingerprint` is here because `graph.ts` compares against it, and is the one
 * read a recording deliberately does not keep: it is a hash of the entire
 * surface, and the question the recording exists to answer is the one the
 * fingerprint cannot.
 */
export interface OntologyReads {
  readonly fingerprint: string;
  source(sourceId: string): SourceOntology | undefined;
  sourceIds(): string[];
  unwatchable(sourceId: string): boolean;
  table(tableName: string): AnalyticsTableSnapshot | undefined;
  tableNames(): string[];
  person(personId: string): PersonDirectoryEntry | undefined;
  canonicalPersonId(personId: string): string | undefined;
  metadataField(sourceId: string, path: string): DocumentMetadataFieldSpecSnapshot | undefined;
}

/**
 * Indexed view of a snapshot. The validator does thousands of lookups against
 * one snapshot; building the maps once keeps it linear.
 */
export class Ontology implements OntologyReads {
  private readonly sourcesById: ReadonlyMap<string, SourceOntology>;
  private readonly tablesByName: ReadonlyMap<string, AnalyticsTableSnapshot>;
  private readonly peopleById: ReadonlyMap<string, PersonDirectoryEntry>;
  private readonly unwatchableIds: ReadonlySet<string>;

  constructor(readonly snapshot: OntologySnapshot) {
    this.unwatchableIds = new Set(snapshot.unwatchableSources);
    this.sourcesById = new Map(snapshot.sources.map((s) => [s.sourceId, s]));
    this.tablesByName = new Map(snapshot.analyticsTables.map((t) => [t.tableName, t]));
    this.peopleById = new Map(snapshot.people.map((p) => [p.id, p]));
  }

  static parse(raw: unknown): Ontology {
    return new Ontology(ontologySnapshotSchema.parse(raw));
  }

  get fingerprint(): string {
    return this.snapshot.fingerprint;
  }

  source(sourceId: string): SourceOntology | undefined {
    return this.sourcesById.get(sourceId);
  }

  sourceIds(): string[] {
    return [...this.sourcesById.keys()];
  }

  /**
   * Whether this install has this source and a watch still cannot name it.
   *
   * Asked only once `source()` has come back empty, and it turns one absence
   * into two answers: nothing by that name, or something by that name that
   * publishes no document-event profile.
   */
  unwatchable(sourceId: string): boolean {
    return this.unwatchableIds.has(sourceId);
  }

  table(tableName: string): AnalyticsTableSnapshot | undefined {
    return this.tablesByName.get(tableName);
  }

  tableNames(): string[] {
    return [...this.tablesByName.keys()];
  }

  person(personId: string): PersonDirectoryEntry | undefined {
    return this.peopleById.get(personId);
  }

  /**
   * Follow the merge chain to the surviving person. Bounded at ten hops — far
   * past any real chain — so a cyclic one degrades to "unresolved" instead of
   * hanging.
   */
  canonicalPersonId(personId: string): string | undefined {
    let cursor = this.peopleById.get(personId);
    if (!cursor) return undefined;

    for (let hop = 0; hop < 10 && cursor.mergedInto !== null; hop++) {
      const next = this.peopleById.get(cursor.mergedInto);
      if (!next) return undefined;
      cursor = next;
    }
    return cursor.mergedInto === null ? cursor.id : undefined;
  }

  /** The metadata field a source declares at `path`, if it declares one. */
  metadataField(sourceId: string, path: string): DocumentMetadataFieldSpecSnapshot | undefined {
    return this.source(sourceId)?.profile.metadataFields?.find((f) => f.path === path);
  }
}

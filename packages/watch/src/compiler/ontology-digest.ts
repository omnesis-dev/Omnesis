// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ontology, written out for a model to read.
 *
 * The validator consumes the snapshot as data; a compiler has to be *told* what
 * exists before it can write a plan that references it. This renders the same
 * snapshot as compact text: which sources exist and which of them are
 * semantically indexed, the metadata paths and person roles each one declares,
 * every analytics table with its columns and types, the people directory, and
 * the open loops that can be bound by id.
 *
 * Two properties matter more than brevity. It must be **complete** — a field
 * the digest omits is a field the compiler will invent a name for, and the
 * validator will reject the invention with a diagnostic that reads as the
 * model's fault. And it must be **deterministic**: the digest sits in the
 * prompt's static prefix, and a prefix that varies between calls is a prefix no
 * provider can serve from cache.
 */

import {
  ANALYTICS_ROW_FIELDS,
  DOC_EVENT_FIELDS,
  LOOP_EVENT_FIELDS,
  LOOP_SNAPSHOT_FIELDS,
  PERSON_MENTION_FIELDS,
  TIMER_EVENT_FIELDS,
} from "../validator/node-output.js";
import type {
  AnalyticsTableSnapshot,
  Ontology,
  PersonDirectoryEntry,
  SourceOntology,
} from "../ontology/snapshot.js";
import type { EventDirectoryEntry } from "./events.js";
import type { LoopDirectoryEntry } from "./loops.js";

/** Render the ontology and loop directory as the prompt's world description. */
export function ontologyDigest(
  ontology: Ontology,
  loops: readonly LoopDirectoryEntry[],
  events: readonly EventDirectoryEntry[] = [],
  people: readonly PersonDirectoryEntry[] = ontology.snapshot.people,
): string {
  return [
    `ONTOLOGY FINGERPRINT: ${ontology.fingerprint}`,
    "",
    "## Document sources",
    ...sortedSources(ontology).map(describeSource),
    ...describeUnwatchable(ontology),
    "",
    "## Analytics tables (DuckDB — the only thing SQL nodes may query)",
    ...sortedTables(ontology).map(describeTable),
    "",
    "## People directory",
    ...describePeople(people),
    "",
    "## Open loops",
    ...describeLoops(loops),
    "",
    ...(events.length === 0 ? [] : datedSection(events)),

    "",
    "## Event fields — what `$e.` can read on each source node",
    ...describeEventFields(),
  ].join("\n");
}

function sortedSources(ontology: Ontology): SourceOntology[] {
  return ontology
    .sourceIds()
    .sort()
    .map((id) => ontology.source(id)!);
}

/**
 * The sources this install has that no watch can name.
 *
 * Shown because leaving them out makes the compiler wrong in a specific and
 * unhelpful way: a request about one of them looks, from the section above,
 * exactly like a request about a source the operator has never connected — and
 * the compiler says so, sending them to set up something they are already
 * running. Naming them lets the refusal be true, and gives it its own code.
 */
function describeUnwatchable(ontology: Ontology): string[] {
  const unwatchable = ontology.snapshot.unwatchableSources;
  if (unwatchable.length === 0) return [];
  return [
    "",
    "These sources are connected and indexed here and publish no document-event",
    "profile, so no source node may name them. Refuse a request about one of them",
    "— and say in your reasons that the source is already connected and cannot be",
    "watched yet. Never suggest connecting something that is already connected:",
    ...[...unwatchable].sort().map((id) => `- ${id}`),
  ];
}

function sortedTables(ontology: Ontology): AnalyticsTableSnapshot[] {
  return ontology
    .tableNames()
    .sort()
    .map((name) => ontology.table(name)!);
}

function describeSource(source: SourceOntology): string {
  const lines = [
    `- ${source.sourceId} (provider ${source.providerId})` +
      (source.semanticallyIndexed
        ? " — semantically indexed, so a recall block can nominate from it"
        : " — NOT indexed, so nothing on it is ever nominated"),
  ];

  const types = source.profile.documentTypes ?? [];
  lines.push(`    documentType: ${types.length > 0 ? types.join(", ") : "(none declared)"}`);

  const roles = source.profile.personRoles ?? [];
  lines.push(`    person roles: ${roles.length > 0 ? roles.join(", ") : "(none declared)"}`);

  for (const field of source.profile.metadataFields ?? []) {
    // A field whose values name people singles a human out exactly as a person
    // role does, and only the source knows which of its fields do. Marked here
    // so the compiler weighs a filter on it as the identity condition it is.
    const identity = field.identifiesPeople ? " (its values name a person)" : "";
    lines.push(
      `    metadata.${field.path}: ${field.type}${identity} — ${field.description}${describeVocabulary(field)}`,
    );
  }
  return lines.join("\n");
}

function describeTable(table: AnalyticsTableSnapshot): string {
  const lines = [
    `- ${table.tableName} — ${table.description}`,
    `    primary key: ${table.primaryKey.join(", ")}`,
    `    semantic time column: ${table.semanticTimeColumn ?? "(timeless)"}`,
  ];
  for (const column of table.columns) {
    const references = column.references ? ` references ${column.references}` : "";
    const description = column.description ? ` — ${column.description}` : "";
    lines.push(
      `    ${column.name} ${column.type}${references}${description}${describeVocabulary(column)}`,
    );
  }
  return lines.join("\n");
}

/**
 * A vocabulary as the compiler needs to read it: which values may be written,
 * and which spoken phrasings mean each one.
 *
 * The value list answers "what may I write here". The aliases answer "what did
 * the request just call it" — they are the source's own mapping from human
 * phrasing onto an exact wire value, and without them a phrase like "merge
 * request" has to be guessed against a bare list of values it does not
 * resemble.
 */
function describeVocabulary(field: {
  allowedValues?: readonly string[];
  canonicalValues?: readonly string[];
  valueAliases?: Readonly<Record<string, readonly string[]>>;
}): string {
  const values = field.allowedValues
    ? ` closed values: ${field.allowedValues.join(" | ")}`
    : field.canonicalValues
      ? ` canonical values: ${field.canonicalValues.join(" | ")}`
      : "";
  // Sorted, because the digest is the cached head of every compile prompt and
  // a prefix that varies between calls is a prefix no provider serves from
  // cache. Object key order is not a guarantee worth resting that on.
  const spoken = Object.entries(field.valueAliases ?? {})
    .filter(([, aliases]) => aliases.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([value, aliases]) => `${aliases.map((a) => `"${a}"`).join(", ")} → ${value}`);
  if (spoken.length === 0) return values;
  return `${values}${values === "" ? "" : " —"} spoken as: ${spoken.join("; ")}`;
}

function describePeople(people: readonly PersonDirectoryEntry[]): string[] {
  return [...people]
    .filter((person) => person.mergedInto === null)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((person) => {
      const aliases = person.aliases.length > 0 ? ` (also: ${person.aliases.join(", ")})` : "";
      const self = person.isSelf ? " — THE USER" : "";
      return `- ${person.id} ${person.canonicalName}${aliases}${self}`;
    });
}

/**
 * The section, present only when there is a directory to resolve against.
 *
 * Emitted unconditionally it would tell a compiler to resolve dated referents
 * "here" and to refuse when it cannot — against an empty list, which reads as
 * an instruction to refuse every request that names a specific occasion.
 */
function datedSection(events: readonly EventDirectoryEntry[]): string[] {
  return [
    "## Dated things a request can point at",
    "",

    "A request naming one specific occasion rather than a kind of occasion is pointing at one",
    "of these. Resolve it here and freeze what you resolved into `constants` with its",
    "provenance, so the person approving the watch can see which one you meant. If the",
    "request could mean more than one and nothing settles which, say so and refuse rather",
    "than picking — the people on an occasion are usually what settles it. A watch bound to",
    "one of these has a horizon: give it an `expires_at`.",
    "",
    ...describeEvents(events),
  ];
}

function describeEvents(events: readonly EventDirectoryEntry[]): string[] {
  return events.map(
    (event) =>
      `- ${event.eventId} "${event.title}" — starts ${event.startsAt}` +
      (event.endsAt ? `, ends ${event.endsAt}` : "") +
      (event.people.length > 0 ? `, with ${event.people.join(", ")}` : ""),
  );
}

function describeLoops(loops: readonly LoopDirectoryEntry[]): string[] {
  if (loops.length === 0) return ["(none)"];
  return loops.map((loop) => `- ${loop.loopId} "${loop.title}" — state ${loop.state}`);
}

/**
 * The field names behind every `$e.` reference.
 *
 * A closed vocabulary the validator checks and neither the ontology snapshot
 * nor the generated schema carries: expressions are strings to a JSON Schema,
 * and the payload shapes live in the validator. Without them the model can only
 * infer the names from the worked examples — and withholding examples is
 * exactly what an honest measurement does, so the vocabulary would thin out
 * precisely when it is being tested.
 */
function describeEventFields(): string[] {
  const names = (fields: Record<string, unknown>) => Object.keys(fields).sort().join(", ");
  return [
    `- source.document_event — $e.${names(DOC_EVENT_FIELDS).replaceAll(", ", ", $e.")}`,
    `    each entry of $e.people has: ${names(PERSON_MENTION_FIELDS)}`,
    `    $e.metadata holds the declared paths listed for that source above`,
    `- source.analytics_row — $e.${names(ANALYTICS_ROW_FIELDS).replaceAll(", ", ", $e.")}`,
    `    $e.row holds that table's columns, so $e.row.<column>`,
    `- source.open_loop — $e.${names(LOOP_EVENT_FIELDS).replaceAll(", ", ", $e.")}`,
    `    $e.before and $e.after each hold: ${names(LOOP_SNAPSHOT_FIELDS)}`,
    `- source.time — $e.${names(TIMER_EVENT_FIELDS).replaceAll(", ", ", $e.")}`,
  ];
}

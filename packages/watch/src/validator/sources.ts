// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Checking a trip-wire against the world it claims to watch.
 *
 * Source nodes are where a watch meets the ontology: a source id that must
 * exist, a document type and metadata fields the source must actually declare,
 * person roles its normalizer really writes, an analytics table in the catalog,
 * a schedule that parses. Everything here answers the same question in a
 * different shape — can this condition ever match anything? — because a filter
 * that cannot is not a watch, it is a watch that will never fire and never say
 * why.
 */

import { parseValueType } from "../dsl/value-type.js";
import { parseCron } from "../time/cron.js";
import { normalizeForMatch } from "../runtime/lexical.js";
import { analyzeSql } from "./sql.js";
import { sourceIdsOf, type ValidationContext } from "./context.js";
import type { WatchNode } from "../dsl/schema.js";
import type { SourceOntology } from "../ontology/snapshot.js";

/**
 * A recall query whose discriminating power is an identifier cannot be served
 * by the embedding path: identifiers carry no semantic neighbourhood, so
 * nearest-neighbour retrieval on them returns unrelated text. Matches tokens
 * shaped like `XR-4471` or `INV0093`. A bare number is deliberately not one:
 * a query mentioning a year or a quantity is ordinary prose.
 *
 * The character classes are disjoint and the quantifiers cannot overlap, so
 * matching is linear in the token length. A pattern that can backtrack here is
 * a denial-of-service on a field written by a model.
 */
const IDENTIFIER_TOKEN = /^[A-Za-z]{1,6}[-_]?[0-9]{2,}[A-Za-z0-9-]*$/;

/** Tokens longer than this are not identifiers anyone types; skip them. */
const MAX_IDENTIFIER_TOKEN_LENGTH = 64;

/**
 * Where a literal term stops being distinctive.
 *
 * Refused above the first, flagged above the second. The numbers are round
 * because the shape of the curve is what matters, not its exact knee: a term in
 * one document per two hundred costs nothing, a term in one per five costs a
 * judgement on every fifth document that arrives.
 */
const FLOOD_PRONE_SHARE = 0.2;
const NOTABLE_SHARE = 0.05;

/**
 * ISO-8601 with an explicit zone. `Date.parse` is deliberately not the check:
 * the spec leaves non-ISO input implementation-defined, so it accepts
 * `"March 5, 2026"`, rolls `"2026-02-30"` over into March, and reads a
 * zone-less string as host-local time — none of which the message claims.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoInstant(text: string): boolean {
  if (!ISO_INSTANT.test(text)) return false;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return false;
  // A syntactically fine `2026-02-30T00:00:00Z` rolls over; reject the roll.
  return new Date(parsed).toISOString().slice(0, 10) === text.slice(0, 10);
}

export class SourceChecker {
  constructor(private readonly ctx: ValidationContext) {}

  /**
   * The union of a set of sources' declarations for one profile facet, or
   * `null` when none of them declares that facet at all. A source that declares
   * nothing keeps working — its documents simply cannot be addressed by
   * anything more specific than the fields every document has — so "nobody
   * declared" must not read as "nothing is allowed".
   */
  declaredAcrossSources(
    sourceIds: readonly string[],
    pick: (source: SourceOntology) => readonly string[] | undefined,
  ): Set<string> | null {
    let declared: Set<string> | null = null;
    for (const sourceId of sourceIds) {
      const source = this.ctx.ontology.source(sourceId);
      if (!source) continue;
      const values = pick(source);
      if (values === undefined) continue;
      declared ??= new Set<string>();
      for (const value of values) declared.add(value);
    }
    return declared;
  }

  checkDocumentEventSource(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    path: string,
  ): void {
    const sourceIds = sourceIdsOf(node);

    for (const [i, sourceId] of sourceIds.entries()) {
      if (this.ctx.ontology.source(sourceId)) continue;
      const where =
        typeof node.filter.source === "string"
          ? `${path}/filter/source`
          : `${path}/filter/source/${i}`;
      // Two absences, and the answers owed could not be further apart. A
      // source nothing knows about wants a connector. One the install already
      // has, whose documents are already searchable, wants nothing added at
      // all — it publishes no document-event profile, so there is no event
      // shape for a watch to name, and telling its owner to go and connect it
      // sends them looking for something they are already running.
      if (this.ctx.ontology.unwatchable(sourceId)) {
        this.ctx.diag.error(
          "SOURCE_NOT_WATCHABLE",
          where,
          `Source '${sourceId}' is connected and indexed, but publishes no document-event profile, so nothing can watch its events.`,
          { sourceId, known: this.ctx.ontology.sourceIds() },
        );
        continue;
      }
      this.ctx.diag.error("SOURCE_UNKNOWN", where, `No source '${sourceId}' in the ontology.`, {
        sourceId,
        known: this.ctx.ontology.sourceIds(),
      });
    }

    node.filter.event.forEach((op, i) => {
      if (op !== "deleted") return;
      this.ctx.diag.error(
        "EVENT_OP_UNSUPPORTED",
        `${path}/filter/event/${i}`,
        `Nothing in the substrate emits a document deletion, so a 'deleted' filter can never fire. The spelling is reserved for when it does.`,
        { op },
      );
    });

    const declaredTypes = this.declaredAcrossSources(sourceIds, (s) => s.profile.documentTypes);
    if (node.filter.documentType !== undefined && declaredTypes !== null) {
      const wanted =
        typeof node.filter.documentType === "string"
          ? [node.filter.documentType]
          : node.filter.documentType;
      for (const [i, type] of wanted.entries()) {
        if (declaredTypes.has(type)) continue;
        this.ctx.diag.error(
          "DOCUMENT_TYPE_UNDECLARED",
          typeof node.filter.documentType === "string"
            ? `${path}/filter/documentType`
            : `${path}/filter/documentType/${i}`,
          `None of ${sourceIds.join(", ")} declares a '${type}' document type.`,
          { documentType: type, declared: [...declaredTypes] },
        );
      }
    }

    (node.filter.metadata ?? []).forEach((predicate, i) => {
      this.checkMetadataPredicate(sourceIds, predicate, `${path}/filter/metadata/${i}`);
    });

    (node.filter.people ?? []).forEach((predicate, i) => {
      const predicatePath = `${path}/filter/people/${i}`;
      for (const sourceId of sourceIds) {
        const source = this.ctx.ontology.source(sourceId);
        if (!source) continue;
        const roles = source.profile.personRoles ?? [];
        if (roles.includes(predicate.role)) continue;
        this.ctx.diag.error(
          "PERSON_ROLE_UNDECLARED",
          `${predicatePath}/role`,
          `'${sourceId}' never writes a '${predicate.role}' mention, so this condition can never match.`,
          { sourceId, role: predicate.role, declared: roles },
        );
      }
      if (predicate.person !== undefined) {
        this.checkPersonReference(predicate.person, `${predicatePath}/person`);
      }
      if (predicate.person === undefined && predicate.isSelf === undefined) {
        this.ctx.diag.error(
          "PERSON_PREDICATE_UNBOUND",
          predicatePath,
          `A person predicate must name a person or an isSelf stance; a bare role matches every document.`,
          { role: predicate.role },
        );
      }
    });

    if (node.recall) {
      this.checkRecall(node, sourceIds, path);
    }
  }

  checkRecall(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    sourceIds: readonly string[],
    path: string,
  ): void {
    const recall = node.recall!;

    // Nomination happens on the semantic clock whichever arm speaks, so a
    // source that is never indexed never nominates — the lexical arm reads
    // content at that tick and there is no tick.
    for (const sourceId of sourceIds) {
      const source = this.ctx.ontology.source(sourceId);
      if (!source || source.semanticallyIndexed) continue;
      this.ctx.diag.error(
        "RECALL_SOURCE_NOT_INDEXED",
        `${path}/recall`,
        `'${sourceId}' produces no embeddings, so nothing on it is ever nominated.`,
        { sourceId },
      );
    }

    if (recall.semantic) {
      const identifierish = recall.semantic.query
        .split(/\s+/)
        .filter(
          (token) =>
            token.length > 0 &&
            token.length <= MAX_IDENTIFIER_TOKEN_LENGTH &&
            IDENTIFIER_TOKEN.test(token),
        );
      if (identifierish.length > 0) {
        this.ctx.diag.error(
          "SEMANTIC_ARM_IDENTIFIER_QUERY",
          `${path}/recall/semantic/query`,
          `Embeddings cannot retrieve on identifiers (${identifierish.join(", ")}). Put them in a lexical arm, which matches them literally, and leave the semantic query for the meaning.`,
          { tokens: identifierish },
        );
      }
    }

    if (recall.lexical) this.checkLexicalArm(recall.lexical, path);
    if (node.judge) this.checkJudge(node.judge, path);
  }

  /**
   * Whether a literal term is distinctive enough to be worth nominating on.
   *
   * A rare term is cheap by construction: it almost never matches, so the judge
   * almost never wakes. A common one is the opposite — "invoice" would nominate
   * a large share of a mailbox and put every one of them in front of a model.
   * The rarity question therefore moves to compile time, answered by counting
   * documents rather than by scoring, and the backtest's reach count stays the
   * empirical guardrail behind it.
   */
  checkLexicalArm(
    lexical: { readonly terms: readonly string[]; readonly match: "token" | "phrase" },
    path: string,
  ): void {
    for (const [index, term] of lexical.terms.entries()) {
      const termPath = `${path}/recall/lexical/terms/${index}`;
      if (normalizeForMatch(term).trim().length === 0) {
        this.ctx.diag.error(
          "LEXICAL_TERM_EMPTY",
          termPath,
          `'${term}' is punctuation only: it normalizes to nothing, so it can never match a document.`,
          { term },
        );
        continue;
      }
      // Whitespace as written, not after normalization. An order number is one
      // token to anyone reading it, and normalization splits `XR-4471` on the
      // hyphen — rejecting it would refuse the exact case the lexical arm
      // exists for. What makes a term a phrase is a space the author typed.
      if (lexical.match === "token" && /\s/.test(term.trim())) {
        this.ctx.diag.error(
          "LEXICAL_TERM_NOT_A_TOKEN",
          termPath,
          `'${term}' is several words but is asked for as a token. Use match 'phrase', or split it into separate terms.`,
          { term },
        );
      }

      const frequency = this.ctx.docFrequency?.frequency(term);
      if (!frequency || frequency.corpus === 0) continue;
      const share = frequency.documents / frequency.corpus;
      if (share > FLOOD_PRONE_SHARE) {
        this.ctx.diag.error(
          "LEXICAL_TERM_FLOOD_PRONE",
          termPath,
          `'${term}' appears in ${frequency.documents} of ${frequency.corpus} documents (${Math.round(share * 100)}%). A term that common nominates most of the corpus and wakes the judge on all of it; a lexical arm is for terms that are rare enough to be nearly free.`,
          { term, documents: frequency.documents, corpus: frequency.corpus },
        );
      } else if (share > NOTABLE_SHARE) {
        this.ctx.diag.warn(
          "LEXICAL_TERM_COMMON",
          termPath,
          `'${term}' appears in ${frequency.documents} of ${frequency.corpus} documents. That is common enough to be worth a second look at the backtest's reach count.`,
          { term, documents: frequency.documents, corpus: frequency.corpus },
        );
      }
    }
  }

  /**
   * The judge's declared output.
   *
   * An empty `output_schema` is legitimate: a judge's verdict is the firing
   * signal itself, and the schema declares only the extra payload a watch wants
   * carried forward. A judge asked merely "did this happen" declares nothing.
   */
  checkJudge(
    judge: { readonly output_schema: Readonly<Record<string, string>> },
    path: string,
  ): void {
    for (const [field, type] of Object.entries(judge.output_schema)) {
      if (parseValueType(type) !== null) continue;
      this.ctx.diag.error(
        "TYPE_EXPRESSION_INVALID",
        `${path}/judge/output_schema/${field}`,
        `'${type}' is not a DSL type.`,
        { field, value: type },
      );
    }
  }

  checkMetadataPredicate(
    sourceIds: readonly string[],
    predicate: { path: string; op: string; value?: unknown },
    path: string,
  ): void {
    for (const sourceId of sourceIds) {
      const source = this.ctx.ontology.source(sourceId);
      if (!source) continue;

      const field = this.ctx.ontology.metadataField(sourceId, predicate.path);
      if (!field) {
        this.ctx.diag.error(
          "METADATA_FIELD_UNDECLARED",
          `${path}/path`,
          `'${sourceId}' does not declare a metadata field '${predicate.path}'.`,
          {
            sourceId,
            path: predicate.path,
            declared: (source.profile.metadataFields ?? []).map((f) => f.path),
          },
        );
        continue;
      }

      if (!metadataValueTypeMatches(field.type, predicate)) {
        this.ctx.diag.error(
          "METADATA_PREDICATE_VALUE_INVALID",
          `${path}/value`,
          `'${sourceId}' declares '${predicate.path}' as ${field.type}; this predicate compares it against ${JSON.stringify(predicate.value)}.`,
          { sourceId, path: predicate.path, declaredType: field.type, value: predicate.value },
        );
        continue;
      }

      const values = metadataPredicateValues(predicate);
      if (values === null) {
        this.ctx.diag.error(
          "METADATA_PREDICATE_VALUE_INVALID",
          path,
          `Operator '${predicate.op}' does not fit the value it was given.`,
          { op: predicate.op },
        );
        continue;
      }

      for (const value of values) {
        // A value that is really one of the field's declared phrasings is a
        // near miss with an exact answer, so the diagnostic carries it: the
        // repair is to write the value the phrasing means.
        const aliasOf = aliasTarget(field.valueAliases, value);
        const hint = aliasOf === null ? "" : ` It is a phrasing for '${aliasOf}'; write that.`;
        if (field.allowedValues && !field.allowedValues.includes(value)) {
          this.ctx.diag.error(
            "METADATA_VALUE_NOT_ALLOWED",
            `${path}/value`,
            `'${value}' is not one of the values '${sourceId}' writes to '${predicate.path}'.${hint}`,
            {
              sourceId,
              value,
              allowedValues: field.allowedValues,
              ...(aliasOf !== null ? { aliasOf } : {}),
            },
          );
        } else if (field.canonicalValues && !field.canonicalValues.includes(value)) {
          this.ctx.diag.warn(
            "LINT_METADATA_VALUE_NONCANONICAL",
            `${path}/value`,
            `'${value}' is not a known value of '${predicate.path}' — the field is open, so this may still match, or may be a typo.${hint}`,
            {
              sourceId,
              value,
              canonicalValues: field.canonicalValues,
              ...(aliasOf !== null ? { aliasOf } : {}),
            },
          );
        }
      }
    }
  }

  checkPersonReference(personId: string, path: string): void {
    const person = this.ctx.ontology.person(personId);
    if (!person) {
      this.ctx.diag.error(
        "PERSON_UNKNOWN",
        path,
        `No person '${personId}' in the directory. A DSL carries stored person ids, never names.`,
        { personId },
      );
      return;
    }
    if (person.mergedInto !== null) {
      this.ctx.diag.warn(
        "PERSON_NOT_CANONICAL",
        path,
        `Person '${personId}' has been merged into '${person.mergedInto}'. The runtime re-canonicalizes at comparison time, so the watch still works; recompiling makes the DSL say what it means.`,
        { personId, canonical: this.ctx.ontology.canonicalPersonId(personId) ?? null },
      );
    }
  }

  checkAnalyticsRowSource(
    node: Extract<WatchNode, { type: "source.analytics_row" }>,
    path: string,
  ): void {
    if (!this.ctx.ontology.table(node.table)) {
      this.ctx.diag.error(
        "ANALYTICS_TABLE_UNKNOWN",
        `${path}/table`,
        `No analytics table '${node.table}' in the catalog.`,
        { table: node.table, known: this.ctx.ontology.tableNames() },
      );
    }

    if (node.predicate !== undefined) {
      const analysis = analyzeSql(`SELECT (${node.predicate}) AS fires`);

      // The predicate is spliced into a SELECT to lex it, so a predicate that
      // closes the parenthesis and continues would smuggle in a whole query.
      // It has to lex back as exactly the one expression it claims to be.
      if (
        analysis.problem === null &&
        (analysis.hasFrom ||
          analysis.tables.length > 0 ||
          analysis.outputColumns.length !== 1 ||
          analysis.outputColumns[0]?.toLowerCase() !== "fires")
      ) {
        this.ctx.diag.error(
          "SQL_PREDICATE_NOT_AN_EXPRESSION",
          `${path}/predicate`,
          `A row predicate is a single boolean expression over the arriving row's columns — it cannot open a FROM clause or project columns of its own.`,
          { tables: analysis.tables, projected: analysis.outputColumns },
        );
      }

      if (analysis.problem !== null) {
        this.ctx.diag.error(
          "SQL_UNPARSEABLE",
          `${path}/predicate`,
          `Row predicate does not lex as a SQL expression: ${analysis.problem}.`,
          { problem: analysis.problem },
        );
      }
      for (const parameter of analysis.parameters) {
        this.ctx.diag.error(
          "SQL_PARAMETER_UNKNOWN",
          `${path}/predicate`,
          `A row predicate sees only the arriving row's columns; '${parameter.text}' has nothing to bind to here.`,
          { parameter: parameter.text },
        );
      }
    }
  }

  checkOpenLoopSource(node: Extract<WatchNode, { type: "source.open_loop" }>, path: string): void {
    for (const [i, personId] of (node.filter?.actors ?? []).entries()) {
      this.checkPersonReference(personId, `${path}/filter/actors/${i}`);
    }
    for (const [i, personId] of (node.filter?.involved ?? []).entries()) {
      this.checkPersonReference(personId, `${path}/filter/involved/${i}`);
    }
  }

  checkTimeSource(node: Extract<WatchNode, { type: "source.time" }>, path: string): void {
    const declared = [node.one_off !== undefined, node.recurring !== undefined].filter(
      Boolean,
    ).length;
    if (declared !== 1) {
      this.ctx.diag.error(
        "TIME_SOURCE_AMBIGUOUS",
        path,
        `A time source is either a 'one_off' instant or a 'recurring' schedule — declare exactly one.`,
        { declared },
      );
      return;
    }

    if (node.recurring !== undefined && parseCron(node.recurring) === null) {
      this.ctx.diag.error(
        "CRON_INVALID",
        `${path}/recurring`,
        `'${node.recurring}' is not a five-field cron expression.`,
        { value: node.recurring },
      );
    }

    if (node.one_off !== undefined && !isIsoInstant(node.one_off)) {
      this.ctx.diag.error(
        "INSTANT_INVALID",
        `${path}/one_off`,
        `'${node.one_off}' is not an ISO-8601 instant.`,
        { value: node.one_off },
      );
    }
  }
}

/**
 * Whether the value a predicate compares against could be what the source
 * declares the field holds. A `string`-typed field compared against a number
 * matches nothing, so saying so beats letting a dead condition compile.
 */
function metadataValueTypeMatches(
  declared: string,
  predicate: { op: string; value?: unknown },
): boolean {
  if (predicate.op === "exists") return true;
  const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
  return values.every((value) => {
    if (value === undefined) return true;
    switch (declared) {
      case "number":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      default:
        return typeof value === "string";
    }
  });
}

/** The values a metadata predicate compares against, or null if malformed. */
function metadataPredicateValues(predicate: { op: string; value?: unknown }): string[] | null {
  switch (predicate.op) {
    case "exists":
      return predicate.value === undefined ? [] : null;
    case "in":
    case "not_in":
      return Array.isArray(predicate.value) && predicate.value.every((v) => typeof v === "string")
        ? (predicate.value as string[])
        : null;
    default:
      if (typeof predicate.value === "string") return [predicate.value];
      return typeof predicate.value === "number" || typeof predicate.value === "boolean"
        ? []
        : null;
  }
}

/**
 * A phrase reduced to what makes two sayings of it the same one: case, word
 * separators and punctuation all fold away, so "change request", "Change-Request"
 * and "changeRequest" are one phrase.
 *
 * Spelled here rather than imported, the way the analytics column types are:
 * this package stands alone. It mirrors the normalization the source boundary
 * applies when it refuses a phrase that two values both claim, so a phrasing
 * this resolves is exactly one that boundary let through.
 */
function normalizePhrase(value: string): string {
  return value
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** The value a declared phrasing means, or null when the string is not one. */
function aliasTarget(
  valueAliases: Readonly<Record<string, readonly string[]>> | undefined,
  value: string,
): string | null {
  const wanted = normalizePhrase(value);
  for (const [target, aliases] of Object.entries(valueAliases ?? {})) {
    if (aliases.some((alias) => normalizePhrase(alias) === wanted)) return target;
  }
  return null;
}

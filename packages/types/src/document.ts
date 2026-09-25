// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderId, SourceId } from "./ids.js";

/**
 * Canonical document-type values used across the codebase. Kept as a
 * `const` array so callers that need to enumerate (UI dropdowns, agent
 * prompts, validators) can iterate without duplicating the list.
 *
 * The matching union type `DocumentType` is `(typeof KNOWN_DOCUMENT_TYPES)[number] | (string & {})`
 * — the open string suffix preserves autocomplete for the values below
 * while still accepting custom types a future source may introduce.
 */
export const KNOWN_DOCUMENT_TYPES = [
  "email",
  "event",
  "conversation",
  "attachment",
  "contact",
  "file",
  "note",
  "task",
  "reminder",
  "bookmark",
  // The canonical document type for pages captured by the browser extension.
  "webpage",
  // Legacy: the type the pre-#895 browser extension stamped on pushed pages.
  // No live producer emits it any more, but it is retained because the fold
  // migration (migration 21) reads existing `web-page` rows out of live user
  // DBs to re-home them under `web` as `webpage`, and migrations are
  // append-only — dropping it would make those historical rows an unknown type.
  "web-page",
  "browsing-history",
  "document",
  // One document per calendar day aggregating that day's phone/FaceTime
  // calls (Apple call-log source); a future WhatsApp-calls source will
  // reuse this same type.
  "call-log",
  // A device screenshot (Photos source, #169). Distinct from "photo" so
  // clients can filter/boost the two independently (e.g. `type:screenshot`
  // for document-like captures vs. camera photos).
  "screenshot",
  // A device camera photo (Photos source, #169), OCR'd + on-device
  // analyzed. Every photo becomes exactly one of "screenshot" or "photo".
  "photo",
] as const;

export type KnownDocumentType = (typeof KNOWN_DOCUMENT_TYPES)[number];
export type DocumentType = KnownDocumentType | (string & {});

/**
 * Roles a person can play in relation to a document. Kept as a `const`
 * array — like `KNOWN_DOCUMENT_TYPES` above — so callers that need to
 * enumerate the set (the graph edge vocabulary, validators, UI) can
 * iterate without duplicating the list.
 */
export const PERSON_ROLES = [
  "author",
  "sender",
  "recipient",
  "participant",
  "attendee",
  "mentioned",
  "contact",
  "owner",
] as const;

/**
 * Role a person plays in relation to a document.
 */
export type PersonRole = (typeof PERSON_ROLES)[number];

/**
 * The kinds of identifier a mention can carry.
 *
 * The same strings `person_aliases.alias_type` stores, because a mention's
 * identifier and the row it becomes are the same fact: a kind that is spelled
 * one way on the wire and another in the store is a lookup that silently
 * matches nothing. `name` is deliberately absent — it is an alias type but not
 * an identifier: two people share a name, and nothing may be merged on one.
 */
export const PERSON_IDENTIFIER_KINDS = ["email", "phone", "lid"] as const;

/** See {@link PERSON_IDENTIFIER_KINDS}. */
export type PersonIdentifierKind = (typeof PERSON_IDENTIFIER_KINDS)[number];

/** One identifier a mention carries, named by its kind. */
export interface PersonIdentifier {
  kind: PersonIdentifierKind;
  value: string;
}

/**
 * Whether an identifier of this kind reads as a person when shown to one.
 *
 * An address or a number is something an operator recognises; a platform id
 * is opaque, and a display name falling back to one shows a person as a
 * string of digits. A property of the kind, declared here, because every
 * surface that renders a person has to make the same call and the one that
 * gets it wrong shows the operator an identifier instead of a name.
 */
export function personIdentifierIsReadable(kind: PersonIdentifierKind): boolean {
  return kind === "email" || kind === "phone";
}

/**
 * The half of a mention this reader needs.
 *
 * Typed as the fields rather than as the whole mention because several
 * consumers read mentions straight out of stored JSON, with a narrower
 * hand-written shape — and those were exactly the readers that stayed on the
 * older spelling, because the one function that understands both would not
 * accept what they hold.
 */
export type PersonIdentifierSource = Pick<
  PersonMention,
  "emails" | "phones" | "lids" | "identifiers"
>;

/**
 * Every identifier a mention carries, whichever way it named them.
 *
 * The older per-kind arrays and the namespaced list are the same assertion, so
 * this is where they become one — the shape every consumer reads. Order is the
 * declared kind order, then the order within each kind, so a caller that
 * breaks ties by position gets the same answer whichever spelling arrived.
 */
export function personIdentifiers(mention: PersonIdentifierSource): PersonIdentifier[] {
  const out: PersonIdentifier[] = [];
  const legacy: Record<PersonIdentifierKind, string[] | undefined> = {
    email: mention.emails,
    phone: mention.phones,
    lid: mention.lids,
  };
  for (const kind of PERSON_IDENTIFIER_KINDS) {
    for (const value of legacy[kind] ?? []) out.push({ kind, value });
    for (const declared of mention.identifiers ?? []) {
      if (declared.kind === kind) out.push({ kind, value: declared.value });
    }
  }
  return out;
}

/**
 * A structured mention of a person associated with a document.
 * Sources extract these from document content and metadata.
 *
 * IDENTITY STRENGTH varies sharply by source and is NOT recorded here yet.
 * Email sender/recipient mentions (Gmail, Outlook) come from
 * sender-controlled headers with no DKIM/DMARC verification, and
 * body-extracted `mentioned` entries are fully attacker-controlled — both
 * are spoofable. Platform IDs (WhatsApp LIDs, Strava/Apple Health) and
 * operator-curated contacts are strong. A future retrieval-trust gate must
 * not credit a person off weak, unverified mentions without verifying them
 * first; adding a verified/claimed distinction to this type is deliberately
 * deferred to land with the trust gate, not ingestion.
 */
export interface PersonMention {
  role: PersonRole;
  name?: string;
  /**
   * The identifiers this mention carries, each named by the kind it belongs
   * to — `email`, `phone`, `lid`, and whatever a later platform adds.
   *
   * One list rather than an array per kind, because the store has always been
   * namespaced (`person_aliases.alias_type`) and the wire was the only place
   * that was not: adding a kind meant a new field here plus a new branch in
   * the resolver, the alias writer, the merge rules, the portal and the CLI,
   * every one of which had to be found by hand. Kinds are declared once, in
   * `PERSON_IDENTIFIER_KINDS`, and consumers iterate.
   */
  identifiers?: PersonIdentifier[];
  /** @deprecated Send `identifiers` with kind `email`. */
  emails?: string[];
  /** @deprecated Send `identifiers` with kind `phone`. */
  phones?: string[];
  /** @deprecated Send `identifiers` with kind `lid`. */
  lids?: string[];
  /**
   * If true, this mention represents the canonical "self" person — whoever
   * Omnesis has identified as the operator. The gateway resolves this at
   * people-resolution time. Use when a source has no accountId-as-email (e.g.
   * Things, Obsidian) but is structurally a self-authored doc.
   */
  isSelf?: boolean;
  /**
   * Whether this mention may create a person when none of its identifiers is
   * already known. Defaults to true. Free-text entity extraction sets this to
   * false: a phone in arbitrary prose is useful linking evidence, but is not
   * by itself an identity-bearing assertion.
   */
  allowPersonCreation?: boolean;
  /**
   * What the mention names. Omitted means a person. `agent` marks a software
   * principal acting through an access grant — an external agent that captured
   * a note, for instance — named so consumers of `people` see who acted, and
   * never resolved to a person: the resolver skips it whatever identifiers it
   * carries, so an agent can neither create a person nor attach to one whose
   * name it happens to share.
   */
  kind?: "person" | "agent";
}

/** Collector-side context used to interpret locale-dependent document text. */
export interface DocumentIngestionContext {
  /** BCP 47 locale reported by the source device, when available. */
  locale?: string;
  /** ISO 3166-1 alpha-2 country used for national-format phone parsing. */
  phoneRegion?: string;
  /** How the collector chose `phoneRegion`; retained as parsing provenance. */
  phoneRegionSource?: "override" | "os" | "environment" | "runtime" | "fallback";
}

/**
 * A normalized document produced by a source.
 * This is the universal unit of data that flows through the system.
 */
export interface Document {
  /** Globally unique ID (generated by the system, e.g. UUID) */
  id: string;

  /**
   * Provider that produced this document (e.g. "google", "apple").
   * Stored explicitly because source type ≠ provider type (e.g. "gmail" → "google").
   */
  providerId: ProviderId;

  /** Source that produced this document (e.g. "gmail:user@gmail.com") */
  sourceId: SourceId;

  /**
   * ID of this item in the source system (e.g. Gmail message ID).
   * For aggregate documents (e.g. daily conversation threads), sources use
   * composite keys like `chatJid:YYYY-MM-DD`.
   */
  externalId: string;

  /** Human-readable title (e.g. email subject, event title, note title) */
  title: string;

  /** Normalized content as markdown */
  content: string;

  /** SHA-256 hash of content, used for deduplication and change detection */
  contentHash: string;

  /**
   * Optional SHA-256 hash of the underlying extracted-from-bytes payload
   * (e.g. PDF text, OCR'd photo text), independent of any per-provider
   * rendering wrapper. Binary-extracting producers (Drive `file`,
   * attachment-pipeline docs) set it so cross-source duplicates can
   * match even when each provider wraps the extracted text differently
   * in `content` — it is the dedup key for the `duplicate-content`
   * reference link. The Photos source also sets it, from OCR'd text,
   * but strictly for idempotent re-ingest of the same asset — never for
   * cross-source dedup (an OCR'd screenshot and the document it's a
   * screenshot of are always two documents). NULL for docs that have no
   * extracted-from-bytes payload (emails, notes, conversations).
   */
  extractedContentHash?: string;

  /** Source-specific metadata (sender, attendees, labels, deep URI, etc.) */
  metadata: DocumentMetadata;

  /** When this item was created in the source system */
  sourceCreatedAt: Date;

  /** When this item was last modified in the source system */
  sourceUpdatedAt: Date;

  /** When this document was first ingested */
  ingestedAt: Date;

  /** When this document was last updated in our system */
  updatedAt: Date;
}

/**
 * Metadata attached to a document. Common fields are typed;
 * source-specific fields go in `extra`.
 */
export interface DocumentMetadata {
  /**
   * Reliable web or desktop destination represented by this document. This is
   * normally the exact source item; reference sources may link to the resource
   * the document describes. Omit when no reliable destination exists; internal
   * identity URIs do not belong here.
   */
  sourceUrl?: string;

  /**
   * Native-app deep link for mobile clients (e.g. `googlecalendar://…`,
   * `mobilenotes://…`). Populated by providers whose source has a native
   * iOS app with a working custom URI scheme to open the specific item.
   * Clients in a native-app context (iOS) prefer this; web contexts
   * (portal) use `sourceUrl`. Omitted when the source has no such scheme
   * (e.g. Gmail, whose only `googlegmail://` action is compose), in which
   * case iOS falls back to `sourceUrl`.
   */
  appUrl?: string;

  /** Tags or labels from the source system */
  tags?: string[];

  /** Document kind: email, event, conversation, file, etc. */
  documentType?: DocumentType;

  /** Source-computed relevance score (0.0–1.0). Used as a search ranking boost. */
  relevanceScore?: number;

  /**
   * The item carries a bulk-distribution marker — e.g. an RFC 2369
   * `List-Unsubscribe` header on an email. Set by mail-like sources during
   * normalization so shared consumers can treat machine-distributed items
   * generically (the background agent's wake heuristics skip them) without
   * branching on a source name. Omitted (never `false`) when the source
   * saw no such marker.
   */
  bulkMail?: boolean;

  /**
   * The item came from an automated / no-reply sender and expects no human
   * reply — e.g. a `noreply@`/`notifications@` transactional notification, or
   * a message carrying an RFC 3834 `Auto-Submitted: auto-generated` header.
   * Distinct from {@link bulkMail}: bulk mail is mass distribution (marketing,
   * mailing lists, List-Unsubscribe), whereas this marks machine-generated
   * transactional notifications that carry no such unsubscribe signal. Set by
   * mail-like sources during normalization so shared consumers (the background
   * agent's wake heuristics) can skip them generically without re-deriving mail
   * headers or branching on a source name. Omitted (never `false`) otherwise.
   */
  automatedSender?: boolean;

  /**
   * The document is a rolling aggregate / high-churn summary that a local
   * source continuously rewrites (e.g. a per-day usage digest that updates on
   * every new sample). Semantically these resemble the high-throughput
   * structured samples the background agent digests in its daily batch rather
   * than meaningful one-shot documents, so shared consumers route them to the
   * daily batch instead of waking the real-time agent per edit. Set by the
   * producing source on its own aggregate documents (a generic descriptor,
   * never a source-name branch downstream). Omitted (never `false`) otherwise.
   */
  rollingAggregate?: boolean;

  /**
   * The item is a casual, low-information one — e.g. a camera photo with no
   * extracted text, no caption, and no scene/object labels. Semantically it
   * carries little for the background agent to reason about on its own, so
   * shared consumers (the background agent's wake heuristics) skip waking on
   * it generically, without branching on a source name. Distinct from
   * {@link rollingAggregate}: this marks an individually low-value document,
   * not a continuously-rewritten aggregate. Set by the producing source
   * during normalization (e.g. the Photos source, #169, on a text-less,
   * caption-less, label-less photo). Omitted (never `false`) otherwise.
   */
  lowSignal?: boolean;

  /**
   * The document is content the user explicitly addressed to the assistant
   * (e.g. captured notes told to it directly). The inverse of
   * {@link lowSignal}: consumers treat it as maximally high-signal — the
   * background agent's wake heuristics wake immediately on it, bypassing
   * batch deferral and the volume gates that exist to suppress noise the
   * user never meant for the assistant. Set by the producing source on its
   * own documents (a generic descriptor, never a source-name branch
   * downstream). Omitted (never `false`) otherwise.
   */
  addressedToAgent?: boolean;

  /**
   * Stable, model-safe context for independently authored entries aggregated
   * into this document. Consumers compare entries by `id` to identify the
   * exact additions/edits that caused an aggregate document to change.
   * Sensitive sensor coordinates stay in the source ledger; this shared
   * projection carries only context suitable for cognition prompts.
   */
  addressedEntries?: AddressedEntryContext[];

  /**
   * Source-owned lifecycle value for this item (for example `open`,
   * `completed`, `canceled`, or another provider-defined spelling).
   *
   * This field deliberately does not use the canonical temporal-status
   * vocabulary: providers retain their native lifecycle contract here, and
   * descriptors map it onto a consumer vocabulary such as
   * `active`/`completed`/`cancelled`. Shared consumers must not branch on a
   * source name or assume every source uses the same values.
   */
  status?: string;

  /**
   * Forward-looking date on which this document is *scheduled* to happen or
   * become relevant — a task's planned start day, an event's start, a
   * "revisit on" date. ISO 8601: a full date-time when the source has a time
   * (`2026-07-04T09:00:00.000Z`), or a date-only string when it is a
   * timezone-less wall-clock day (`2026-07-04`, as Things stores it). Distinct
   * from {@link dueAt}: `scheduledAt` is the soft/planned day, `dueAt` is the
   * hard deadline — a task can carry both (planned for the 10th, due by the
   * 15th), so they are kept as separate first-class fields rather than
   * collapsed, because no single date serves both "surface it on my planned
   * day" and "list what is due today" correctly.
   *
   * Generic and source-populated: any dated source fills whichever of these
   * it has (Things fills both from `startDate`/`deadline`; Apple Reminders
   * fills `dueAt`). Consumers read the typed field, never branching on a
   * source name; those needing a single "when does this matter" instant
   * coalesce (`dueAt ?? scheduledAt` for urgency, `scheduledAt ?? dueAt` for
   * the planned day). Sources also keep their own display strings in `extra`
   * (e.g. `extra.scheduled`) for rendering; this typed field is the
   * queryable, machine-readable promotion. Omitted when the item has no such
   * date.
   */
  scheduledAt?: string;

  /**
   * Forward-looking *deadline* — the date by which this document must be
   * acted on. Same ISO 8601 shape and encapsulation contract as
   * {@link scheduledAt} (see there for the scheduled-vs-due distinction and
   * the coalesce guidance). Populated from a Things `deadline`, an Apple
   * Reminders due date, or any source's hard-deadline field. Omitted when the
   * item has no deadline.
   */
  dueAt?: string;

  /**
   * When the thing the document describes finishes — the exclusive or closed
   * end paired with {@link scheduledAt}. ISO instant with an offset, or a bare
   * `YYYY-MM-DD` for a calendar day.
   *
   * Without this a document could only ever assert a point in time, so a
   * booking confirmation for a three-night stay projected as an instant. Omit
   * it when the document describes something instantaneous or open-ended.
   */
  endsAt?: string;

  /**
   * IANA zone the document's dates are anchored in (e.g. `Europe/London`),
   * when the source knows it. Only meaningful alongside a date field; a date
   * carrying its own offset does not need it.
   */
  timeZone?: string;

  /** Durable collector context for locale-dependent extraction and rebuilds. */
  ingestionContext?: DocumentIngestionContext;

  /** Structured people mentions extracted by sources */
  people?: PersonMention[];

  /** Source-specific fields that don't fit the common schema */
  extra?: Record<string, unknown>;
}

/** Authenticated capture provenance, snapshotted independently of client-supplied note text. */
export interface NoteCaptureContext {
  principalId: string;
  principalName: string;
  grantId: string;
  grantRevision: number;
  credentialId: string;
  oauthClientId: string;
  requestId: string;
}

export interface AddressedEntryContext {
  captureContext?: NoteCaptureContext;
  id: string;
  capturedAt: string;
  updatedAt: string;
  capturedTimeZoneId?: string;
  capturedUtcOffsetSeconds?: number;
  receivedAt?: string;
  surface?: string;
  placeName?: string;
}

/**
 * A date Omnesis extracted from a document's text, resolved against the
 * document's emission date (`sourceCreatedAt`) so that relative expressions
 * ("tomorrow", "in 3 years", "next Tuesday") become absolute.
 *
 * This is an **Omnesis-derived enrichment** signal — distinct from
 * source-provided {@link DocumentMetadata}, which the source populates. It is
 * produced by the (experimental) date-extraction pass and surfaced in clients
 * as an "enriched by Omnesis" section, visually separated from source metadata.
 */
export interface ExtractedDate {
  /**
   * Shape of the temporal expression:
   * - `date` — a single resolved calendar date (`resolvedStart` set).
   * - `range` — an interval. Bounded → both `resolvedStart` and `resolvedEnd`;
   *   open-ended deadline ("before X" / "after X") → one bound plus `mod`.
   *
   * Only these two are emitted: durations are resolved to a `date` when
   * directional (anchor ± duration) and dropped otherwise, and recurrences are
   * dropped — anything without a concrete year is never stored.
   */
  kind: "date" | "range";

  /**
   * Resolved lower bound / point, **canonical calendar date always carrying a
   * year**, at the coarsest granularity known: `YYYY`, `YYYY-MM`, or
   * `YYYY-MM-DD` (never a time component; never a day/month without a year).
   * Null only for an open-ended upper-bound deadline (see `resolvedEnd`).
   */
  resolvedStart: string | null;

  /** Resolved upper bound, same canonical format. Null for a point date or an open lower bound. */
  resolvedEnd: string | null;

  /** Open-ended-range modifier when present: "before" | "after" | "since" | "until". */
  mod?: string;

  /** True when the expression was relative (resolved against the emission-date anchor). */
  relative: boolean;

  /** The raw phrase as it appeared in the document (e.g. "next Friday"). */
  text: string;

  /** TIMEX3 expression from the recognizer — a durable, normalized encoding of the temporal value. */
  timex: string;

  /** Char offset of the matched phrase in the document content — provenance. */
  charStart: number;
  charEnd: number;
}

/**
 * Inbound DTO for documents sent from collector to gateway.
 * Omits system-generated fields (id, ingestedAt, updatedAt) that the
 * gateway assigns on ingestion. Dates are ISO 8601 strings since they
 * cross the HTTP boundary.
 */
export interface DocumentInput {
  providerId: ProviderId;
  sourceId: SourceId;
  externalId: string;
  title: string;
  content: string;
  contentHash: string;
  /** See `Document.extractedContentHash`. */
  extractedContentHash?: string;
  metadata: DocumentMetadata;
  sourceCreatedAt: string; // ISO 8601
  sourceUpdatedAt: string; // ISO 8601
  /**
   * Which of the source's own partitions this document was read from — an
   * address book, a notebook, a vault, a repository.
   *
   * Only a source that reports per-partition snapshot claims needs to set it,
   * and for that source it is what makes a claim actionable: a claim says
   * "partition P holds exactly these ids", and the gateway can only act on
   * that if it can tell which of its documents are in P. Without the key every
   * document sits in the unnamed partition `""`, which is the correct answer
   * for a source with one backing store.
   *
   * Deliberately not part of a document's identity. A note moved between
   * notebooks is the same note, so the key is a plain column the next upsert
   * overwrites — and a document that moves out of a claimed partition and into
   * a gapped one stops being swept rather than being deleted.
   */
  partitionKey?: string;
}

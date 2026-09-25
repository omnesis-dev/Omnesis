// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Document projection types + helpers — shared between the event bus
 * (`../events.ts`) and the data layer (`./repositories/DocumentRepository.ts`).
 *
 * Lives in `data/` rather than at the top level because:
 *   - `DocumentRepository` populates these projections inline during
 *     upsert and used to import `extractPeopleFromMetadata` from the
 *     top-level `events.ts` — an upward dependency from `data/` into
 *     the event surface that broke the one-direction layering rule.
 *   - The event bus (top-level) is a downstream consumer; it
 *     re-exports the interface and helpers for backward-compatible
 *     callers (`EventService`, projection tests) but the source of
 *     truth lives here.
 */

/**
 * Fixed projection of a document that travels on the bus. Deliberately
 * small: top-level scalars, the metadata blob (which carries tags +
 * document-type-specific extras), the people array, and the content
 * hash. We do NOT carry the raw content body — it churns on every
 * reindex and is the heaviest field on the row.
 */
export interface DocumentProjection {
  /** Gateway-assigned stable id. Same on `before` and `after` for an update. */
  id: string;
  providerId: string;
  sourceId: string;
  externalId: string;
  /** Convenience copy of `metadata.documentType` (or null). */
  documentType: string | null;
  title: string;
  /** Hash of the content body; lets subscribers detect text mutations cheaply. */
  contentHash: string;
  /**
   * Loose metadata blob. Same shape as `DocumentInput.metadata` —
   * carries `tags`, `sourceUrl`, `documentType`, `extra`, and
   * provider-specific fields.
   */
  metadata: Record<string, unknown>;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  /**
   * People mentions, derived from `metadata.people`. Snapshotted into
   * the projection so transition predicates can match on role/email/phone
   * without re-walking the metadata blob. `personId` is null at
   * projection time — people resolution is async and runs after the
   * upsert.
   */
  people: ReadonlyArray<{
    role: string;
    personId: string | null;
    name?: string;
    emails?: string[];
    phones?: string[];
    /** Platform-issued identifiers — a login, an athlete id, a messaging id. */
    lids?: string[];
  }>;
}

/**
 * Pull people mentions out of a `metadata.people` array (the
 * provider-side convention). Returns a fresh array; the source object
 * is left alone. `personId` is always null at projection time —
 * resolution is async and runs after the upsert.
 */
export function extractPeopleFromMetadata(
  metadata: Record<string, unknown> | undefined,
): DocumentProjection["people"] {
  const raw = metadata?.["people"];
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    role: string;
    personId: string | null;
    name?: string;
    emails?: string[];
    phones?: string[];
    /** Platform-issued identifiers — a login, an athlete id, a messaging id. */
    lids?: string[];
  }> = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.role !== "string") continue;
    const entry: {
      role: string;
      personId: string | null;
      name?: string;
      emails?: string[];
      phones?: string[];
      lids?: string[];
    } = { role: o.role, personId: null };
    if (typeof o.name === "string") entry.name = o.name;
    if (Array.isArray(o.emails)) {
      const emails = (o.emails as unknown[]).filter((e): e is string => typeof e === "string");
      if (emails.length > 0) entry.emails = emails;
    }
    if (Array.isArray(o.phones)) {
      const phones = (o.phones as unknown[]).filter((e): e is string => typeof e === "string");
      if (phones.length > 0) entry.phones = phones;
    }
    // Copied for the same reason as the other two. A person named only by a
    // platform identifier — every GitHub and Strava participant, and any
    // messaging contact whose number was never shared — is otherwise absent
    // from the projection, and so invisible to anything that reads it.
    if (Array.isArray(o.lids)) {
      const lids = (o.lids as unknown[]).filter((e): e is string => typeof e === "string");
      if (lids.length > 0) entry.lids = lids;
    }
    // A mention may name its identifiers as one namespaced list instead. The
    // projection speaks the per-kind arrays and every reader of it does too,
    // so the list is folded into them here rather than becoming a fourth
    // shape each of those readers would have to learn.
    for (const declared of Array.isArray(o.identifiers) ? o.identifiers : []) {
      if (!declared || typeof declared !== "object") continue;
      const { kind, value } = declared as { kind?: unknown; value?: unknown };
      if (typeof value !== "string") continue;
      if (kind === "email") entry.emails = [...(entry.emails ?? []), value];
      else if (kind === "phone") entry.phones = [...(entry.phones ?? []), value];
      else if (kind === "lid") entry.lids = [...(entry.lids ?? []), value];
    }
    out.push(entry);
  }
  return out;
}

/**
 * Stable JSON of two values for set-equality checks. NOT order-stable
 * across keys: two metadata objects with identical keys in different
 * insertion order will be reported as different here. That's fine —
 * providers always produce metadata in a consistent order, and the
 * false-positive cost is one extra trigger evaluation.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function tagsOf(metadata: Record<string, unknown>): unknown[] {
  const t = metadata["tags"];
  return Array.isArray(t) ? t : [];
}

/**
 * Compute the ordered list of projection fields that differ between
 * `before` and `after`. Empty when `before` is null — inserts are
 * conventionally "no fields changed, but the doc is new" (subscribers
 * detect that with `before === null`).
 */
export function computeChangedFields(
  before: DocumentProjection | null,
  after: DocumentProjection,
): string[] {
  if (!before) return [];
  const out: string[] = [];
  if (before.title !== after.title) out.push("title");
  if (before.contentHash !== after.contentHash) out.push("contentHash");
  if (before.documentType !== after.documentType) out.push("documentType");
  if (before.sourceCreatedAt !== after.sourceCreatedAt) out.push("sourceCreatedAt");
  if (before.sourceUpdatedAt !== after.sourceUpdatedAt) out.push("sourceUpdatedAt");
  if (!jsonEqual(tagsOf(before.metadata), tagsOf(after.metadata))) {
    out.push("metadata.tags");
  }
  if (!jsonEqual(before.metadata, after.metadata)) out.push("metadata");
  if (!jsonEqual(before.people, after.people)) out.push("people");
  return out;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Narrowing a document's metadata down to what its source declared.
 *
 * A document's `metadata` blob is whatever the normalizer chose to write. The
 * journal carries only the fields the source *published* in its
 * `DocumentEventProfile`, and the difference matters twice over: a watch must
 * not be able to depend on a field nobody promised, and the drift discipline
 * that pauses a watch when its ontology moves has nothing to check against for
 * a field that was never in the ontology.
 *
 * Declared paths are dotted and relative to `metadata` — `extra.threadId`
 * addresses `metadata.extra.threadId` — so the projection walks in and rebuilds
 * the same shape rather than flattening. A consumer writing `$e.metadata.extra
 * .threadId` is reading the path the source declared, spelled the same way.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * Path segments that address the prototype rather than a property.
 *
 * Declared paths come from a source and are stored in a table, so the
 * projection is one bad stored declaration away from writing through an
 * object's prototype. The declaration validator rejects these, but the
 * projection does not re-validate what the database hands it, and a guard here
 * is cheaper than trusting that it always will.
 */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Only the paths the source declared, addressed as the profile spells them. */
export function declaredMetadata(
  metadata: Readonly<Record<string, unknown>>,
  profile: DocumentEventProfile | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of profile?.metadataFields ?? []) {
    const value = readPath(metadata, field.path);
    if (value === undefined) continue;
    writePath(out, field.path, value);
  }
  return out;
}

/**
 * A document's stored metadata blob, or an empty one.
 *
 * Unparseable metadata is a document with no declared fields rather than a
 * failed drain: one corrupt row must not stop the journal recording every
 * other document in the batch.
 */
export function parseMetadata(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readPath(source: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (UNSAFE_SEGMENTS.has(segment)) return undefined;
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) return;
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== "object") {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
}

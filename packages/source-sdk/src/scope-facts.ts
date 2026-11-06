// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeEmail } from "@omnesis/core";
import { personIdentifiers } from "@omnesis/types";
import type {
  DocumentMetadata,
  DocumentScopeFacts,
  ScopeRef,
  ScopeIdentifier,
  SourceScopes,
} from "@omnesis/types";

export interface NativeScopeParticipant {
  /** An opaque source identity takes precedence over a supported address. Null means unknown. */
  nativeKey: string | null;
  identifiers: ScopeIdentifier[];
  complete: boolean;
}

/** Original source assertions only; no display-name or mutable people-row matching. */
export function projectNativeScopeParticipants(
  people: unknown,
  scopes: SourceScopes,
): { participants: NativeScopeParticipant[]; complete: boolean } {
  const recipe = scopes.legacyProjection?.participants;
  const declaration = scopes.items.find((item) => item.kind === "participant");
  if (!recipe || !declaration || !Array.isArray(people))
    return { participants: [], complete: false };
  const participants: NativeScopeParticipant[] = [];
  let complete = recipe.maxPeople === undefined || people.length < recipe.maxPeople;
  for (const mention of people) {
    if (!mention || typeof mention !== "object") {
      complete = false;
      participants.push({ nativeKey: null, identifiers: [], complete: false });
      continue;
    }
    if (mention.role === "mentioned" || !recipe.roles.includes(mention.role)) continue;
    let raw;
    try {
      raw = personIdentifiers(mention);
    } catch {
      complete = false;
      participants.push({ nativeKey: null, identifiers: [], complete: false });
      continue;
    }
    const identifiers: ScopeIdentifier[] = [];
    const seen = new Set<string>();
    for (const identifier of raw) {
      if (
        typeof identifier.value !== "string" ||
        (identifier.kind !== "phone" && identifier.kind !== "email")
      )
        continue;
      if (!declaration.identifiers.includes(identifier.kind)) continue;
      const value =
        identifier.kind === "phone"
          ? identifier.value.trim().replace(/[\s().-]/g, "")
          : normalizeEmail(identifier.value);
      if (
        !(identifier.kind === "phone" ? /^\+[1-9][0-9]{6,14}$/ : /^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(
          value,
        )
      )
        continue;
      const key = `${identifier.kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identifiers.push({ type: identifier.kind, value });
    }
    const opaque = raw
      .filter(
        (identifier) =>
          identifier.kind === "lid" &&
          typeof identifier.value === "string" &&
          identifier.value.trim(),
      )
      .map((identifier) => `lid:${identifier.value}`)
      .sort()[0];
    const nativeKey =
      opaque ??
      identifiers.map((identifier) => `${identifier.type}:${identifier.value}`).sort()[0] ??
      null;
    // A legacy metadata record may contain an unbounded alias bag. Keep writer
    // work bounded and preserve uncertainty rather than asserting a truncated set.
    const resolved = identifiers.length > 0 && identifiers.length <= 16;
    participants.push({ nativeKey, identifiers: identifiers.slice(0, 16), complete: resolved });
    if (!resolved) complete = false;
  }
  return { participants, complete: complete && participants.length > 0 };
}

/**
 * Legacy conversation speakers are observations, not a complete member roster.
 * Explicit native projections override only the kinds they name; an unknown
 * kind deliberately removes any legacy completeness for that kind.
 */
export function projectDocumentScopeFacts(
  metadata: DocumentMetadata,
  scopes: SourceScopes,
): DocumentScopeFacts {
  const result: DocumentScopeFacts = { facts: [], complete: [] };
  const projection = scopes.legacyProjection;
  if (projection?.conversationIdPath && scopes.items.some((item) => item.kind === "conversation")) {
    let value: unknown = metadata;
    for (const key of projection.conversationIdPath) {
      value =
        value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined;
    }
    if (typeof value === "string" && value.trim()) {
      result.facts.push({ kind: "conversation", id: value });
      result.complete.push("conversation");
    }
  }
  if (projection?.participants) {
    const native = projectNativeScopeParticipants(metadata.people, scopes);
    const seen = new Set<string>();
    for (const participant of native.participants)
      for (const identifier of participant.identifiers) {
        const key = `${identifier.type}:${identifier.value}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.facts.push({ kind: "participant", identifier });
        }
      }
    if (native.complete && projection.participants.membership === "document")
      result.complete.push("participant");
  }
  const explicit = metadata.scopeFacts;
  if (explicit) {
    const supported = new Set(scopes.items.map((item) => item.kind));
    const kinds = new Set(
      (explicit.kinds ?? [...explicit.facts.map((fact) => fact.kind), ...explicit.complete]).filter(
        (kind) => supported.has(kind),
      ),
    );
    result.facts = result.facts.filter((fact) => !kinds.has(fact.kind));
    result.complete = result.complete.filter((kind) => !kinds.has(kind));
    result.facts.push(...explicit.facts.filter((fact) => kinds.has(fact.kind)));
    result.complete.push(...explicit.complete.filter((kind) => kinds.has(kind)));
    if (explicit.refreshEpochs)
      result.refreshEpochs = Object.fromEntries(
        Object.entries(explicit.refreshEpochs).filter(([kind]) =>
          kinds.has(kind as ScopeRef["kind"]),
        ),
      );
  }
  return result;
}

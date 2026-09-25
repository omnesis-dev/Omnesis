// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { loadActiveUniverse, loadCastFromUniverse } from "./universe.js";
import type { PersonRole } from "@omnesis/types";
import type { Cast, Person, PersonRef, ResolvedPerson, ResolvedPersonMention } from "./types.js";

let cached: Cast | null = null;

/** Load the active universe's persona cast. Cached after first call. */
export function loadCast(): Cast {
  if (cached) return cached;
  cached = loadCastFromUniverse(loadActiveUniverse());
  return cached;
}

/** Reset the cached cast — testing aid. */
export function resetCastCache(): void {
  cached = null;
}

/** Look up a persona by ref. `"self"` resolves via `cast.self`. */
export function getPerson(ref: PersonRef, cast: Cast = loadCast()): Person {
  const id = ref === "self" ? cast.self : ref;
  const found = cast.people.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown persona ref: ${ref} (resolved to ${id})`);
  return found;
}

/** Resolve a persona ref to a normalized shape suitable for PersonMention construction. */
export function resolvePerson(ref: PersonRef, cast: Cast = loadCast()): ResolvedPerson {
  const p = getPerson(ref, cast);
  return {
    name: p.name,
    emails: p.emails ?? [],
    phones: p.phones ?? [],
    lids: p.lids ?? [],
    isSelf: ref === "self" || p.id === cast.self,
  };
}

/** Resolve a persona ref + role into a PersonMention-shaped object. */
export function personMention(
  ref: PersonRef,
  role: PersonRole,
  cast: Cast = loadCast(),
): ResolvedPersonMention {
  return { ...resolvePerson(ref, cast), role };
}

/** Get the alias of a persona under a specific source's accountId key. */
export function selfAccountId(aliasKind: "email" | "phone" | "extra", extraKey?: string): string {
  const cast = loadCast();
  const self = getPerson("self", cast);
  if (aliasKind === "email") {
    const v = self.emails?.[0];
    if (!v) throw new Error(`self persona ${self.id} has no email alias`);
    return v;
  }
  if (aliasKind === "phone") {
    const v = self.phones?.[0];
    if (!v) throw new Error(`self persona ${self.id} has no phone alias`);
    return v;
  }
  const v = self.extra?.[extraKey ?? ""];
  if (!v) throw new Error(`self persona ${self.id} has no extra.${extraKey} alias`);
  return v;
}

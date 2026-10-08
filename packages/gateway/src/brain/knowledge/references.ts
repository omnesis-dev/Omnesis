// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type ClaimReferenceKind = "source" | "wiki" | "loop" | "annotation" | "brief";
export type ClaimSelectorKind = "evidence" | "claim" | "field";

export interface ClaimReference {
  raw: string;
  kind: ClaimReferenceKind;
  id: string;
  selector?: { kind: ClaimSelectorKind; id: string };
}

/** Opaque identifiers, never URLs, paths, markup, or encoded attribute values. */
export function isClaimIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
}

/** Syntax only: existence, revisions and entailment belong to the write service. */
export function parseClaimReference(raw: string): ClaimReference {
  const match =
    /^(source|wiki|loop|annotation|brief):([A-Za-z0-9_-]{1,128})(?:#(evidence|claim|field):([A-Za-z0-9_-]{1,128}))?$/.exec(
      raw,
    );
  if (!match || match[0] !== raw) throw new Error("Invalid claim reference");
  const kind = match[1] as ClaimReferenceKind;
  const id = match[2]!;
  const selectorKind = match[3] as ClaimSelectorKind | undefined;
  if (selectorKind) {
    const allowed =
      kind === "source"
        ? selectorKind === "evidence"
        : kind === "loop"
          ? selectorKind === "field" || selectorKind === "claim"
          : selectorKind === "claim";
    if (!allowed) throw new Error("Invalid selector for claim reference kind");
    return { raw, kind, id, selector: { kind: selectorKind, id: match[4]! } };
  }
  return { raw, kind, id };
}

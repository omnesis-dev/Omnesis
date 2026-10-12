// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Annotation lifecycle is distinct from whether its mirrored dependencies are current. */
export function annotationLifecycle(node) {
  if (!["person_annotation", "doc_annotation"].includes(node.kind)) return [];
  const fields = node.canonicalFields ?? {};
  return fields.withdrawn === true ? ["Withdrawn"] : fields.supersededBy ? ["Superseded"] : fields.invalidatedAt != null ? ["Invalidated"] : [];
}

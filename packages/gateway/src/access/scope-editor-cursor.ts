// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { z } from "zod";

const cursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().length(64),
  label: z.string().max(2048),
  id: z.string().min(1).max(512),
});
export type ScopeEditorCursor = z.infer<typeof cursorSchema>;
export function scopeEditorCursorScope(
  sourceId: string,
  kind: string,
  query: string,
  parentId?: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sourceId, kind, query, parentId ?? null]))
    .digest("hex");
}
export function decodeScopeEditorCursor(
  raw: string | undefined,
  scope: string,
): ScopeEditorCursor | null {
  if (raw === undefined) return null;
  if (raw.length > 8192) throw new Error("Invalid filter picker cursor.");
  const value = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  if (value.scope !== scope) throw new Error("Filter picker cursor belongs to another query.");
  return value;
}
export function encodeScopeEditorCursor(scope: string, label: string, id: string): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ version: 1, scope, label, id }))).toString(
    "base64url",
  );
}

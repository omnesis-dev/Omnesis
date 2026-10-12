// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it, vi } from "vitest";
import { KnowledgeStorageError } from "./types.js";
import { readKnowledgeReferenceBatch, KNOWLEDGE_REFERENCE_BATCH_BYTES } from "./reference-batch.js";
const view = (ref: string, text = "Full evidence") => ({
  ref,
  text,
  revision: "v1",
  stale: false,
  verified: true,
});
it("deduplicates reads and isolates expected reference failures", () => {
  const read = vi.fn((ref: string) => {
    if (ref === "source:missing")
      throw new KnowledgeStorageError("reference_invalid", "hidden detail");
    return view(ref);
  });
  const result = readKnowledgeReferenceBatch(
    ["source:a", "source:missing", "source:a", "source:b"],
    read,
  );
  expect(read).toHaveBeenCalledTimes(3);
  expect(result.items.map((item) => item.ok)).toEqual([true, false, true]);
  expect(JSON.stringify(result)).not.toContain("hidden detail");
  expect(result.deferredRefs).toEqual([]);
});
it("defers complete views without truncating and directs oversized views to a single read", () => {
  const result = readKnowledgeReferenceBatch(["source:a", "source:b", "source:c"], (ref) =>
    view(ref, "x".repeat(35_000)),
  );
  expect(result.items).toHaveLength(1);
  expect(result.deferredRefs).toEqual(["source:b", "source:c"]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    KNOWLEDGE_REFERENCE_BATCH_BYTES,
  );
  const huge = readKnowledgeReferenceBatch(["source:huge", "source:small"], (ref) =>
    view(ref, ref.endsWith("huge") ? "x".repeat(70_000) : "okay"),
  );
  expect(huge.items[0]).toMatchObject({ ok: false, code: "reference_too_large" });
  expect(huge.items[1]).toMatchObject({ ok: true });
});
it("does not swallow unexpected implementation errors", () => {
  expect(() =>
    readKnowledgeReferenceBatch(["source:a"], () => {
      throw new Error("database failure");
    }),
  ).toThrow("database failure");
});

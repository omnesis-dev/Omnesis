// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { resolveSearchSettings } from "../search-config.js";
import { RefCountStage } from "./ref-count-stage.js";
import type { SearchStageContext } from "./stage.js";
import type { LinkRefSource, SearchResultItem } from "../types.js";

function makeResult(documentId: string): SearchResultItem {
  return {
    documentId,
    sourceId: `gmail:${documentId}`,
    documentType: "email",
    title: documentId,
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    chunkText: documentId,
    score: 1,
  };
}

/**
 * Minimal stage context. The ref-count stage reads only `results` and
 * `deps.linkRefSource`; everything else is a structurally-valid placeholder.
 */
function makeCtx(results: SearchResultItem[], linkRefSource?: LinkRefSource): SearchStageContext {
  return {
    query: { text: "" },
    effectiveText: "",
    parsedFilters: {},
    filters: {},
    settings: resolveSearchSettings(),
    limit: 10,
    candidateLimit: 50,
    results,
    vectorConfig: { hnswOverFetch: 10, alwaysOverFetch: false },
    sourcePriors: {} as SearchStageContext["sourcePriors"],
    diversity: { enabled: false, bucketBy: "type" },
    commonTokenThreshold: 0,
    timing: { totalMs: 0 },
    stageReports: {},
    deps: { linkRefSource } as SearchStageContext["deps"],
  };
}

describe("RefCountStage", () => {
  test("is disabled without an injected linkRefSource", () => {
    const ctx = makeCtx([makeResult("a")]);
    expect(new RefCountStage().isEnabled(ctx)).toBe(false);
  });

  test("is disabled on an empty result set", () => {
    const ctx = makeCtx([], { getInboundRefCounts: () => new Map() });
    expect(new RefCountStage().isEnabled(ctx)).toBe(false);
  });

  test("writes the inbound ref count onto each matching result", async () => {
    const source: LinkRefSource = {
      getInboundRefCounts: (ids) => {
        expect([...ids]).toEqual(["a", "b"]);
        return new Map([
          ["a", 5],
          ["b", 0],
        ]);
      },
    };
    const ctx = makeCtx([makeResult("a"), makeResult("b")], source);
    const stage = new RefCountStage();
    expect(stage.isEnabled(ctx)).toBe(true);
    await stage.execute(ctx);
    // > 0 is surfaced; 0 stays absent (sparse by construction).
    expect(ctx.results[0]?.refCount).toBe(5);
    expect(ctx.results[1]?.refCount).toBeUndefined();
    expect(ctx.stageReports.refCount?.status).toBe("ran");
  });

  test("leaves refCount absent for a doc the source doesn't know about", async () => {
    const ctx = makeCtx([makeResult("ghost")], { getInboundRefCounts: () => new Map() });
    await new RefCountStage().execute(ctx);
    expect(ctx.results[0]?.refCount).toBeUndefined();
  });
});

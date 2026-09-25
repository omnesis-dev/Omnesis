// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SearchStage, SearchStageContext } from "./stage.js";

/**
 * Post-fusion enrichment: pulls inbound-reference counts for the
 * fused result set so the UI can show "5 documents reference this".
 *
 * The actual graph lookup is injected via `ctx.deps.linkRefSource`
 * `search/` no longer reaches into `links.ts` at
 * compile time. Without an injected source, the stage stays disabled.
 */
export class RefCountStage implements SearchStage {
  readonly name = "ref-count";

  isEnabled(ctx: SearchStageContext): boolean {
    return !!ctx.deps.linkRefSource && ctx.results.length > 0;
  }

  async execute(ctx: SearchStageContext): Promise<void> {
    const start = Date.now();
    const source = ctx.deps.linkRefSource!;
    const docIds = ctx.results.map((r) => r.documentId);
    const refCounts = source.getInboundRefCounts(docIds);
    for (const r of ctx.results) {
      const count = refCounts.get(r.documentId);
      if (count && count > 0) r.refCount = count;
    }
    ctx.stageReports.refCount = {
      status: "ran",
      durationMs: Date.now() - start,
      resultCount: ctx.results.length,
    };
  }
}

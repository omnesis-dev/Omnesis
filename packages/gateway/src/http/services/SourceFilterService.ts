// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import { runWithPriority } from "../../priority.js";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../errors.js";
import type {
  SourceScopeEditorReads,
  SourceScopeOptionsRequest,
  ScopeEditorResult,
} from "../../access/scope-editor-reads.js";
import type { ScopePolicy } from "@omnesis/types";

/** Bound interactive corpus scans even when the owner changes a query repeatedly. */
const MAX_CONCURRENT_EDITOR_READS = 4;
export class SourceFilterService {
  private active = 0;
  constructor(
    private readonly reads?: Partial<SourceScopeEditorReads>,
    private readonly canInspectSavedSource: (sourceId: string) => boolean = () => false,
  ) {}

  options(request: SourceScopeOptionsRequest) {
    return this.run(request.sourceId, () => this.reads!.sourceScopeOptions!(request));
  }
  preview(sourceId: string, policy: ScopePolicy) {
    return this.run(sourceId, () => this.reads!.sourceScopePreview!(sourceId, policy));
  }
  private async run<T>(sourceId: string, read: () => Promise<ScopeEditorResult<T>>): Promise<T> {
    if (!experimentalEnabled() && !this.canInspectSavedSource(sourceId))
      throw new NotFoundError("Source filter editing is not enabled.");
    if (!this.reads?.sourceScopeOptions || !this.reads.sourceScopePreview)
      throw new ServiceUnavailableError("Source filter editing requires an available read worker.");
    if (this.active >= MAX_CONCURRENT_EDITOR_READS)
      throw new ServiceUnavailableError("Filter previews are busy. Try again shortly.");
    this.active++;
    try {
      const result = await runWithPriority("user", read);
      if (result.ok) return result.value;
      if (result.error === "source-not-found")
        throw new NotFoundError("Source filter metadata was not found.");
      throw new BadRequestError(result.error);
    } finally {
      this.active--;
    }
  }
}

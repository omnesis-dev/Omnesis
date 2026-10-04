// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { HttpError } from "../errors.js";
import { directFindResults, browserFindSuggestions } from "../../search/find/direct-results.js";
import { getUrlCanonicalizerSpecs } from "../../url-canonicalizers.js";
import { getSourceAttributions } from "../../source-attributions.js";
import { BrowserAuthorizationService } from "./BrowserAuthorizationService.js";
import type { SearchPipeline } from "../../search/pipeline.js";
import type { AuthContext } from "../routes/types.js";

/** Search uses the ordinary read scope; browser identity selectors are optional metadata. */
export class BrowserFindService extends BrowserAuthorizationService {
  constructor(
    private readonly findDeps: ConstructorParameters<typeof BrowserAuthorizationService>[0] & {
      sourceLabels: () => Record<string, string>;
      sourceIcons: () => Record<string, string>;
      searchPipeline?: Pick<SearchPipeline, "search">;
    },
  ) {
    super(findDeps);
  }
  requireActive(auth: AuthContext): void {
    this.browser(auth, "read");
  }
  async suggest(auth: AuthContext, input: { text: string; limit: number }, signal: AbortSignal) {
    this.requireActive(auth);
    signal.throwIfAborted();
    if (!this.findDeps.searchPipeline)
      throw new HttpError(503, "SEARCH_UNAVAILABLE", "The search index is unavailable");
    const response = await this.findDeps.searchPipeline.search(
      { text: input.text, limit: 50 },
      undefined,
      { prefixLastToken: true },
    );
    signal.throwIfAborted();
    this.requireActive(auth);
    return {
      results: browserFindSuggestions(
        directFindResults(response.results),
        input.limit,
        getUrlCanonicalizerSpecs(),
      ),
    };
  }
  override status(auth: AuthContext) {
    this.requireActive(auth);
    return {
      enabled: true,
      sourceLabels: this.findDeps.sourceLabels(),
      sourceIcons: this.findDeps.sourceIcons(),
      sourceAttributions: getSourceAttributions(),
      canonicalizers: getUrlCanonicalizerSpecs()
        .filter((spec) => spec.browserIdentity)
        .map((spec) => ({ hosts: spec.hosts, rules: [], browserIdentity: spec.browserIdentity })),
    };
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { getUrlCanonicalizerSpecs } from "../../url-canonicalizers.js";
import { getSourceAttributions } from "../../source-attributions.js";
import { BrowserAuthorizationService } from "./BrowserAuthorizationService.js";
import type { AuthContext } from "../routes/types.js";

/** Search uses the ordinary read scope; browser identity selectors are optional metadata. */
export class BrowserFindService extends BrowserAuthorizationService {
  constructor(
    private readonly findDeps: ConstructorParameters<typeof BrowserAuthorizationService>[0] & {
      sourceLabels: () => Record<string, string>;
    },
  ) {
    super(findDeps);
  }
  requireActive(auth: AuthContext): void {
    this.browser(auth, "read");
  }
  override status(auth: AuthContext) {
    this.requireActive(auth);
    return {
      enabled: true,
      sourceLabels: this.findDeps.sourceLabels(),
      sourceAttributions: getSourceAttributions(),
      canonicalizers: getUrlCanonicalizerSpecs()
        .filter((spec) => spec.browserIdentity)
        .map((spec) => ({ hosts: spec.hosts, rules: [], browserIdentity: spec.browserIdentity })),
    };
  }
}

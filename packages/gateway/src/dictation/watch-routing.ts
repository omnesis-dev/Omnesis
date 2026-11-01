// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CaptureRoutingService } from "./capture-routing.js";

/** The Watch complication shares capture classification with its own setting. */
export class WatchRoutingService extends CaptureRoutingService {
  constructor(deps: ConstructorParameters<typeof CaptureRoutingService>[0]) {
    super({
      ...deps,
      fallbackToAsk: true,
      enabled: () => deps.getConfig()?.inference?.dictation?.useDecisionGateForWatch !== false,
    });
  }
}

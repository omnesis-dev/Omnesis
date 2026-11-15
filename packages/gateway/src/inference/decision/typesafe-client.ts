// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * TypeSafe System One client — the `typesafe/<model>` backend of the decision
 * capability: the System One client with TypeSafe's name in its errors and a
 * bearer key (optional for a self-hosted deployment).
 */

import { SystemOneDecision, type SystemOneDecisionOptions } from "./system-one-client.js";

export type TypeSafeDecisionOptions = Omit<
  SystemOneDecisionOptions,
  "protocol" | "auth" | "scoreField" | "label"
>;

export class TypeSafeDecision extends SystemOneDecision {
  constructor(opts: TypeSafeDecisionOptions) {
    super({ ...opts, protocol: "systemone", auth: "bearer", label: "TypeSafe" });
  }
}

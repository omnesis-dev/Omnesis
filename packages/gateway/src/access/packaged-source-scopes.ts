// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PACKAGED_SOURCE_SCOPES } from "./source-scope-catalog.generated.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import type { Db } from "../data/types.js";

/** Gateways can project existing metadata before their collectors are updated. */
export function seedPackagedSourceScopes(db: Db): void {
  upsertSourceScopes(db, PACKAGED_SOURCE_SCOPES, Date.now());
}

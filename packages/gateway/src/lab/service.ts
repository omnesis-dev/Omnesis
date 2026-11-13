// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, experimentalEnabled } from "@omnesis/core";
import { LAB_FEATURES } from "./catalog.js";
import { labFlags, labOptIns, type LabFeatureId } from "./store.js";
import type { WriteGate } from "../write-gate.js";
import type Database from "better-sqlite3";

export class LabService {
  constructor(
    private readonly db: Database.Database,
    private readonly writes: Pick<WriteGate, "setLabFlag">,
    private readonly changed?: () => Promise<void>,
  ) {}

  flags() {
    return labFlags(this.db);
  }

  snapshot() {
    const flags = labOptIns(this.db);
    return {
      experimental: experimentalEnabled(),
      features: LAB_FEATURES.map((feature) => ({ ...feature, enabled: flags[feature.id] })),
    };
  }

  async set(id: LabFeatureId, enabled: boolean) {
    await this.writes.setLabFlag(id, enabled);
    try {
      await this.changed?.();
    } catch (error) {
      createLogger("gateway:lab").warn(
        `Agent feature refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.snapshot();
  }
}

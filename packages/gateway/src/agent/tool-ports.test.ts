// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.js";
import { createGatewayAgentPorts, type GatewayAgentPortsDeps } from "./tool-ports.js";
import type { TemporalStoreReads } from "../enrichment/temporal/temporal-store-window.js";

afterEach(() => vi.unstubAllEnvs());

describe("createGatewayAgentPorts temporal reads", () => {
  it.each(["off", "check_stale_claims"] as const)(
    "uses the supplied worker reader with knowledge mode %s",
    async (mode) => {
      vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
      vi.stubEnv("OMNESIS_SYNTHETIC", "0");
      const db = createDatabase(":memory:");
      const sentinel = new Error("invented temporal worker unavailable");
      const temporalStoreWindow = vi.fn<TemporalStoreReads["temporalStoreWindow"]>(() =>
        Promise.reject(sentinel),
      );
      const deps: GatewayAgentPortsDeps & { temporalStoreReads: TemporalStoreReads } = {
        db,
        useBrainKnowledgeMode: mode,
        searchPipeline: {
          agentSearchV2Enabled: false,
        } as GatewayAgentPortsDeps["searchPipeline"],
        syncStatus: {} as GatewayAgentPortsDeps["syncStatus"],
        analyticsDb: {
          getTemporalProjectionCoverage: () => Promise.resolve([]),
          getTemporalSpecialistSources: () => Promise.resolve([]),
        } as unknown as GatewayAgentPortsDeps["analyticsDb"],
        isApnsConfigured: () => false,
        getWatchAuthoring: () => null,
        watchFirings: () => [],
        watchFiringCount: () => 0,
        temporalStoreReads: { temporalStoreWindow },
      };
      try {
        const ports = createGatewayAgentPorts(deps);
        expect(ports.temporal).toBeDefined();
        // Annotation-only queries need no analytics projection scan.
        // An empty real store would resolve; only the supplied reader rejects.
        await expect(
          ports.temporal!.query({
            from: "2011-04-05",
            timeZone: "UTC",
            origins: ["annotation"],
          }),
        ).rejects.toBe(sentinel);
        expect(temporalStoreWindow).toHaveBeenCalledOnce();
      } finally {
        db.close();
      }
    },
  );
});

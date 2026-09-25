// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  describeConfigSchema,
  flattenConfigNodes,
  CONFIG_PATHS_OWNED_ELSEWHERE,
  type ConfigNode,
  type ConfigLeafNode,
} from "./config-describe.js";
import { CONFIG_DEFAULTS, NO_STATIC_DEFAULT_PATHS, configDefaultAt } from "./config-defaults.js";
import { resolveSourceSettings, validateConfig } from "./config-schema.js";

// ───────────────────────────────────────────────────────────────────────────
// Drift net.
//
// The portal `/config` page is generated from this descriptor — every leaf
// below renders automatically, and every owned-elsewhere boundary is skipped.
// The inventory snapshot exists to FORCE A DECISION whenever the config schema
// gains or loses a knob: when this list changes, you must either (a) accept the
// new knob on /config (just update the list), or (b) declare it owned by
// another portal page in `CONFIG_PATHS_OWNED_ELSEWHERE` (then update the list).
// A new knob can never silently go missing from the page.
// ───────────────────────────────────────────────────────────────────────────

/** `${pointer} [${kind}{ owned:${page}}]`, sorted. Regenerate by reading the failure diff. */
const EXPECTED_INVENTORY = [
  "/activityRetention/maxAge [duration]",
  "/agent/conversationViewingTtl [duration]",
  "/agent/maxToolIterations [number]",
  "/agent/replay [object owned:Debug]",
  "/agent/subagentConcurrencyCap [number]",
  "/agent/subagentDepthCap [number]",
  "/agent/subagentTreeTokenBudget [number]",
  "/backupRetention/preUpdateCount [number]",
  "/brain/annotations/basisCeilings/inferred [number]",
  "/brain/annotations/basisCeilings/quoted [number]",
  "/brain/annotations/basisCeilings/synthesized [number]",
  "/brain/annotations/confidenceFloor [number]",
  "/brain/annotations/enabled [boolean]",
  "/brain/awarenessAxis [boolean]",
  "/brain/bootstrap/activeHours/from [string]",
  "/brain/bootstrap/activeHours/to [string]",
  "/brain/bootstrap/backlogTarget [number]",
  "/brain/bootstrap/batchSize [number]",
  "/brain/bootstrap/direction [enum]",
  "/brain/bootstrap/enabled [boolean]",
  "/brain/bootstrap/maxRuns [number]",
  "/brain/bootstrap/maxRunsPerDay [number]",
  "/brain/budget/dailyRuns [number]",
  "/brain/budget/dailyTokens [number]",
  "/brain/collision/annotationContradictions/enabled [boolean]",
  "/brain/collision/annotationContradictions/maxPerSweep [number]",
  "/brain/collision/cadenceHours [number]",
  "/brain/collision/enabled [boolean]",
  "/brain/collision/maxPerSweep [number]",
  "/brain/collision/timeHorizonDays [number]",
  "/brain/conversationDebounce [duration]",
  "/brain/conversationMaxDefer [duration]",
  "/brain/dailyRunHour [number]",
  "/brain/decay/backoffBase [duration]",
  "/brain/decay/backoffCap [duration]",
  "/brain/decay/datedFloor [duration]",
  "/brain/decay/datedFraction [number]",
  "/brain/derivationBarrier [duration]",
  "/brain/digest/enabled [boolean]",
  "/brain/digest/graceMinutes [number]",
  "/brain/digest/hour [number]",
  "/brain/digest/push [boolean]",
  "/brain/documentMaxDefer [duration]",
  "/brain/documentUpdateDebounce [duration]",
  "/brain/judge/enabled [boolean]",
  "/brain/mergeAdjudication/enabled [boolean]",
  "/brain/notesMaxBytes [number]",
  "/brain/provenanceRecheck/enabled [boolean]",
  "/brain/recencyWindow [duration]",
  "/brain/reverification/batchSize [number]",
  "/brain/reverification/enabled [boolean]",
  "/brain/reverification/intervalDays [number]",
  "/brain/reverification/maxPerSweep [number]",
  "/brain/sweeps [object owned:Sweeps]",
  "/brain/sweepsEnabled [boolean]",
  "/brain/synthesis/cadenceHours [number]",
  "/brain/synthesis/enabled [boolean]",
  "/brain/synthesis/maxPerDay [number]",
  "/brain/transcriptRetention [duration]",
  "/brain/workerConcurrency [number]",
  "/dataRetention/maxAge [duration]",
  "/enrichment/dates/batchSize [number]",
  "/enrichment/dates/enabled [boolean]",
  "/enrichment/dates/idlePeriodMs [number]",
  "/enrichment/dates/maxCharsPerDoc [number]",
  "/enrichment/dates/periodMs [number]",
  "/enrichment/dates/scanBudgetMs [number]",
  "/gateway/analyticsMemoryLimitMb [number]",
  "/gateway/analyticsStreamRekeyMaxRows [number]",
  "/gateway/analyticsThreads [number]",
  "/gateway/apns [object owned:Raw JSON]",
  "/gateway/audit/enabled [boolean]",
  "/gateway/audit/includeUnauthenticated [boolean]",
  "/gateway/backfill/autoDetect/interval [duration]",
  "/gateway/backfill/catalog/interval [duration]",
  "/gateway/backfill/interactionScores/idleDelay [duration]",
  "/gateway/backfill/interactionScores/interval [duration]",
  "/gateway/backfill/linkReconcile/batchSize [number]",
  "/gateway/backfill/linkReconcile/interval [duration]",
  "/gateway/backfill/linkStats/idleDelay [duration]",
  "/gateway/backfill/linkStats/interval [duration]",
  "/gateway/backfill/links/idleDelay [duration]",
  "/gateway/backfill/links/interval [duration]",
  "/gateway/backfill/mergeCandidates/idleDelay [duration]",
  "/gateway/backfill/mergeCandidates/interval [duration]",
  "/gateway/backfill/mergePass/interval [duration]",
  "/gateway/backfill/mergeRulesEval/idleDelay [duration]",
  "/gateway/backfill/mergeRulesEval/interval [duration]",
  "/gateway/backfill/people/batchSize [number]",
  "/gateway/backfill/people/idleDelay [duration]",
  "/gateway/backfill/people/interval [duration]",
  "/gateway/backfill/peopleCounts/interval [duration]",
  "/gateway/backfill/sourceStats/interval [duration]",
  "/gateway/backgroundWorkerNice [number]",
  "/gateway/cors/allowCredentials [boolean]",
  "/gateway/cors/allowedHeaders [stringArray]",
  "/gateway/cors/allowedMethods [stringArray]",
  "/gateway/cors/allowedOrigins [stringArray]",
  "/gateway/cors/maxAgeSeconds [number]",
  "/gateway/cpuConcurrency [number]",
  "/gateway/fcm [object owned:Raw JSON]",
  "/gateway/ingestYieldBatch [number]",
  "/gateway/ioConcurrency [number]",
  "/gateway/ioReservedUserSlots [number]",
  "/gateway/journalMode [enum]",
  "/gateway/mcpResourceUrls [stringArray]",
  "/gateway/mdns/enabled [boolean]",
  "/gateway/mdns/hostname [string]",
  "/gateway/mdns/serviceName [string]",
  "/gateway/minFreeDiskMb [number]",
  "/gateway/mobilePermissionReminders/initialDelay [duration]",
  "/gateway/mobilePermissionReminders/maxDelay [duration]",
  "/gateway/mobilePermissionReminders/maxStaleNotifications [number]",
  "/gateway/mobilePermissionReminders/multiplier [number]",
  "/gateway/mobilePermissionReminders/reservationTtl [duration]",
  "/gateway/mobilePermissionReminders/scanInterval [duration]",
  "/gateway/pairingSystemTrustOrigins [stringArray]",
  "/gateway/publicBaseUrl [string]",
  "/gateway/pushRelay/enabled [boolean]",
  "/gateway/pushRelay/url [string]",
  "/gateway/pushWakeRetry/batchSize [number]",
  "/gateway/pushWakeRetry/idleIntervalMs [number]",
  "/gateway/pushWakeRetry/initialBackoffMs [number]",
  "/gateway/pushWakeRetry/intervalMs [number]",
  "/gateway/pushWakeRetry/leaseMs [number]",
  "/gateway/pushWakeRetry/maxAttempts [number]",
  "/gateway/pushWakeRetry/maxBackoffMs [number]",
  "/gateway/readHandle/cacheSizeBytes [number]",
  "/gateway/readHandle/ioCacheSizeBytes [number]",
  "/gateway/reauthReminders/initialDelay [duration]",
  "/gateway/reauthReminders/maxDelay [duration]",
  "/gateway/reauthReminders/multiplier [number]",
  "/gateway/reauthReminders/reservationTtl [duration]",
  "/gateway/searchWorker/cacheSizeBytes [number]",
  "/gateway/searchWorker/concurrency [number]",
  "/gateway/searchWorker/maxInflightBeforeFallback [number]",
  "/gateway/sharedAddressDemotion/maxEmails [number]",
  "/gateway/sharedAddressDemotion/nameThreshold [number]",
  "/gateway/snapshotAbsence/deletionGrace [duration]",
  "/gateway/snapshotAbsence/maxMarksPerSnapshot [number]",
  "/gateway/snapshotAbsence/minAge [duration]",
  "/gateway/snapshotAbsence/minObservations [number]",
  "/gateway/subscriptions/deliveryBaseBackoffMs [number]",
  "/gateway/subscriptions/deliveryMaxBackoffMs [number]",
  "/gateway/subscriptions/maxDeliveryAttempts [number]",
  "/gateway/subscriptions/semanticMinimumScore [number]",
  "/gateway/timings/authFlowTtl [duration]",
  "/gateway/timings/pairingTtl [duration]",
  "/gateway/timings/sessionRefreshThrottle [duration]",
  "/gateway/timings/sessionTtl [duration]",
  "/gateway/timings/slowRequest [duration]",
  "/gateway/timings/wsAuthTimeout [duration]",
  "/gateway/timings/wsCommandTimeout [duration]",
  "/gateway/timings/wsHeartbeatInterval [duration]",
  "/gateway/tls/autoRenew [boolean]",
  "/gateway/tls/renewBeforeDays [number]",
  "/gateway/watch/batchSize [number]",
  "/gateway/watch/compileReasoningTokens [number]",
  "/gateway/watch/compileTimeoutMs [number]",
  "/gateway/watch/delivery/dailyCap [number]",
  "/gateway/watch/delivery/perWatchDailyCap [number]",
  "/gateway/watch/drainIntervalMs [number]",
  "/gateway/watch/evaluateIntervalMs [number]",
  "/gateway/watch/eventsPerWatch [number]",
  "/gateway/watch/idleEvaluateIntervalMs [number]",
  "/gateway/watch/idleIntervalMs [number]",
  "/gateway/watch/judge/dailyCap [number]",
  "/gateway/watch/judge/perWatchDailyCap [number]",
  "/gateway/watch/promptPeople [number]",
  "/gateway/watch/queueCapacity [number]",
  "/gateway/watch/traceRetained [number]",
  "/gateway/watch/wake/dailyCap [number]",
  "/gateway/watch/wake/perWatchDailyCap [number]",
  "/gateway/watchV2/batchSize [number]",
  "/gateway/watchV2/compileReasoningTokens [number]",
  "/gateway/watchV2/compileTimeoutMs [number]",
  "/gateway/watchV2/delivery/dailyCap [number]",
  "/gateway/watchV2/delivery/perWatchDailyCap [number]",
  "/gateway/watchV2/drainIntervalMs [number]",
  "/gateway/watchV2/evaluateIntervalMs [number]",
  "/gateway/watchV2/eventsPerWatch [number]",
  "/gateway/watchV2/idleEvaluateIntervalMs [number]",
  "/gateway/watchV2/idleIntervalMs [number]",
  "/gateway/watchV2/judge/dailyCap [number]",
  "/gateway/watchV2/judge/perWatchDailyCap [number]",
  "/gateway/watchV2/promptPeople [number]",
  "/gateway/watchV2/queueCapacity [number]",
  "/gateway/watchV2/traceRetained [number]",
  "/gateway/watchV2/wake/dailyCap [number]",
  "/gateway/watchV2/wake/perWatchDailyCap [number]",
  "/indexer/betweenPageSleep [duration]",
  "/indexer/chunker/chunkSize [number]",
  "/indexer/chunker/overlap [number]",
  "/indexer/cycleBacklogInterval [duration]",
  "/indexer/cycleInterval [duration]",
  "/indexer/dbWriteBatchSize [number]",
  "/indexer/embedConcurrency [number]",
  "/indexer/embedder/contextSize [number]",
  "/indexer/embedder/maxInputChars [number]",
  "/indexer/embedder/timeoutMs [number]",
  "/indexer/pageSize [number]",
  "/indexer/reconcileInterval [duration]",
  "/indexer/reindexMissingAtBoot [boolean]",
  "/indexer/reindexMissingInterval [duration]",
  "/inference [object owned:Models]",
  "/multiDevice/leaseTtl [duration]",
  "/nearDuplicates/algorithm/bands [number]",
  "/nearDuplicates/algorithm/hashSeed [number]",
  "/nearDuplicates/algorithm/maxIdfWeight [number]",
  "/nearDuplicates/algorithm/numHashes [number]",
  "/nearDuplicates/algorithm/recordThreshold [number]",
  "/nearDuplicates/algorithm/rows [number]",
  "/nearDuplicates/algorithm/shingleSize [number]",
  "/nearDuplicates/algorithm/stripQuotes [boolean]",
  "/nearDuplicates/eligibleDocTypes [stringArray]",
  "/nearDuplicates/enabled [boolean]",
  "/nearDuplicates/fileLikeDocTypes [stringArray]",
  "/nearDuplicates/gate/automatedSenderPrefixes [stringArray]",
  "/nearDuplicates/gate/emailJaccardMin [number]",
  "/nearDuplicates/gate/emailPairUniqueDf2Min [number]",
  "/nearDuplicates/gate/fileLikeContainmentMin [number]",
  "/nearDuplicates/gate/fileLikeJaccardMin [number]",
  "/nearDuplicates/gate/fileLikePairUniqueDf2Min [number]",
  "/nearDuplicates/maxContentLength [number]",
  "/nearDuplicates/minContentLength [number]",
  "/nearDuplicates/scheduler/algoSweepChunkSize [number]",
  "/nearDuplicates/scheduler/algoSweepStepsPerTick [number]",
  "/nearDuplicates/scheduler/computeBatchSize [number]",
  "/nearDuplicates/scheduler/computeIdlePeriodMs [number]",
  "/nearDuplicates/scheduler/computePeriodMs [number]",
  "/nearDuplicates/scheduler/dfMaxAgeMs [number]",
  "/nearDuplicates/scheduler/dfQuietHourLocal [number]",
  "/nearDuplicates/scheduler/dfRefreshIdlePeriodMs [number]",
  "/nearDuplicates/scheduler/dfRefreshPeriodMs [number]",
  "/nearDuplicates/scheduler/maxCandidatesPerDoc [number]",
  "/nearDuplicates/scheduler/sweepChunkSize [number]",
  "/nearDuplicates/scheduler/sweepIdlePeriodMs [number]",
  "/nearDuplicates/scheduler/sweepPeriodMs [number]",
  "/releaseCheck [boolean]",
  "/search/bm25/commonTokenThreshold [number]",
  "/search/boosts/relevanceBoostWeight [number]",
  "/search/boosts/typeBoosts/* [number]",
  "/search/defaultFilters/dateFrom [string]",
  "/search/defaultFilters/dateTo [string]",
  "/search/defaultFilters/documentTypes [stringArray]",
  "/search/defaultFilters/sourceIds [stringArray]",
  "/search/defaultFilters/tags [stringArray]",
  "/search/diversity/bucketBy [enum]",
  "/search/diversity/enabled [boolean]",
  "/search/diversity/lambda [number]",
  "/search/diversity/maxPerSourceInTopK [number]",
  "/search/diversity/topK [number]",
  "/search/embedderPrefixes/enabled [boolean]",
  "/search/params/bm25Weight [number]",
  "/search/params/candidateLimit [number]",
  "/search/params/nearTopRankBonus [number]",
  "/search/params/resultLimit [number]",
  "/search/params/rrfK [number]",
  "/search/params/topRankBonus [number]",
  "/search/params/vectorWeight [number]",
  "/search/readHandle/cacheSizeBytes [number]",
  "/search/readHandle/mmapBytes [number]",
  "/search/readHandle/prewarm [boolean]",
  "/search/snapshot/enabled [boolean]",
  "/search/snapshot/refreshIntervalMs [number]",
  "/search/sourcePriors/autoInverseFrequency/enabled [boolean]",
  "/search/sourcePriors/autoInverseFrequency/strength [number]",
  "/search/sourcePriors/bm25BypassRank [number]",
  "/search/sourcePriors/weights/* [number]",
  "/search/vector/alwaysOverFetch [boolean]",
  "/search/vector/hnswOverFetch [number]",
  "/self/emails [stringArray]",
  "/self/name [string]",
  "/self/phones [stringArray]",
  "/sources/*/attachmentMaxSizeBytes [number]",
  "/sources/*/attachmentMaxTextLength [number]",
  "/sources/*/attachmentTypes [stringArray]",
  "/sources/*/extractAttachments [boolean]",
  "/sources/*/maxAge [duration]",
  "/sources/*/params [object owned:Sources]",
  "/sources/*/syncInterval [duration]",
];

function inventoryLine(entry: { path: string; kind: string; ownedBy?: string }): string {
  return `${entry.path} [${entry.kind}${entry.ownedBy ? ` owned:${entry.ownedBy}` : ""}]`;
}

/** Collect every non-owned leaf node (the nodes the page renders as fields). */
function renderedLeaves(node: ConfigNode, acc: ConfigLeafNode[] = []): ConfigLeafNode[] {
  if (node.ownedBy) return acc;
  if (node.kind === "object") {
    for (const child of node.children) renderedLeaves(child, acc);
    return acc;
  }
  if (node.kind === "record") {
    renderedLeaves(node.value, acc);
    return acc;
  }
  acc.push(node);
  return acc;
}

describe("describeConfigSchema", () => {
  it("matches the config knob inventory (update when you add/remove/relocate a knob)", () => {
    const actual = flattenConfigNodes().map(inventoryLine).sort();
    expect(actual).toEqual(EXPECTED_INVENTORY);
  });

  it("renders every config knob that isn't owned by another portal page", () => {
    // By construction the generated page renders exactly the non-owned leaves.
    // This guards the inverse: nothing rendered is also declared owned-elsewhere.
    const flat = flattenConfigNodes();
    const ownedPointers = new Set(flat.filter((f) => f.ownedBy).map((f) => f.path));
    const renderedPointers = renderedLeaves(describeConfigSchema()).map(
      (n) => "/" + n.path.join("/"),
    );
    for (const p of renderedPointers) {
      expect(ownedPointers.has(p)).toBe(false);
    }
  });

  it("has no stale ownership entries — every owned path matches a real schema node", () => {
    const ownedPointers = new Set(
      flattenConfigNodes()
        .filter((f) => f.ownedBy)
        .map((f) => f.path),
    );
    for (const entry of CONFIG_PATHS_OWNED_ELSEWHERE) {
      const pointer = "/" + entry.path.join("/");
      expect(ownedPointers, `ownership entry "${pointer}" matches nothing`).toContain(pointer);
    }
  });

  it("gives every rendered leaf a .describe() hint", () => {
    const missing = renderedLeaves(describeConfigSchema())
      .filter((n) => !n.description)
      .map((n) => "/" + n.path.join("/"));
    expect(missing, `add .describe() to: ${missing.join(", ")}`).toEqual([]);
  });

  it("classifies leaf kinds + constraints from the zod schema", () => {
    const byPath = new Map(
      renderedLeaves(describeConfigSchema()).map((n) => ["/" + n.path.join("/"), n]),
    );

    const cycle = byPath.get("/indexer/cycleInterval");
    expect(cycle?.kind).toBe("duration");

    const journal = byPath.get("/gateway/journalMode");
    expect(journal?.kind).toBe("enum");
    expect(journal?.options).toEqual(["WAL", "TRUNCATE"]);

    const batch = byPath.get("/indexer/dbWriteBatchSize");
    expect(batch?.kind).toBe("number");
    expect(batch?.constraints?.int).toBe(true);
    expect(batch?.constraints?.exclusiveMin).toBe(0);

    const threshold = byPath.get("/search/bm25/commonTokenThreshold");
    expect(threshold?.constraints?.min).toBe(0);
    expect(threshold?.constraints?.max).toBe(1);

    const allowedOrigins = byPath.get("/gateway/cors/allowedOrigins");
    expect(allowedOrigins?.kind).toBe("stringArray");

    const preUpdateCount = byPath.get("/backupRetention/preUpdateCount");
    expect(preUpdateCount?.kind).toBe("number");
    expect(preUpdateCount?.constraints?.int).toBe(true);
    expect(preUpdateCount?.constraints?.min).toBe(0);
    expect(preUpdateCount?.default).toBe(2);
    expect(preUpdateCount?.description).toContain("set to 0 to disable automatic pruning");
  });

  it("truncates owned subtrees — no rendered leaf lives under an owned path", () => {
    const rendered = renderedLeaves(describeConfigSchema()).map((n) => "/" + n.path.join("/"));
    for (const prefix of [
      "/inference",
      "/sources/*/params",
      "/agent/replay",
      "/gateway/apns",
      "/gateway/fcm",
    ]) {
      const leaked = rendered.filter((p) => p === prefix || p.startsWith(prefix + "/"));
      expect(leaked, `owned subtree ${prefix} leaked rendered leaves`).toEqual([]);
    }
  });

  it("walks record nesting (search → boosts → typeBoosts)", () => {
    const entry = flattenConfigNodes().find((f) => f.path === "/search/boosts/typeBoosts/*");
    expect(entry, "a record value nested under an object should flatten to a leaf").toBeDefined();
    expect(entry?.kind).toBe("number");
  });

  // ─── Defaults coverage ───────────────────────────────────────────────────
  // Every fixed-shape (non-record-template) rendered leaf must declare its
  // effective default so the form can show what "unset" does — or be listed in
  // NO_STATIC_DEFAULT_PATHS. A new knob added without a default fails here,
  // forcing the same conscious decision the inventory snapshot does for
  // rendering. (The cross-check that these values match the live runtime
  // resolvers lives in the gateway package.)

  /** Rendered fixed-shape leaves (no `*` record slot in the path). */
  function fixedShapeLeaves(): ConfigLeafNode[] {
    return renderedLeaves(describeConfigSchema()).filter((n) => !n.path.includes("*"));
  }

  it("gives every fixed-shape leaf a default (or lists it as having none)", () => {
    const allow = new Set(NO_STATIC_DEFAULT_PATHS);
    const missing = fixedShapeLeaves()
      .filter((n) => n.default === undefined && !allow.has("/" + n.path.join("/")))
      .map((n) => "/" + n.path.join("/"));
    expect(
      missing,
      `add a CONFIG_DEFAULTS entry (or NO_STATIC_DEFAULT_PATHS) for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no stale NO_STATIC_DEFAULT_PATHS — each names a real defaultless leaf", () => {
    const byPath = new Map(fixedShapeLeaves().map((n) => ["/" + n.path.join("/"), n]));
    for (const p of NO_STATIC_DEFAULT_PATHS) {
      const node = byPath.get(p);
      expect(
        node,
        `NO_STATIC_DEFAULT_PATHS entry "${p}" matches no fixed-shape leaf`,
      ).toBeDefined();
      expect(node?.default, `"${p}" is allowlisted but also has a default`).toBeUndefined();
    }
  });

  it("explains every rendered leaf that has no literal default", () => {
    const unexplained = renderedLeaves(describeConfigSchema())
      .filter((n) => n.default === undefined && !n.unsetDescription)
      .map((n) => "/" + n.path.join("/"));
    expect(unexplained, `describe unset behavior for: ${unexplained.join(", ")}`).toEqual([]);
  });

  it("describes every source-setting precedence tier without making sources.default inherit itself", () => {
    const byPath = new Map(
      renderedLeaves(describeConfigSchema()).map((node) => ["/" + node.path.join("/"), node]),
    );
    const sync = byPath.get("/sources/*/syncInterval")?.unsetDescription;
    const maxAge = byPath.get("/sources/*/maxAge")?.unsetDescription;

    expect(sync).toContain("account setting, source-type setting, sources.default.syncInterval");
    expect(sync).toContain("OMNESIS_SYNC_INTERVAL");
    expect(sync).toContain("5 minutes");
    expect(sync).not.toMatch(/inherits sources\.default/i);
    expect(maxAge).toContain("account setting, source-type setting, sources.default.maxAge");
    expect(maxAge).toContain("dataRetention.maxAge");
    expect(maxAge).toContain("no age limit");
    expect(maxAge).not.toMatch(/inherits sources\.default/i);

    const config = {
      sources: {
        default: { syncInterval: "30m", extractAttachments: false },
        gmail: { syncInterval: "15m" },
        "gmail:maya@example.com": { syncInterval: "5m" },
      },
    };
    expect(resolveSourceSettings(config, "gmail:maya@example.com")).toMatchObject({
      syncInterval: "5m",
      extractAttachments: false,
    });
    expect(resolveSourceSettings(config, "gmail:jamie@example.org")).toMatchObject({
      syncInterval: "15m",
      extractAttachments: false,
    });
    expect(resolveSourceSettings(config, "notion:maya@example.com")).toMatchObject({
      syncInterval: "30m",
      extractAttachments: false,
    });
  });

  it("CONFIG_DEFAULTS validates against the config schema", () => {
    const res = validateConfig(CONFIG_DEFAULTS);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.errors)).toBe(true);
  });

  it("every CONFIG_DEFAULTS value lands on a real rendered leaf of a compatible kind", () => {
    const byPath = new Map(fixedShapeLeaves().map((n) => ["/" + n.path.join("/"), n]));
    for (const node of fixedShapeLeaves()) {
      const def = configDefaultAt(node.path);
      if (def === undefined) continue;
      const t = typeof def;
      const ok =
        (node.kind === "boolean" && t === "boolean") ||
        (node.kind === "number" && t === "number") ||
        (node.kind === "stringArray" &&
          Array.isArray(def) &&
          def.every((value) => typeof value === "string")) ||
        ((node.kind === "string" || node.kind === "duration" || node.kind === "enum") &&
          t === "string");
      expect(ok, `default for /${node.path.join("/")} (${t}) mismatches kind ${node.kind}`).toBe(
        true,
      );
    }
    // sanity: the map was actually exercised
    expect(byPath.size).toBeGreaterThan(0);
  });
});

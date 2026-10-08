// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Reader-side impact planning. Shared aggregates are scheduled after their inputs commit. */

export type MaintenanceTier = "immediate" | "soon" | "routine";

export interface MaintenanceSeed {
  id: string;
  revision: string;
  /** The oldest unprocessed change anchors the deadline; later edits cannot postpone it. */
  changedAt: number;
  dueAt: number;
  tier: MaintenanceTier;
  /** Existing dependency targets plus retrieval-discovered candidate nodes. */
  targets: readonly string[];
}

export interface MaintenanceArc {
  input: string;
  dependent: string;
}

export type MaintenanceAdjacency = (input: string) => readonly string[];

export interface MaintenanceGroup {
  seeds: MaintenanceSeed[];
  nodes: string[];
  aggregates: string[];
  dueAt: number;
  tier: MaintenanceTier;
}

export interface MaintenancePlanLimits {
  maxSeeds: number;
  maxVisitedPerSeed: number;
}

/** Exceeding a bound must leave work pending, never mark an incomplete region processed. */
export class MaintenancePlanLimitError extends Error {
  constructor(
    readonly limit: "seeds" | "region",
    readonly seedId?: string,
  ) {
    super(`Maintenance ${limit} limit exceeded`);
    this.name = "MaintenancePlanLimitError";
  }
}

const tierRank: Record<MaintenanceTier, number> = { immediate: 0, soon: 1, routine: 2 };

function adjacency(arcs: readonly MaintenanceArc[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const arc of arcs) {
    let targets = result.get(arc.input);
    if (!targets) result.set(arc.input, (targets = new Set()));
    targets.add(arc.dependent);
  }
  return result;
}

/**
 * Includes future seeds so an urgent overlapping change promotes already queued inputs.
 * Callers select due groups only AFTER computing connected coordination components.
 */
export function planMaintenanceGroups(
  seeds: readonly MaintenanceSeed[],
  arcs: readonly MaintenanceArc[] | MaintenanceAdjacency,
  aggregateIds: ReadonlySet<string>,
  limits: MaintenancePlanLimits,
): MaintenanceGroup[] {
  if (seeds.length > limits.maxSeeds) throw new MaintenancePlanLimitError("seeds");
  const indexed = typeof arcs === "function" ? null : adjacency(arcs);
  const downstream: MaintenanceAdjacency =
    typeof arcs === "function" ? arcs : (id) => [...(indexed!.get(id) ?? [])];
  const regions = seeds.map((seed) => {
    const nodes = new Set<string>();
    const aggregates = new Set<string>();
    const queued = new Set(seed.targets);
    const pending = [...queued];
    const visited = new Set<string>();
    for (let at = 0; at < pending.length; at++) {
      const id = pending[at]!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (visited.size > limits.maxVisitedPerSeed)
        throw new MaintenancePlanLimitError("region", seed.id);
      if (aggregateIds.has(id)) {
        aggregates.add(id);
        continue;
      }
      nodes.add(id);
      let targets: readonly string[];
      try {
        targets = downstream(id);
      } catch (error) {
        if (error instanceof MaintenancePlanLimitError)
          throw new MaintenancePlanLimitError(error.limit, seed.id);
        throw error;
      }
      for (const target of targets) {
        if (!queued.has(target)) {
          queued.add(target);
          pending.push(target);
        }
        if (pending.length > limits.maxVisitedPerSeed)
          throw new MaintenancePlanLimitError("region", seed.id);
      }
    }
    return { seed, nodes, aggregates };
  });

  // Union by shared repair target. Merely sharing a downstream aggregate is not an edge here.
  const parents = regions.map((_, index) => index);
  function root(index: number): number {
    let current = index;
    while (parents[current] !== current) current = parents[current]!;
    while (index !== current) {
      const next = parents[index]!;
      parents[index] = current;
      index = next;
    }
    return current;
  }
  const firstOwner = new Map<string, number>();
  regions.forEach((region, index) => {
    // Revision changes of the same evidence identity must be coordinated even without edges.
    const keys = [`seed:${region.seed.id}`, ...[...region.nodes].map((id) => `node:${id}`)];
    for (const key of keys) {
      const owner = firstOwner.get(key);
      if (owner === undefined) firstOwner.set(key, index);
      else parents[root(index)] = root(owner);
    }
  });

  const groups = new Map<
    number,
    { seeds: MaintenanceSeed[]; nodes: Set<string>; aggregates: Set<string> }
  >();
  regions.forEach((region, index) => {
    const key = root(index);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { seeds: [], nodes: new Set(), aggregates: new Set() }));
    group.seeds.push(region.seed);
    for (const id of region.nodes) group.nodes.add(id);
    for (const id of region.aggregates) group.aggregates.add(id);
  });
  return [...groups.values()]
    .map((group) => ({
      seeds: group.seeds.sort((a, b) => a.changedAt - b.changedAt || a.id.localeCompare(b.id)),
      nodes: [...group.nodes].sort(),
      aggregates: [...group.aggregates].sort(),
      dueAt: Math.min(...group.seeds.map((seed) => seed.dueAt)),
      tier: group.seeds.reduce<MaintenanceTier>(
        (tier, seed) => (tierRank[seed.tier] < tierRank[tier] ? seed.tier : tier),
        "routine",
      ),
    }))
    .sort((a, b) => a.dueAt - b.dueAt || a.seeds[0]!.id.localeCompare(b.seeds[0]!.id));
}

export interface CompletedMaintenanceNode {
  id: string;
  outcome: "skipped" | "unchanged" | "changed";
}

/** Expands only changed paths. Processed-version filtering belongs to the durable run store. */
export function expandMaintenanceFrontier(
  completed: readonly CompletedMaintenanceNode[],
  arcs: readonly MaintenanceArc[],
  aggregateIds: ReadonlySet<string>,
): { nodes: string[]; aggregates: string[] } {
  const changed = new Set(
    completed.filter((node) => node.outcome === "changed").map((node) => node.id),
  );
  const nodes = new Set<string>();
  const aggregates = new Set<string>();
  for (const arc of arcs) {
    if (!changed.has(arc.input)) continue;
    (aggregateIds.has(arc.dependent) ? aggregates : nodes).add(arc.dependent);
  }
  return { nodes: [...nodes].sort(), aggregates: [...aggregates].sort() };
}

export interface UrgencyPolicy {
  immediateThreshold: number;
  soonThreshold: number;
  soonDelayMs: number;
  routineDelayMs: number;
}

/** Missing decision evidence takes the sooner bounded tier; explicit user urgency wins. */
export function scheduleKnowledgeChange(
  score: number | null,
  changedAt: number,
  policy: UrgencyPolicy,
  immediate = false,
): { tier: MaintenanceTier; dueAt: number } {
  if (
    immediate ||
    (score !== null && Number.isFinite(score) && score >= policy.immediateThreshold)
  ) {
    return { tier: "immediate", dueAt: changedAt };
  }
  if (score === null || !Number.isFinite(score) || score >= policy.soonThreshold) {
    return { tier: "soon", dueAt: changedAt + policy.soonDelayMs };
  }
  return { tier: "routine", dueAt: changedAt + policy.routineDelayMs };
}

export interface ReviewScheduleInput {
  now: number;
  lastVerifiedAt: number | null;
  createdAt: number;
  proposedAt: number | null;
  checkpointAt: number | null;
  maxIntervalMs: number;
  checkpointLeadMs: number;
}

/** Dormancy and model deferral cannot exceed a verification-age or checkpoint safeguard. */
export function boundKnowledgeReview(input: ReviewScheduleInput): number {
  const maximum = (input.lastVerifiedAt ?? input.createdAt) + input.maxIntervalMs;
  const checkpoint =
    input.checkpointAt === null
      ? Number.POSITIVE_INFINITY
      : input.checkpointAt - input.checkpointLeadMs;
  return Math.max(input.now, Math.min(input.proposedAt ?? maximum, maximum, checkpoint));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as z from "zod/v4";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";

import type { Db } from "../data/types.js";
import type { AccessCapability, AccessGrantCapability, AccessGrantRuleInput } from "./types.js";

/**
 * Access rules: the shape grants and levels store, how supplied rules are
 * normalized and checked against what they name, and how stored rows are read
 * back. Grants and levels keep identical capability rows, so every reader and
 * writer of either goes through here.
 */

/** Rules as the writers store and compare them: no derived policy fields. */
export type StoredGrantRules = Array<
  Omit<AccessGrantCapability, "privacyPolicy" | "policyRevision">
>;

const sourcesSchema = z
  .strictObject({
    mode: z.enum(["all", "allowlist", "denylist"]),
    sourceIds: z.array(z.string().min(1).max(512)).max(256),
  })
  .refine((value) => value.mode !== "allowlist" || value.sourceIds.length > 0);
const notesSourcesSchema = z.strictObject({
  mode: z.literal("all"),
  sourceIds: z.array(z.string()).length(0),
});
const grantRuleSchema = z.discriminatedUnion("capability", [
  z.strictObject({ capability: z.literal("direct"), sources: sourcesSchema }),
  z.strictObject({ capability: z.literal("notes"), sources: notesSourcesSchema }),
  z.strictObject({
    capability: z.literal("answer"),
    sources: sourcesSchema,
    release: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("reviewed"), policyFamilyId: z.string().uuid() }),
      z.strictObject({ mode: z.literal("unreviewed") }),
    ]),
  }),
]);
export const grantRulesSchema = z
  .array(grantRuleSchema)
  .min(1)
  .max(3)
  .refine((rules) => new Set(rules.map((rule) => rule.capability)).size === rules.length);

export function getGrantCapabilities(db: Db, grantId: string): AccessGrantCapability[] {
  return readCapabilities(db, "access_grant_capabilities", "grant_id", grantId);
}

export function getLevelCapabilities(db: Db, levelId: string): AccessGrantCapability[] {
  return readCapabilities(db, "access_level_capabilities", "level_id", levelId);
}

/**
 * A level's rules read from its rows alone, without the policy state
 * `getLevelCapabilities` joins in, so a level whose reviewed policy has no
 * current revision still yields the rules it holds. Empty only for a level
 * with no rows, or a row no rule can describe.
 */
export function readLevelRuleInputs(db: Db, levelId: string): AccessGrantRuleInput[] {
  const rows = db
    .prepare<[string], CapabilityRow>(
      `SELECT capability, source_mode, source_ids, release_mode, policy_family_id
         FROM access_level_capabilities WHERE level_id = ? ORDER BY capability`,
    )
    .all(levelId);
  const rules: AccessGrantRuleInput[] = [];
  for (const row of rows) {
    const sourceIds = parseStringArray(row.source_ids);
    if (
      sourceIds === null ||
      !validStoredRule(
        row.capability,
        row.source_mode,
        sourceIds,
        row.release_mode,
        row.policy_family_id,
      )
    ) {
      return [];
    }
    rules.push(
      capabilityToRule({
        capability: row.capability,
        sourceMode: row.source_mode,
        sourceIds,
        releaseMode: row.release_mode,
        policyFamilyId: row.policy_family_id,
        policyRevision: null,
        privacyPolicy: null,
      }),
    );
  }
  return rules;
}

/** Capabilities in the shape the writers store and compare: no derived policy fields. */
export function storedRuleShape(capabilities: readonly AccessGrantCapability[]): StoredGrantRules {
  return capabilities.map(({ privacyPolicy: _legacy, policyRevision: _revision, ...rule }) => rule);
}

export function capabilityToRule(capability: AccessGrantCapability): AccessGrantRuleInput {
  const sources = { mode: capability.sourceMode, sourceIds: capability.sourceIds };
  if (capability.capability !== "answer") return { capability: capability.capability, sources };
  return capability.releaseMode === "reviewed" && capability.policyFamilyId
    ? {
        capability: "answer",
        sources,
        release: { mode: "reviewed", policyFamilyId: capability.policyFamilyId },
      }
    : { capability: "answer", sources, release: { mode: "unreviewed" } };
}

interface CapabilityRow {
  capability: AccessCapability;
  source_mode: "all" | "allowlist" | "denylist";
  source_ids: string;
  release_mode: "reviewed" | "unreviewed" | null;
  policy_family_id: string | null;
}

function readCapabilities(
  db: Db,
  table: "access_grant_capabilities" | "access_level_capabilities",
  keyColumn: "grant_id" | "level_id",
  id: string,
): AccessGrantCapability[] {
  const rows = db
    .prepare<[string], CapabilityRow & { policy_revision: string | null }>(
      `SELECT c.capability, c.source_mode, c.source_ids, c.release_mode, c.policy_family_id,
              s.revision AS policy_revision
       FROM ${table} c
       LEFT JOIN privacy_policy_state s ON s.family_id = c.policy_family_id
       WHERE c.${keyColumn} = ? ORDER BY c.capability`,
    )
    .all(id);
  const capabilities: AccessGrantCapability[] = [];
  for (const row of rows) {
    const sourceIds = parseStringArray(row.source_ids);
    if (
      sourceIds === null ||
      !validStoredRule(
        row.capability,
        row.source_mode,
        sourceIds,
        row.release_mode,
        row.policy_family_id,
      ) ||
      (row.release_mode === "reviewed" && row.policy_revision === null)
    ) {
      return [];
    }
    capabilities.push({
      capability: row.capability,
      sourceMode: row.source_mode,
      sourceIds,
      releaseMode: row.release_mode,
      policyFamilyId: row.policy_family_id,
      policyRevision: row.policy_revision,
      privacyPolicy:
        row.capability === "answer" && row.release_mode === "reviewed"
          ? row.policy_family_id === DEFAULT_PRIVACY_POLICY_FAMILY_ID
            ? "default"
            : row.policy_family_id
          : null,
    });
  }
  return capabilities;
}

export function normalizeGrantRules(
  suppliedRules: readonly AccessGrantRuleInput[],
): StoredGrantRules {
  const raw = suppliedRules;
  const parsed = grantRulesSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid access grant rules.");
  const rules = parsed.data.map((rule) => {
    const sourceIds = [...new Set(rule.sources.sourceIds)].sort();
    return {
      capability: rule.capability,
      sourceMode:
        rule.sources.mode === "denylist" && sourceIds.length === 0
          ? ("all" as const)
          : rule.sources.mode,
      sourceIds,
      releaseMode: rule.capability === "answer" ? rule.release.mode : null,
      policyFamilyId:
        rule.capability === "answer" && rule.release.mode === "reviewed"
          ? rule.release.policyFamilyId
          : null,
    };
  });
  if (
    rules.some(
      (rule) =>
        rule.sourceIds.length !==
          raw.find((candidate) => candidate.capability === rule.capability)!.sources.sourceIds
            .length ||
        !validStoredRule(
          rule.capability,
          rule.sourceMode,
          rule.sourceIds,
          rule.releaseMode,
          rule.policyFamilyId,
        ),
    )
  ) {
    throw new Error("Invalid access grant rules.");
  }
  return rules.sort((left, right) => left.capability.localeCompare(right.capability));
}

/** The rules a stored capability list from before tagged release modes stands for. */
export function legacyGrantRules(
  capabilities: readonly AccessCapability[],
): AccessGrantRuleInput[] {
  return [...new Set(capabilities)].sort().map((capability) => ({
    ...(capability === "answer"
      ? {
          capability: "answer" as const,
          sources: { mode: "all" as const, sourceIds: [] },
          release: {
            mode: "reviewed" as const,
            policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
          },
        }
      : {
          capability,
          sources: { mode: "all" as const, sourceIds: [] },
        }),
  }));
}

export function validateGrantRuleReferences(
  db: Db,
  rules: Readonly<StoredGrantRules>,
  retainedSourceIds: ReadonlySet<string> = new Set(),
): void {
  for (const rule of rules) {
    if (rule.policyFamilyId) {
      const family = db
        .prepare<
          [string],
          { present: number }
        >("SELECT 1 AS present FROM privacy_policy_families WHERE id = ? AND archived_at IS NULL")
        .get(rule.policyFamilyId);
      if (!family) throw new Error("Invalid privacy policy family.");
    }
    for (const sourceId of rule.sourceIds) {
      const source = db
        .prepare<[string], { present: number }>("SELECT 1 AS present FROM sources WHERE id = ?")
        .get(sourceId);
      if (!source && !retainedSourceIds.has(sourceId)) throw new Error("Invalid source rule.");
    }
    if (rule.capability !== "notes" && !readsAnySource(db, rule, retainedSourceIds)) {
      throw new Error("The rule allows no connected source.");
    }
  }
}

/**
 * Whether a read rule allows at least one source: one connected now, or one
 * the rule keeps naming while it is temporarily unavailable. A rule that
 * names every source away, such as a denylist of all of them, would approve a
 * connection that can read nothing, so it is refused.
 */
function readsAnySource(
  db: Db,
  rule: Readonly<StoredGrantRules[number]>,
  retainedSourceIds: ReadonlySet<string>,
): boolean {
  if (rule.sourceMode === "all") return true;
  const connected = db
    .prepare<[], { id: string }>("SELECT id FROM sources")
    .all()
    .map((row) => row.id);
  const listed = new Set(rule.sourceIds);
  if (rule.sourceMode === "allowlist") {
    return (
      rule.sourceIds.some((id) => retainedSourceIds.has(id)) ||
      connected.some((id) => listed.has(id))
    );
  }
  return connected.some((id) => !listed.has(id));
}

function validStoredRule(
  capability: AccessCapability,
  sourceMode: "all" | "allowlist" | "denylist",
  sourceIds: readonly string[],
  releaseMode: "reviewed" | "unreviewed" | null,
  policyFamilyId: string | null,
): boolean {
  if (sourceMode === "all" && sourceIds.length !== 0) return false;
  if (capability === "notes")
    return (
      sourceMode === "all" &&
      sourceIds.length === 0 &&
      releaseMode === null &&
      policyFamilyId === null
    );
  if (capability === "direct") return releaseMode === null && policyFamilyId === null;
  return (
    (releaseMode === "reviewed" && policyFamilyId !== null) ||
    (releaseMode === "unreviewed" && policyFamilyId === null)
  );
}

export function parseStringArray(json: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

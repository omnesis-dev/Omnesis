// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import type { AccessGrantCapability } from "./types.js";

type CorpusReadCapability = "answer" | "direct";

export interface CorpusAuthorizationIdentity {
  principalId: string;
  grantId: string;
  grantRevision: number;
  credentialId: string;
  accessTokenId: string;
}

export interface CorpusAuthorization {
  readonly principalId: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly credentialId: string;
  readonly accessTokenId: string;
  readonly capability: CorpusReadCapability;
  readonly sourceMode: AccessGrantCapability["sourceMode"];
  readonly sourceIds: readonly string[];
  readonly releaseMode: AccessGrantCapability["releaseMode"];
  readonly policyFamilyId: string | null;
  readonly policyRevision: string | null;
  readonly privacyPolicy: string | null;
  readonly digest: string;
  readonly restricted: boolean;
  allowsSource(sourceId: string): boolean;
}

interface SerializedCorpusAuthorization {
  v: 1;
  principalId: string;
  grantId: string;
  grantRevision: number;
  credentialId: string;
  accessTokenId: string;
  capability: CorpusReadCapability;
  sourceMode: AccessGrantCapability["sourceMode"];
  sourceIds: string[];
  releaseMode: AccessGrantCapability["releaseMode"];
  policyFamilyId: string | null;
  policyRevision: string | null;
  privacyPolicy: string | null;
}

function normalizedSourceIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function corpusAuthorizationDigest(input: {
  capability: CorpusReadCapability;
  sourceMode: AccessGrantCapability["sourceMode"];
  sourceIds: readonly string[];
  releaseMode: AccessGrantCapability["releaseMode"];
  policyFamilyId: string | null;
  policyRevision: string | null;
  privacyPolicy: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        capability: input.capability,
        sourceMode: input.sourceMode,
        sourceIds: input.sourceIds,
        releaseMode: input.releaseMode,
        policyFamilyId: input.policyFamilyId,
        policyRevision: input.policyRevision,
        privacyPolicy: input.privacyPolicy,
      }),
      "utf8",
    )
    .digest("base64url");
}

/**
 * Stable task-ownership boundary for Answer.
 *
 * Grant and policy revisions still fence every live token and every egress
 * transaction. They are deliberately absent here: rotating a token or saving
 * a new version of the same named policy must not orphan a pending task. The
 * fields that can change which corpus data may enter an answer remain present,
 * so editing sources, release mode, or policy family starts a new ownership
 * namespace and cannot expose work created under an older boundary.
 */
export function answerOwnerScopeDigest(authorization: CorpusAuthorization): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        capability: authorization.capability,
        sourceMode: authorization.sourceMode,
        sourceIds: authorization.sourceIds,
        releaseMode: authorization.releaseMode,
        policyFamilyId: authorization.policyFamilyId,
      }),
      "utf8",
    )
    .digest("base64url");
}

function buildAuthorization(input: SerializedCorpusAuthorization): CorpusAuthorization {
  if (input.capability !== "answer" && input.capability !== "direct") {
    throw new Error("Only Answer and Direct authorize corpus reads.");
  }
  const sourceIds = Object.freeze(normalizedSourceIds(input.sourceIds));
  const sourceMode =
    input.sourceMode === "denylist" && sourceIds.length === 0 ? "all" : input.sourceMode;
  if (sourceMode === "all" && sourceIds.length !== 0) {
    throw new Error("An all-sources capability cannot carry source ids.");
  }
  if (
    input.capability === "direct" &&
    (input.releaseMode !== null || input.policyFamilyId !== null || input.policyRevision !== null)
  ) {
    throw new Error("A Direct capability cannot carry an Answer release policy.");
  }
  if (
    input.capability === "answer" &&
    !(
      (input.releaseMode === "reviewed" &&
        input.policyFamilyId !== null &&
        input.policyRevision !== null) ||
      (input.releaseMode === "unreviewed" &&
        input.policyFamilyId === null &&
        input.policyRevision === null)
    )
  ) {
    throw new Error("An Answer capability must carry one valid release mode.");
  }
  const selected = new Set(sourceIds);
  const digest = corpusAuthorizationDigest({
    capability: input.capability,
    sourceMode,
    sourceIds,
    releaseMode: input.releaseMode,
    policyFamilyId: input.policyFamilyId,
    policyRevision: input.policyRevision,
    privacyPolicy: input.privacyPolicy,
  });
  return Object.freeze({
    principalId: input.principalId,
    grantId: input.grantId,
    grantRevision: input.grantRevision,
    credentialId: input.credentialId,
    accessTokenId: input.accessTokenId,
    capability: input.capability,
    sourceMode,
    sourceIds,
    releaseMode: input.releaseMode,
    policyFamilyId: input.policyFamilyId,
    policyRevision: input.policyRevision,
    privacyPolicy: input.privacyPolicy,
    digest,
    restricted: sourceMode !== "all",
    allowsSource(sourceId: string): boolean {
      if (sourceMode === "all") return true;
      const listed = selected.has(sourceId);
      return sourceMode === "allowlist" ? listed : !listed;
    },
  });
}

export function createCorpusAuthorization(
  identity: CorpusAuthorizationIdentity,
  capabilities: readonly AccessGrantCapability[],
  capability: CorpusReadCapability,
): CorpusAuthorization | null {
  if (capability !== "answer" && capability !== "direct") return null;
  const rule = capabilities.find((candidate) => candidate.capability === capability);
  if (!rule) return null;
  return buildAuthorization({
    v: 1,
    ...identity,
    capability,
    sourceMode: rule.sourceMode,
    sourceIds: rule.sourceIds,
    releaseMode: rule.releaseMode,
    policyFamilyId: rule.policyFamilyId,
    policyRevision: rule.policyRevision,
    privacyPolicy: rule.privacyPolicy,
  });
}

export function serializeCorpusAuthorization(authorization: CorpusAuthorization): string {
  return JSON.stringify({
    v: 1,
    principalId: authorization.principalId,
    grantId: authorization.grantId,
    grantRevision: authorization.grantRevision,
    credentialId: authorization.credentialId,
    accessTokenId: authorization.accessTokenId,
    capability: authorization.capability,
    sourceMode: authorization.sourceMode,
    sourceIds: [...authorization.sourceIds],
    releaseMode: authorization.releaseMode,
    policyFamilyId: authorization.policyFamilyId,
    policyRevision: authorization.policyRevision,
    privacyPolicy: authorization.privacyPolicy,
  } satisfies SerializedCorpusAuthorization);
}

export function parseCorpusAuthorization(serialized: string): CorpusAuthorization {
  const parsed = JSON.parse(serialized) as Partial<SerializedCorpusAuthorization>;
  if (
    parsed.v !== 1 ||
    typeof parsed.principalId !== "string" ||
    typeof parsed.grantId !== "string" ||
    !Number.isSafeInteger(parsed.grantRevision) ||
    (parsed.grantRevision ?? 0) <= 0 ||
    typeof parsed.credentialId !== "string" ||
    typeof parsed.accessTokenId !== "string" ||
    (parsed.capability !== "direct" && parsed.capability !== "answer") ||
    (parsed.sourceMode !== "all" &&
      parsed.sourceMode !== "allowlist" &&
      parsed.sourceMode !== "denylist") ||
    !Array.isArray(parsed.sourceIds) ||
    !parsed.sourceIds.every((value) => typeof value === "string") ||
    (parsed.releaseMode !== null &&
      parsed.releaseMode !== "reviewed" &&
      parsed.releaseMode !== "unreviewed") ||
    (parsed.policyFamilyId !== null && typeof parsed.policyFamilyId !== "string") ||
    (parsed.policyRevision !== null && typeof parsed.policyRevision !== "string") ||
    (parsed.privacyPolicy !== null && typeof parsed.privacyPolicy !== "string")
  ) {
    throw new Error("Invalid corpus authorization context.");
  }
  return buildAuthorization(parsed as SerializedCorpusAuthorization);
}

export function unrestrictedInternalAuthorization(
  capability: CorpusReadCapability,
): CorpusAuthorization {
  return buildAuthorization({
    v: 1,
    principalId: "internal",
    grantId: "internal",
    grantRevision: 1,
    credentialId: "internal",
    accessTokenId: "internal",
    capability,
    sourceMode: "all",
    sourceIds: [],
    releaseMode: capability === "answer" ? "unreviewed" : null,
    policyFamilyId: null,
    policyRevision: null,
    privacyPolicy: null,
  });
}

export function externalAnswerOwnerId(authorization: CorpusAuthorization): string {
  if (authorization.capability !== "answer") {
    throw new Error("An external Answer owner requires Answer authorization.");
  }
  return [
    "principal",
    authorization.principalId,
    "grant",
    authorization.grantId,
    "credential",
    authorization.credentialId,
    "answer-scope",
    answerOwnerScopeDigest(authorization),
  ].join(":");
}

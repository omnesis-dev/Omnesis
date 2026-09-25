// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * One enriched merge candidate — a probable-duplicate pair the fuzzy
 * detector surfaced for review. Mirrors the gateway's enriched candidate row
 * and the iOS `MergeCandidate`. `clusterId` groups pairs into one
 * connected-component decision; `resolvedSideA` / `resolvedSideB` carry the
 * people each side resolves to (with aliases + source ids). Only the fields
 * the review UI consumes are decoded.
 */
@Serializable
data class MergeCandidate(
    val id: String,
    /** Connected-component id; pairs sharing it are one cluster decision. */
    val clusterId: String? = null,
    val resolvedSideA: List<MergeRulePerson> = emptyList(),
    val resolvedSideB: List<MergeRulePerson> = emptyList(),
)

/**
 * `GET /people/merge-candidates` response — the canonical `Page<T>` envelope
 * (`items` + `pageInfo`) plus an endpoint-specific `counts` block. Mirrors the
 * portal payload `{ items, pageInfo, counts }`.
 */
@Serializable
data class MergeCandidatesResponse(
    val items: List<MergeCandidate> = emptyList(),
    val counts: MergeCandidateCounts = MergeCandidateCounts(),
    val pageInfo: PageInfo = PageInfo(limit = items.size),
)

/** pending / accepted / denied totals for the review queue's stats bar. */
@Serializable
data class MergeCandidateCounts(
    val pending: Int = 0,
    val accepted: Int = 0,
    val denied: Int = 0,
)

/**
 * Body of `POST /people/merge-candidates/merge-cluster` — unify N people into
 * one identity. `OmnesisJson` drops the null `reason`.
 */
@Serializable
data class MergeClusterBody(
    val personIds: List<String>,
    val reason: String? = null,
)

/**
 * Result of `POST /people/merge-candidates/merge-cluster`. Mirrors
 * `MergeClusterResult` in `packages/gateway/src/merge-candidates.ts`.
 */
@Serializable
data class MergeClusterResult(
    /** Number of `kind='user'` rules created to unify the people. */
    val rulesCreated: Int = 0,
    /** The surviving canonical the others were bridged to (null when none). */
    val anchorId: String? = null,
    /** Correlation id stamped on every rule the call created (null when none). */
    val groupId: String? = null,
)

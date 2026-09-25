// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * One privacy policy family as `GET /admin/privacy/policies` lists it: the
 * name an operator gave it, the revision currently in force, and the grants
 * whose answer release names it. An archived family carries the instant it
 * was archived; a live one carries null. Unknown fields are ignored by
 * [OmnesisJson], so a gateway that extends the summary keeps decoding.
 */
@Serializable
data class PrivacyPolicyFamilySummary(
    val id: String = "",
    val name: String = "",
    val currentRevision: String = "",
    val currentVersion: Int = 0,
    val updatedAt: Long? = null,
    val archivedAt: Long? = null,
    val affectedGrantIds: List<String> = emptyList(),
)

@Serializable
data class PrivacyPolicyFamiliesPage(
    val policies: List<PrivacyPolicyFamilySummary> = emptyList(),
)

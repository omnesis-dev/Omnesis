// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** `GET /people` row. Mirrors the iOS `PersonSummary` (camelCase wire). */
@Serializable
data class PersonSummary(
    val id: String,
    val canonicalName: String = "",
    val source: String = "",
    val isSelf: Boolean = false,
    val aliasCount: Int = 0,
    val documentCount: Int = 0,
    val firstSeen: String? = null,
    val lastSeen: String? = null,
    val inboundCount: Int? = null,
    val outboundCount: Int? = null,
    val interactionScoreRecent: Double? = null,
    val sourceIds: List<String>? = null,
)

/**
 * Best-effort display label: canonicalName when non-blank, else "(unknown)". `PersonSummary`
 * carries no aliases, so phone-only contacts with a blank canonicalName fall straight through
 * to the placeholder. Mirrors the `PersonMention.displayName` fallback ladder.
 */
val PersonSummary.displayName: String
    get() = canonicalName.ifBlank { "(unknown)" }

/**
 * `GET /people/stats` — the People list view's summary counts. Mirrors the
 * gateway `PeopleStats`. The People screen reads `pendingMergeCandidates` /
 * `mergeRules` to label its two merge-shortcut buttons.
 */
@Serializable
data class PeopleStats(
    val totalPeople: Int = 0,
    val totalAliases: Int = 0,
    val totalLinks: Int = 0,
    val selfDetected: Boolean = false,
    val pendingMergeCandidates: Int = 0,
    val mergeRules: Int = 0,
)

/** `GET /people/:id`. Mirrors the iOS `PersonDetail`. */
@Serializable
data class PersonDetail(
    val id: String,
    val canonicalName: String = "",
    val source: String = "",
    val isSelf: Boolean = false,
    val firstSeen: String? = null,
    val lastSeen: String? = null,
    val aliases: List<PersonAlias> = emptyList(),
    val aliasesOwn: List<PersonAlias>? = null,
    val inboundCount: Int? = null,
    val outboundCount: Int? = null,
    val interactionScore: Double? = null,
    val interactionScoreRecent: Double? = null,
    val inboundScoreRecent: Double? = null,
    val outboundScoreRecent: Double? = null,
    val mergedInto: String? = null,
    val mergedIntoCanonicalName: String? = null,
    val mergedFrom: List<MergedFromPerson>? = null,
)

/**
 * Best-effort display label: canonicalName when non-blank, else the first alias (typically a
 * phone or email), else "(unknown)". So phone-only contacts that carry no canonical name still
 * render a label instead of a blank row. Mirrors the `PersonMention.displayName` ladder.
 */
val PersonDetail.displayName: String
    get() = canonicalName.ifBlank { aliases.firstOrNull()?.alias.orEmpty() }.ifBlank { "(unknown)" }

@Serializable
data class MergedFromPerson(
    val id: String,
    val canonicalName: String = "",
    val aliases: List<PersonAlias> = emptyList(),
    val inboundCount: Int = 0,
    val outboundCount: Int = 0,
    val appliedAt: String = "",
    val sourceIds: List<String> = emptyList(),
)

/** `GET /people/:id/documents` row — just the document id + the person's role(s). */
@Serializable
data class PersonDocumentEntry(
    val id: String,
    val roles: List<String> = emptyList(),
)

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** Mirrors packages/types/src/source-scopes.ts. Identifiers are captured, never people-row pointers. */
@Serializable data class ScopeIdentifier(val type: String, val value: String)
@Serializable data class ScopeRef(
    val kind: String, val id: String? = null, val label: String? = null,
    val identifiers: List<ScopeIdentifier>? = null,
)
@Serializable data class ScopeAudience(val accessLevel: String, val capability: String)
@Serializable data class ScopeRule(val match: List<ScopeRef>, val action: String)
@Serializable data class ScopePolicy(
    val sourceId: String, val audience: ScopeAudience, val rules: List<ScopeRule>,
    val otherwise: String, val maxAge: String? = null,
) {
    val editable: Boolean get() = rules.size == 1 && rules.single().action in listOf("share", "hide") &&
        otherwise in listOf("share", "hide") && rules.single().action != otherwise && maxAge == null &&
        rules.single().match.all { it.kind in listOf("conversation", "participant", "label", "folder") }
    fun readyToSave(readiness: List<ScopeKindReadiness>): Boolean = readiness.none { it.reason == "backfill" } &&
        rules.firstOrNull()?.match.orEmpty().all { ref -> readiness.firstOrNull { it.kind == ref.kind }?.ready == true }
    val withinLimits: Boolean get() = rules.size == 1 && rules.single().match.sumOf { it.identifiers?.size ?: 1 } <= MAX_SCOPE_FILTER_ENTRIES
    companion object {
        fun empty(sourceId: String, levelId: String, capability: String) = ScopePolicy(
            sourceId, ScopeAudience(levelId, capability), listOf(ScopeRule(emptyList(), "hide")), "share",
        )
    }
}
/** The most entries one filter can hold; an item matched by several addresses counts once per address. */
const val MAX_SCOPE_FILTER_ENTRIES = 256
@Serializable data class SourceScopeNoun(val one: String, val many: String)
@Serializable data class SourceScopeItem(
    val kind: String, val link: String, val identifiers: List<String>? = null,
    val noun: SourceScopeNoun? = null, val picker: String? = null,
    /** What the source calls an item at each depth of its tree, roots first; the last names every deeper level. */
    val levels: List<SourceScopeNoun>? = null,
)
@Serializable data class SourceScopes(val items: List<SourceScopeItem>, val revision: Int? = null)
@Serializable data class ScopeBehindCollector(val deviceId: String, val name: String)
@Serializable data class ScopeKindReadiness(
    val kind: String, val ready: Boolean, val reason: String? = null, val message: String? = null,
    val processed: Long? = null, val pending: Long? = null, val behindCollectors: List<ScopeBehindCollector>? = null,
)
@Serializable data class ScopeOption(
    val ref: ScopeRef, val label: String, val count: Long, val parentId: String? = null,
    val hasChildren: Boolean? = null, val personId: String? = null,
    /** How many ancestors the item has, when its source names the levels of its tree. */
    val depth: Int? = null,
)
@Serializable data class ScopeOptions(
    val sourceId: String, val sourceType: String, val scopes: SourceScopes,
    val readiness: List<ScopeKindReadiness>, val items: List<ScopeOption>, val nextCursor: String? = null,
)
@Serializable data class ScopePreviewItem(
    val ref: ScopeRef, val label: String, val count: Long, val parentId: String? = null, val missing: Boolean? = null,
    /** How many ancestors the item has, when its source names the levels of its tree. */
    val depth: Int? = null,
)
@Serializable data class ScopePreviewSample(val documentId: String, val title: String, val visible: Boolean, val unknown: Boolean)
@Serializable data class ScopeIdentifierProposal(val itemIndex: Int, val label: String, val identifiers: List<ScopeIdentifier>)
@Serializable data class ScopePreview(
    val sourceId: String, val total: Long, val visible: Long, val hidden: Long, val unknown: Long,
    val items: List<ScopePreviewItem>, val samples: List<ScopePreviewSample>,
    val readiness: List<ScopeKindReadiness>, val identifierProposals: List<ScopeIdentifierProposal>? = null,
)
@Serializable data class SourceFiltersAvailability(val enabled: Boolean)
@Serializable data class AccessLevelCreateBody(val name: String, val rules: List<AccessGrantRule>)
@Serializable data class AccessLevelUpdateBody(
    val name: String, val rules: List<AccessGrantRule>, val expectedRevision: Int,
    val expectedFilterRevisions: Map<String, Int>,
)
@Serializable data class AccessLevelReply(val level: AccessLevelSummary)
@Serializable data class ScopePreviewBody(val policy: ScopePolicy)

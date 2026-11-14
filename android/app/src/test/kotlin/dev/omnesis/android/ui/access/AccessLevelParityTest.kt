// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Test

class AccessLevelParityTest {
    private val cedar = AccessSourceInstance("scope-chat:cedar", "Cedar account")
    private val juniper = AccessSourceInstance("scope-chat:juniper", "Juniper account")
    private val retired = AccessSourceInstance("scope-chat:retired", "Unavailable account", available = false)
    private val known = setOf(cedar.id, juniper.id, retired.id)
    private val maya = FilterRef.person("Maya Reeves", listOf(FilterIdentifier("email", "maya@example.org")))
    private val jamie = FilterRef.person("Jamie Lopez", listOf(FilterIdentifier("email", "jamie@example.org")))
    private val blueprints = FilterRef.item(FilterRef.TREE, "extra.folderId", "folder-blueprints")
    private fun policy(vararg refs: FilterRef) = SourceFilter(cedar.id, FilterAudience("level-example", "answer"), listOf(FilterRule(refs.toList(), "share")), "hide")

    @Test fun aSearchNarrowsTheAccountsABulkChoiceReaches() {
        val accounts = listOf(cedar, juniper, retired)
        assertEquals(accounts, visibleAccounts(accounts, "  "))
        assertEquals(listOf(juniper), visibleAccounts(accounts, " juniper "))
        assertEquals(listOf(cedar), visibleAccounts(accounts, "CHAT:CEDAR"))
        val none = AccessSourceSelectionState.from(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()), known)
        val searched = none.settingAll(visibleAccounts(accounts, "juniper"), true)
        assertEquals(listOf(juniper.id), searched.boundary(known).sourceIds)
        val everything = AccessSourceSelectionState.from(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(cedar.id, juniper.id)), known)
        assertEquals(listOf(juniper.id), everything.settingAll(visibleAccounts(accounts, "cedar"), false).boundary(known).sourceIds)
    }

    @Test fun anUnavailableAccountCanBeClearedButNeverSelectedInBulk() {
        val saved = AccessSourceSelectionState.from(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(cedar.id, retired.id)), known)
        assertTrue(saved.allows(retired.id))
        assertEquals(emptyList<String>(), saved.settingAll(listOf(cedar, juniper, retired), false).boundary(known).sourceIds)
        val cleared = saved.setAllowed(retired.id, false)
        assertEquals(listOf(cedar.id), cleared.boundary(known).sourceIds)
        assertEquals(listOf(cedar.id, juniper.id), cleared.settingAll(listOf(cedar, juniper, retired), true).boundary(known).sourceIds)
    }

    @Test fun aChangedFilterListsWhatItAddsThenRemovesThenKeeps() {
        val changes = changedFilterItems(policy(maya, blueprints), policy(maya, jamie))
        assertEquals(listOf(
            FilterItemChange(jamie, FilterItemMark.ADDED),
            FilterItemChange(blueprints, FilterItemMark.REMOVED),
            FilterItemChange(maya, null),
        ), changes)
    }

    @Test fun eachSelectedItemReadsItsOwnMatchCountOnceTheCountsHaveArrived() {
        val preview = readyPreview(cedar.id, 12, 5, listOf(FilterPreviewItem(maya, "Maya Reeves", 4), FilterPreviewItem(blueprints, "folder-blueprints", 0, missing = true)))
        assertEquals(4L, scopeItemCount(preview, maya))
        assertEquals(0L, scopeItemCount(preview, blueprints))
        assertNull(scopeItemCount(preview, jamie))
        assertNull(scopeItemCount(null, maya))
        assertNull(scopeItemCount(pendingPreview(), maya))
        assertEquals(4L, PolicyPreviewState(policy(maya), preview, failure = null) {}.count(maya))
        assertNull(PolicyPreviewState(policy(maya), pendingPreview(), failure = null) {}.count(maya))
        // A missing entry's label is its raw id, which is never shown as its name.
        assertNull(filterItemLabel(blueprints, cedar.id, emptyMap(), preview))
        assertEquals("Maya Reeves", filterItemLabel(maya, cedar.id, emptyMap(), preview))
    }

    @Test fun countsAreCountingUntilTheGatewaySaysTheyAreReady() {
        assertFalse(PolicyPreviewState(policy(maya), pendingPreview(), failure = null) {}.settled)
        assertTrue(PolicyPreviewState(policy(maya), pendingPreview(), failure = null) {}.counting)
        assertTrue(PolicyPreviewState(policy(maya), readyPreview(cedar.id, 12, 5), failure = null) {}.settled)
        assertTrue(PolicyPreviewState(policy(maya), null, failure = null) {}.counting)
        assertFalse(PolicyPreviewState(policy(maya), null, failure = IllegalStateException("unreachable")) {}.counting)
    }

    @Test fun anEditNamesTheConnectionsAndIntegrationsItReaches() {
        fun grant(id: String, levelId: String?, revokedAt: Long? = null) = AccessGrantSummary(id, "$id access", 1, emptyList(), emptyList(), revokedAt = revokedAt, levelId = levelId)
        val level = AccessLevelSummary("level-example", "Research", 3, listOf(AccessGrantRule.notes()), 2, listOf(AccessLevelDevice("device-example", "Kitchen speaker", "integration")))
        val overview = AccessOverview(listOf(
            AccessPrincipalSummary("principal-two", "northstar Assistant", "interactive", listOf(grant("grant-two", level.id))),
            AccessPrincipalSummary("principal-one", "Aurora Planner", "interactive", listOf(grant("grant-one", level.id), grant("grant-old", level.id, revokedAt = 5))),
            AccessPrincipalSummary("principal-other", "Studio Northstar", "interactive", listOf(grant("grant-other", "level-other"))),
            AccessPrincipalSummary("principal-gone", "Riverside Estate", "interactive", listOf(grant("grant-gone", level.id)), revokedAt = 9),
        ), emptyList(), levels = listOf(level))
        val users = level.users(overview)
        assertEquals(listOf("Aurora Planner", "northstar Assistant"), users.connections)
        assertEquals(listOf("Kitchen speaker"), users.integrations)
        assertTrue(users.inUse)
        assertEquals("Move its connections and integrations off it first.", users.deletionBlocker)
        val unused = level.copy(connectionCount = 0, devices = emptyList()).users(overview.copy(principals = emptyList()))
        assertFalse(unused.inUse)
        assertNull(unused.deletionBlocker)
        assertEquals("Move or remove its connections first.", level.copy(devices = emptyList()).users(overview).deletionBlocker)
        assertEquals("Move its integrations to another access level first.", level.copy(connectionCount = 0).users(overview).deletionBlocker)
        assertTrue(level.copy(connectionCount = 0).users(overview).inUse)
    }
}

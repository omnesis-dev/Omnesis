// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The review of an edit, one kind of edit at a time: which decisions and accounts it lists, and where each
 * filter's items stand. A filter's items stand under the side that holds them; only an account that keeps
 * an editable filter on both sides gets one list after both lines, marked with what the edit added and removed.
 */
class AccessLevelReviewTest {
    private val gmail = AccessSourceInstance("mail:reader@example.org", "Mail · reader@example.org")
    private val drive = AccessSourceInstance("files:reader@example.org", "Files · reader@example.org")
    private val chat = AccessSourceInstance("chat:+15550100123", "Chat · +1 (555) 010-0123")
    private val overview = AccessOverview(emptyList(), listOf(gmail, drive, chat), sourceFilters = SourceFiltersAvailability(true))

    private val projects = FilterRef.item(FilterRef.TREE, "extra.folderId", "projects")
    private val workshop = FilterRef.item(FilterRef.MEMBERSHIP, "extra.chatId", "conversation-workshop")
    private val maya = FilterRef.person("Maya Reeves", listOf(FilterIdentifier("phone", "+15550100142")))
    private val jamie = FilterRef.person("Jamie Lopez", listOf(FilterIdentifier("phone", "+15550100167")))
    private val project = FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "label-project")

    private fun filter(source: AccessSourceInstance, capability: AccessCapability, action: String, vararg refs: FilterRef) =
        SourceFilter(source.id, FilterAudience(LEVEL, capability.name.lowercase()), listOf(FilterRule(refs.toList(), action)), if (action == "share") "hide" else "share")
    private fun every(vararg sources: AccessSourceInstance) = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, sources.map { it.id })
    /** Answer as the example level saves it: every account, Files sharing one folder, Chat hiding a conversation and a person. */
    private val answer = AccessGrantRule.answer(every(gmail, drive, chat), AccessAnswerRelease.unreviewed()).copy(filterRevision = 1, scopePolicies = listOf(
        filter(drive, AccessCapability.ANSWER, "share", projects), filter(chat, AccessCapability.ANSWER, "hide", workshop, maya)))
    private fun directLike(rule: AccessGrantRule) = AccessGrantRule.direct(rule.sources).copy(filterRevision = rule.filterRevision,
        scopePolicies = rule.scopePolicies.map { it.copy(audience = FilterAudience(LEVEL, "direct")) })
    private fun opened(vararg rules: AccessGrantRule): Pair<AccessLevelDraft, AccessOverview> {
        val level = AccessLevelSummary(LEVEL, "Research assistant", 3, rules.toList(), 2)
        val state = overview.copy(levels = listOf(level))
        return AccessLevelDraft.opening(level, state) to state
    }
    private fun List<AccountChangePart>.shape(): List<String> = map { part -> when (part) {
        is AccountChangePart.Side -> (if (part.after) "After " else "Before ") + part.share.status
        is AccountChangePart.Items -> (when (part.after) { false -> "under Before"; true -> "under After"; null -> "merged" }) + ": " +
            part.items.joinToString { (it.ref.id ?: it.ref.label!!) + (it.mark?.let { mark -> " " + mark.label } ?: "") }
    } }
    private fun AccessLevelDraft.layout(capability: AccessCapability, state: AccessOverview): Map<String, List<String>> =
        changedAccounts(capability, state).associate { it.sourceId to accountChangeParts(it.before, it.after).shape() }

    @Test fun switchingDirectOffListsEachFilterUnderBeforeAndEveryAccountAsNotGranted() {
        val (saved, state) = opened(answer, directLike(answer))
        val off = saved.enabled(AccessCapability.DIRECT, false, state)
        assertEquals(listOf("Permissions", "Direct data", "New sources"), off.changes(state).map { it.title })
        assertEquals("Answer: Blocked / Direct: Blocked", off.changes(state).single { it.title == "New sources" }.before)
        assertEquals("Answer: Blocked", off.changes(state).single { it.title == "New sources" }.after)
        assertEquals(mapOf(
            gmail.id to listOf("Before All content", "After Not granted"),
            drive.id to listOf("Before Share matching content", "under Before: projects", "After Not granted"),
            chat.id to listOf("Before Hide matching content", "under Before: conversation-workshop, Maya Reeves", "After Not granted"),
        ), off.layout(AccessCapability.DIRECT, state))
    }

    @Test fun anAccountNoSideReadsIsNotAChangeWhenItsCapabilityIsSwitchedOff() {
        val (saved, state) = opened(answer, AccessGrantRule.direct(every(gmail)))
        val off = saved.enabled(AccessCapability.DIRECT, false, state)
        assertEquals(listOf(gmail.id), off.changedAccounts(AccessCapability.DIRECT, state).map { it.sourceId })
    }

    @Test fun switchingDirectOnListsEachFilterUnderAfter() {
        val (saved, state) = opened(answer)
        val on = saved.setRule(directLike(answer).copy(filterRevision = null))
        assertEquals(listOf("Permissions", "Direct data", "New sources"), on.changes(state).map { it.title })
        assertEquals(mapOf(
            gmail.id to listOf("Before Not granted", "After All content"),
            drive.id to listOf("Before Not granted", "After Share matching content", "under After: projects"),
            chat.id to listOf("Before Not granted", "After Hide matching content", "under After: conversation-workshop, Maya Reeves"),
        ), on.layout(AccessCapability.DIRECT, state))
    }

    @Test fun aFilterAddedToAnAllContentAccountStandsUnderAfter() {
        val (saved, state) = opened(answer)
        val added = saved.setPolicy(filter(gmail, AccessCapability.ANSWER, "share", project), gmail.id, AccessCapability.ANSWER)
        assertEquals(mapOf(gmail.id to listOf("Before All content", "After Share matching content", "under After: label-project")), added.layout(AccessCapability.ANSWER, state))
    }

    @Test fun aFilterRemovedStandsUnderBeforeAndTheAccountReadsAllContentAfter() {
        val (saved, state) = opened(answer)
        val removed = saved.setPolicy(null, drive.id, AccessCapability.ANSWER)
        assertEquals(mapOf(drive.id to listOf("Before Share matching content", "under Before: projects", "After All content")), removed.layout(AccessCapability.ANSWER, state))
    }

    @Test fun itemsAddedAndRemovedOnOneFilterAreMarkedInOneListAfterBothLines() {
        val (saved, state) = opened(answer)
        val changed = saved.setPolicy(filter(chat, AccessCapability.ANSWER, "hide", maya, jamie), chat.id, AccessCapability.ANSWER)
        assertEquals(listOf("Answer data"), changed.changes(state).map { it.title })
        assertEquals(mapOf(chat.id to listOf("Before Hide matching content", "After Hide matching content",
            "merged: Jamie Lopez Added, conversation-workshop Removed, Maya Reeves")), changed.layout(AccessCapability.ANSWER, state))
    }

    @Test fun aSwitchedModeShowsDifferentPillsOverTheSameUnmarkedItems() {
        val (saved, state) = opened(answer)
        val switched = saved.setPolicy(filter(chat, AccessCapability.ANSWER, "share", workshop, maya), chat.id, AccessCapability.ANSWER)
        val change = switched.changedAccounts(AccessCapability.ANSWER, state).single()
        assertEquals(listOf("Before Hide matching content", "After Share matching content", "merged: conversation-workshop, Maya Reeves"),
            accountChangeParts(change.before, change.after).shape())
        assertEquals(AccessPillTone.DANGER, change.before.tone)
        assertEquals(AccessPillTone.ACCENT, change.after.tone)
        // Each side's counts come from that side's own filter.
        assertEquals("hide", change.before.filter!!.rules.single().action)
        assertEquals("share", change.after.filter!!.rules.single().action)
    }

    @Test fun aSwitchedModeWithChangedItemsMarksTheItems() {
        val (saved, state) = opened(answer)
        val switched = saved.setPolicy(filter(chat, AccessCapability.ANSWER, "share", maya, jamie), chat.id, AccessCapability.ANSWER)
        assertEquals(mapOf(chat.id to listOf("Before Hide matching content", "After Share matching content",
            "merged: Jamie Lopez Added, conversation-workshop Removed, Maya Reeves")), switched.layout(AccessCapability.ANSWER, state))
    }

    @Test fun anUnselectedFilteredAccountKeepsItsItemsUnderBeforeAndReadsNotShared() {
        val (saved, state) = opened(answer)
        val unselected = saved.setBoundary(every(gmail, drive), AccessCapability.ANSWER, true)
        // A filter kept on an account that is no longer read applies nothing, whether or not it was removed yet.
        listOf(unselected, unselected.setPolicy(null, chat.id, AccessCapability.ANSWER)).forEach { draft ->
            assertEquals(mapOf(chat.id to listOf("Before Hide matching content", "under Before: conversation-workshop, Maya Reeves", "After Not shared")),
                draft.layout(AccessCapability.ANSWER, state))
        }
    }

    @Test fun aNewlySelectedFilteredAccountShowsItsItemsUnderAfter() {
        val (saved, state) = opened(answer, AccessGrantRule.direct(every(gmail)))
        val selected = saved.setBoundary(every(gmail, chat), AccessCapability.DIRECT, true)
            .setPolicy(filter(chat, AccessCapability.DIRECT, "hide", maya), chat.id, AccessCapability.DIRECT)
        assertEquals(mapOf(chat.id to listOf("Before Not shared", "After Hide matching content", "under After: Maya Reeves")), selected.layout(AccessCapability.DIRECT, state))
    }

    @Test fun aLinkedDirectShowsAnAnswerFilterChangeInBothDecisionsAlike() {
        val (saved, state) = opened(answer, directLike(answer))
        assertTrue(saved.directLinked)
        val changed = saved.setPolicy(filter(chat, AccessCapability.ANSWER, "hide", maya, jamie), chat.id, AccessCapability.ANSWER)
        assertEquals(listOf("Answer data", "Direct data"), changed.changes(state).map { it.title })
        assertEquals(changed.layout(AccessCapability.ANSWER, state), changed.layout(AccessCapability.DIRECT, state))
        assertEquals("Answer: Blocked / Direct: Blocked", changed.unchangedDecisions(state).single { it.title == "New sources" }.value)
    }

    @Test fun linkingOrUnlinkingDirectWithoutChangingWhatItReadsChangesNothing() {
        val (saved, state) = opened(answer, directLike(answer))
        assertTrue(saved.withDirectSameAsAnswer(false).changes(state).isEmpty())
        val (separate, separateState) = opened(answer, AccessGrantRule.direct(every(gmail)))
        val linked = separate.withDirectSameAsAnswer(true)
        assertEquals(listOf("Direct data"), linked.changes(separateState).map { it.title })
        assertEquals("Answer: Blocked / Direct: Blocked", linked.unchangedDecisions(separateState).single { it.title == "New sources" }.value)
    }

    @Test fun anAdvancedFilterKeepsItsOwnListUnderEachSide() {
        val advanced = SourceFilter(chat.id, FilterAudience(LEVEL, "answer"), listOf(FilterRule(listOf(workshop), "hide"), FilterRule(listOf(maya), "share")), "hide")
        val (saved, state) = opened(answer.copy(scopePolicies = listOf(advanced)))
        val replaced = saved.setPolicy(filter(chat, AccessCapability.ANSWER, "hide", jamie), chat.id, AccessCapability.ANSWER)
        assertEquals(mapOf(chat.id to listOf("Before Saved filter", "under Before: conversation-workshop, Maya Reeves", "After Hide matching content", "under After: Jamie Lopez")),
            replaced.layout(AccessCapability.ANSWER, state))
    }

    @Test fun aDisconnectedAccountsRemovedItemIsMarkedOnThatAccount() {
        val gone = AccessSourceInstance("chat:+15550100199", "Chat · +1 (555) 010-0199")
        val kept = filter(gone, AccessCapability.ANSWER, "hide", workshop, maya)
        val (saved, state) = opened(answer.copy(sources = every(gmail, drive, chat, gone), scopePolicies = answer.scopePolicies + kept))
        val changed = saved.setPolicy(filter(gone, AccessCapability.ANSWER, "hide", maya), gone.id, AccessCapability.ANSWER)
        assertEquals(mapOf(gone.id to listOf("Before Hide matching content", "After Hide matching content", "merged: conversation-workshop Removed, Maya Reeves")),
            changed.layout(AccessCapability.ANSWER, state))
    }

    @Test fun aChangeElsewhereLeavesARetainedAdvancedFilterOutOfTheReview() {
        val advanced = SourceFilter(chat.id, FilterAudience(LEVEL, "answer"), listOf(FilterRule(listOf(workshop), "hide"), FilterRule(listOf(maya), "share")), "hide")
        val (saved, state) = opened(answer.copy(scopePolicies = listOf(advanced)))
        val changed = saved.setPolicy(filter(gmail, AccessCapability.ANSWER, "share", project), gmail.id, AccessCapability.ANSWER)
        assertEquals(listOf(gmail.id), changed.changedAccounts(AccessCapability.ANSWER, state).map { it.sourceId })
    }

    @Test fun decisionsWithoutDataStateEachSideAndTheRestStayUnchanged() {
        val (saved, state) = opened(answer, directLike(answer))
        val notes = saved.enabled(AccessCapability.NOTES, true, state)
        assertEquals(listOf("Permissions"), notes.changes(state).map { it.title })
        assertEquals(AccessCapabilityHoldings(true, true, false), notes.changes(state).single().beforeCapabilities)
        assertEquals(AccessCapabilityHoldings(true, true, true), notes.changes(state).single().afterCapabilities)
        val several = notes.copy(name = "Updated helper").setPolicy(null, drive.id, AccessCapability.ANSWER)
        val changed = several.changes(state).map { it.title }
        assertEquals(listOf("Name", "Permissions", "Answer data", "Direct data"), changed)
        assertTrue(several.unchangedDecisions(state).none { it.title in changed })
        assertEquals(listOf("New sources", "Answer release"), several.unchangedDecisions(state).map { it.title })
    }

    private companion object { const val LEVEL = "level-example" }
}

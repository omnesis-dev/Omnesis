// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Test

class AccessLevelFlowTest {
    private val source = AccessSourceInstance("mail:reader@example.org", "Mail", sourceType = "mail")
    private val overview = AccessOverview(emptyList(), listOf(source))
    private fun draft(vararg caps: AccessCapability) = AccessLevelDraft.opening(null, overview).copy(name = "Project helper", requireAnswerPolicySelection = false,
        rules = caps.map { cap -> when (cap) {
            AccessCapability.ANSWER -> AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
            AccessCapability.DIRECT -> AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)))
            AccessCapability.NOTES -> AccessGrantRule.notes()
        } })
    @Test fun notesOnlySkipsEveryReadingDecision() {
        val notes = draft(AccessCapability.NOTES)
        assertEquals(listOf(AccessLevelPage.PERMISSIONS, AccessLevelPage.REVIEW), notes.createPages())
        assertTrue(notes.validFor(overview.copy(sources = emptyList())))
    }
    @Test fun directOnlyNeverAsksAboutAnswerReleaseOrReusingAnswer() {
        val pages = draft(AccessCapability.DIRECT).createPages()
        assertEquals(listOf(AccessLevelPage.PERMISSIONS, AccessLevelPage.DIRECT_DATA, AccessLevelPage.FUTURE, AccessLevelPage.REVIEW), pages)
    }
    @Test fun aNewLevelAsksAboutDirectOnOneStepBesideAnswerWhicheverWayItIsAnswered() {
        val linked = draft(AccessCapability.ANSWER, AccessCapability.DIRECT)
        assertTrue(AccessLevelPage.DIRECT_CHOICE in linked.createPages())
        assertFalse(AccessLevelPage.DIRECT_DATA in linked.createPages())
        val separate = linked.withDirectSameAsAnswer(false)
        assertEquals(linked.createPages(), separate.createPages())
        assertEquals(AccessLevelPage.DIRECT_CHOICE.question(creating = true), AccessLevelPage.DIRECT_DATA.question(creating = false))
        val emptied = separate.setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()), AccessCapability.DIRECT, true)
        assertNotNull(emptied.pageError(AccessLevelPage.DIRECT_CHOICE, overview))
        assertEquals(linked.rule(AccessCapability.ANSWER)!!.sources, separate.rule(AccessCapability.DIRECT)!!.sources)
    }
    @Test fun aNamedEmptyReadingGrantCannotSaveButNotesCan() {
        val empty = draft(AccessCapability.ANSWER).setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()), AccessCapability.ANSWER, true)
        assertFalse(empty.validFor(overview))
        assertNotNull(empty.pageError(AccessLevelPage.ANSWER_DATA, overview))
        assertTrue(draft(AccessCapability.NOTES).validFor(overview))
    }
    @Test fun denyingEveryCurrentAccountCannotMasqueradeAsAValidSourceChoice() {
        val denied = draft(AccessCapability.DIRECT).setBoundary(AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf(source.id)), AccessCapability.DIRECT, true)
        assertFalse(denied.validFor(overview))
        assertNotNull(denied.pageError(AccessLevelPage.DIRECT_DATA, overview))
    }
    @Test fun retainedUnavailableAccessIsNotErasedWhileChangingItsName() {
        val rule = draft(AccessCapability.DIRECT).rules.single()
        val level = AccessLevelSummary("saved-level", "Before", 7, listOf(rule), 2)
        val missing = overview.copy(sources = emptyList(), levels = listOf(level))
        val renamed = AccessLevelDraft.opening(level, missing).copy(name = "After")
        assertTrue(renamed.validFor(missing))
        assertEquals(listOf(rule), renamed.serializedRules)
        assertEquals(listOf("Name"), renamed.changes(missing).map { it.title })
    }
    @Test fun releaseOnlyReviewDoesNotRepeatUnchangedDataOrFutureSettings() {
        val initial = draft(AccessCapability.ANSWER).rules.single()
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(initial), 2)
        val state = overview.copy(levels = listOf(level), policyFamilies = listOf(AccessPolicyFamilySummary("policy-example", "Default privacy", "1")))
        val changed = AccessLevelDraft.opening(level, state).setRule(initial.copy(release = AccessAnswerRelease.reviewed("policy-example")))
        assertEquals(listOf("Answer release"), changed.changes(state).map { it.title })
        assertEquals(mapOf("answer" to 0), changed.expectedFilterRevisions)
        assertEquals(7, changed.expectedRevision)
    }
    @Test fun futureChoiceKeepsCurrentAccountsAndSavedRestrictionIdentifiers() {
        val policy = ScopePolicy(source.id, ScopeAudience("saved-level", "answer"), listOf(ScopeRule(listOf(ScopeRef("label", "label-example")), "share")), "hide")
        val answer = draft(AccessCapability.ANSWER).rules.single().copy(scopePolicies = listOf(policy), filterRevision = 4)
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(answer), 2)
        val state = overview.copy(levels = listOf(level))
        val initial = AccessLevelDraft.opening(level, state)
        val known = initial.knownSourceIds(state)
        val boundary = AccessSourceSelectionState.from(answer.sources, known).setFutureSourcesAllowed(true, known).boundary(known)
        val changed = initial.setBoundary(boundary, AccessCapability.ANSWER, true)
        assertTrue(sourceAllowed(changed.rules.single().sources, source.id))
        assertEquals(listOf(policy), changed.rules.single().scopePolicies)
        assertEquals(listOf("New sources"), changed.changes(state).map { it.title })
        assertEquals(listOf(AccessLevelPage.FUTURE), changed.changes(state).map { it.page })
        assertEquals(listOf("Name", "Permissions", "Answer data", "Answer release"), changed.unchangedDecisions(state).map { it.title })
        assertEquals(4, changed.serializedRules.single().filterRevision)
    }
    @Test fun newlyEnabledAnswerReviewsItsFutureGrantAndReleaseChoice() {
        val level = AccessLevelSummary("saved", "Helper", 1, listOf(AccessGrantRule.notes()), 0)
        val state = overview.copy(levels = listOf(level))
        listOf(AccessAnswerRelease.unreviewed(), AccessAnswerRelease.reviewed("policy-example")).forEach { release ->
            val changed = AccessLevelDraft.opening(level, state).setRule(AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), release))
            val changes = changed.changes(state)
            assertEquals("Not granted", changes.single { it.title == "New sources" }.before)
            assertEquals("Answer: Automatic", changes.single { it.title == "New sources" }.after)
            assertTrue(changes.any { it.title == "Answer release" })
        }
    }
    @Test fun sameCountReplacementStillReviewsTheActualChangedRestriction() {
        val policy = ScopePolicy(source.id, ScopeAudience("saved", "direct"), listOf(ScopeRule(listOf(ScopeRef("label", "first")), "share")), "hide")
        val rule = draft(AccessCapability.DIRECT).rules.single().copy(scopePolicies = listOf(policy))
        val level = AccessLevelSummary("saved", "Helper", 1, listOf(rule), 0)
        val state = overview.copy(levels = listOf(level))
        val changed = AccessLevelDraft.opening(level, state).setPolicy(policy.copy(rules = listOf(ScopeRule(listOf(ScopeRef("label", "second")), "share"))), source.id, AccessCapability.DIRECT)
        assertEquals(listOf("Direct data"), changed.changes(state).map { it.title })
    }
    @Test fun reviewKeepsItsOpeningBaselineWhenTheOverviewRefreshes() {
        val level = AccessLevelSummary("saved", "Before", 1, listOf(AccessGrantRule.notes()), 0)
        val state = overview.copy(levels = listOf(level))
        val changed = AccessLevelDraft.opening(level, state).copy(name = "My draft")
        val refreshed = state.copy(levels = listOf(level.copy(name = "Remote change", revision = 2)))
        assertEquals("Before", changed.changes(refreshed).single().before)
        assertEquals(1, changed.expectedRevision)
    }
    @Test fun namesAreValidatedAfterTrimmingWithoutChangingTheDraft() {
        val level = AccessLevelSummary("existing", "Project helper", 1, listOf(AccessGrantRule.notes()), 0)
        val state = overview.copy(levels = listOf(level))
        assertNotNull(draft(AccessCapability.NOTES).copy(name = " PROJECT HELPER ").nameError(state))
        assertNotNull(draft(AccessCapability.NOTES).copy(name = "x".repeat(121)).nameError(state))
        assertNull(AccessLevelDraft.opening(level, state).nameError(state))
    }
    @Test fun providerTitlesKeepAFriendlyAccountAndAvoidDuplicatingFormattedIdentifiers() {
        val phone = AccessSourceInstance("chat:+15550100141", "Chat · +1 (555) 010-0141")
        assertNull(phone.accountLabel())
        assertEquals("+1 (555) 010-0141", phone.accountLabel("Chat"))
        val mail = AccessSourceInstance("mail:reader@example.org", "Mail · reader@example.org")
        assertNull(mail.accountLabel())
        assertEquals("reader@example.org", mail.accountLabel("Mail"))
    }
    @Test fun returningToTheOriginalChoiceDoesNotSaveAListOrderOrWhitespaceChange() {
        val original = draft(AccessCapability.ANSWER, AccessCapability.DIRECT).rules
        val level = AccessLevelSummary("saved", "Helper", 1, original, 0)
        val state = overview.copy(levels = listOf(level))
        val answer = original.first { it.capability == AccessCapability.ANSWER }
        val changed = AccessLevelDraft.opening(level, state).setRule(answer.copy(release = AccessAnswerRelease.reviewed("policy-example"))).setRule(answer).copy(name = " Helper ")
        assertFalse(changed.isChangedFrom(level))
        assertTrue(changed.changes(state).isEmpty())
    }
    @Test fun savedUnavailableUnfilteredAccountsStillCountInTheBoundarySummary() {
        val rule = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("mail:unavailable@example.org")))
        assertEquals("1 account selected · all content", ruleDataSummary(rule, overview.copy(sources = emptyList())))
        val excluded = rule.copy(sources = AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("mail:unavailable@example.org")))
        assertEquals("0 accounts selected", ruleDataSummary(excluded, overview.copy(sources = emptyList())))
    }
    @Test fun applyingAnUnchangedPolicyRetainsExactWireOrderAndIsNotADraftChange() {
        val first = ScopePolicy(source.id, ScopeAudience("saved", "direct"), listOf(ScopeRule(listOf(ScopeRef("label", "first")), "share")), "hide")
        val second = first.copy(sourceId = "mail:other@example.org")
        val direct = draft(AccessCapability.DIRECT).rules.single().copy(sources = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id, second.sourceId)), scopePolicies = listOf(first, second), filterRevision = 3)
        val level = AccessLevelSummary("saved", "Helper", 1, listOf(direct), 0)
        val state = overview.copy(sources = overview.sources + AccessSourceInstance(second.sourceId, "Other mail"), levels = listOf(level))
        val unchanged = AccessLevelDraft.opening(level, state).setPolicy(first, source.id, AccessCapability.DIRECT)
        assertFalse(unchanged.isChangedFrom(level))
        assertEquals(listOf(first, second), unchanged.serializedRules.single().scopePolicies)
        assertTrue(unchanged.changes(state).isEmpty())
    }
    @Test fun presentationAndSetOrderAreNotAuthorityChangesButAdvancedRuleOrderIsPreserved() {
        val refs = listOf(ScopeRef("label", "first"), ScopeRef("participant", label = "Before", identifiers = listOf(ScopeIdentifier("email", "reader@example.org"))))
        val policy = ScopePolicy(source.id, ScopeAudience("saved", "direct"), listOf(ScopeRule(refs, "share")), "hide")
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALL, emptyList())).copy(scopePolicies = listOf(policy), filterRevision = 3)
        val level = AccessLevelSummary("saved", "Helper", 1, listOf(direct), 0)
        val state = overview.copy(levels = listOf(level))
        val currentPolicy = policy.copy(rules = listOf(ScopeRule(refs.reversed().map { if (it.kind == "participant") it.copy(label = "Renamed") else it }, "share")))
        val current = AccessLevelDraft.opening(level, state).setRule(direct.copy(sources = AccessSourceBoundary(AccessSourceMode.DENYLIST, emptyList()), scopePolicies = listOf(currentPolicy)))
        assertFalse(current.isChangedFrom(level))
        assertTrue(current.changes(state).isEmpty())
        assertEquals(currentPolicy, current.serializedRules.single().scopePolicies.single())
        val advanced = policy.copy(rules = listOf(policy.rules.single(), ScopeRule(listOf(refs.first()), "hide")))
        assertFalse(sameScopeSettings(listOf(advanced), listOf(advanced.copy(rules = advanced.rules.reversed()))))
    }
    @Test fun recordsAFilterCannotCompareYetAreSaidToWaitForTheirDetails() {
        assertEquals("1 record stays hidden until its details finish syncing.", uncheckedRecordsLine(1))
        assertEquals("4 records stay hidden until their details finish syncing.", uncheckedRecordsLine(4))
    }
}

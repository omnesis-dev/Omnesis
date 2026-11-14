// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** An approval's new access level is the level editor's draft: edited by its steps, validated by its rules and sent as it saves. */
class AccessAuthorizationLevelDraftTest {
    private val notes = AccessSourceInstance("notes:fictional", "Fictional Notes")
    private val files = AccessSourceInstance("files:fictional", "Project Files")
    private val policyFamily = AccessPolicyFamilySummary("policy_example", "Everyday privacy", "4")
    private val overview = AccessOverview(emptyList(), listOf(notes, files), policyFamilies = listOf(policyFamily), defaultPolicyFamilyId = policyFamily.id, sourceFilters = SourceFiltersAvailability(true))
    private fun request(requiresAnswer: Boolean = false) = AccessAuthorizationRequest(
        id = "request_example", approvalId = "approval_example", status = "pending", clientId = "client_example", clientName = "Fictional assistant",
        redirectOrigin = "http://127.0.0.1:10000", resource = "https://gateway.example.com/mcp", scope = "omnesis:access", expiresAt = 2_000_000_000_000, requiresAnswer = requiresAnswer,
    )
    private val filter = SourceFilter(files.id, FilterAudience("new", "answer"), listOf(FilterRule(listOf(FilterRef.item(FilterRef.TREE, "extra.folderId", "folder-example")), "share")), "hide")
    private fun reconnect(vararg rules: AccessGrantRule) = AccessReconnectProposal("client", AccessReconnectPrincipal("principal_example", "Fictional assistant"),
        AccessGrantSummary(id = "grant_example", name = "Fictional assistant access", revision = 2, rules = rules.toList(), credentials = emptyList()))
    private fun fresh() = AccessAuthorizationForm.initial(request(), overview)
    private fun sent(form: AccessAuthorizationForm, overview: AccessOverview = this.overview) = (form.selection(request(), overview) as AccessAuthorizationSelection.Connect).rules

    @Test fun theApprovalOpensOnTheDraftTheLevelEditorOpensANewLevelOn() {
        assertEquals(AccessLevelDraft.opening(null, overview), fresh().level)
        assertNull(fresh().connection)
    }

    @Test fun theApprovalSendsExactlyTheRulesTheDraftSaves() {
        val linked = fresh().editing { it.enabled(AccessCapability.DIRECT, true, overview).enabled(AccessCapability.NOTES, true, overview)
            .reading(AccessCapability.ANSWER, notes.id, files.id).setPolicy(filter, files.id, AccessCapability.ANSWER) }
        val separate = linked.editing { it.setPolicy(null, files.id, AccessCapability.ANSWER).withDirectSameAsAnswer(false).reading(AccessCapability.DIRECT, notes.id) }
        listOf(linked, separate).forEach { form ->
            assertEquals(form.level.serializedRules, sent(form))
            assertEquals(form.level.serializedRules, reviewSummary(request(), overview, form).rules)
            assertProviderWireWrite(sent(form))
        }
        // A rule without filters is sent without filter fields, as a gateway that knows nothing of filters expects.
        assertTrue(sent(separate).all { it.filterRevision == null && it.scopePolicies.isEmpty() })
        val filtered = sent(linked).filter { it.capability != AccessCapability.NOTES }
        assertEquals(2, filtered.size)
        assertTrue(filtered.all { it.filterRevision == 0 && it.scopePolicies.single().audience == FilterAudience("new", it.capability.wire) })
    }

    @Test fun aKnownClientsRulesStartTheDraftAddressedToTheNewLevel() {
        val saved = filter.copy(audience = FilterAudience("level-example", "answer"))
        val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(files.id))
        val form = AccessAuthorizationForm.initial(request(), overview, reconnect = reconnect(
            AccessGrantRule.answer(boundary, AccessAnswerRelease.reviewed(policyFamily.id)).copy(filterRevision = 6, scopePolicies = listOf(saved)),
            AccessGrantRule.direct(boundary).copy(filterRevision = 3, scopePolicies = listOf(saved.copy(audience = FilterAudience("level-example", "direct")))),
        ))
        // Direct reads exactly what Answer reads, filters included, so the draft opens with the two linked as the level editor opens them.
        assertTrue(form.level.directLinked)
        assertTrue(sent(form).all { it.filterRevision == 0 && it.scopePolicies.single().audience == FilterAudience("new", it.capability.wire) })
        assertEquals(filter.rules, sent(form).first().scopePolicies.single().rules)
    }

    @Test fun switchingDirectOnBesideAnswerStartsFromAnswersSources() {
        val both = fresh().editing { it.reading(AccessCapability.ANSWER, notes.id).enabled(AccessCapability.DIRECT, true, overview) }
        assertTrue(both.level.directLinked)
        assertEquals(sent(both).single { it.capability == AccessCapability.ANSWER }.sources, sent(both).single { it.capability == AccessCapability.DIRECT }.sources)
    }

    @Test fun anAgentThatRequiresAnswerStartsWithItWhateverItHeld() {
        val form = AccessAuthorizationForm.initial(request(requiresAnswer = true), overview, reconnect = reconnect(AccessGrantRule.notes()))
        assertEquals(setOf(AccessCapability.NOTES, AccessCapability.ANSWER), form.level.rules.mapTo(mutableSetOf()) { it.capability })
        assertTrue(AccessAuthorizationStep.DATA in authorizationSteps(form))
        assertNull(form.selection(request(requiresAnswer = true), overview))
    }

    @Test fun aReviewedReleaseWithNoPolicyToChooseStaysUndecidedUntilTheOwnerDecides() {
        val unpublished = overview.copy(policyFamilies = emptyList(), defaultPolicyFamilyId = null)
        val form = AccessAuthorizationForm.initial(request(), unpublished).editing { it.reading(AccessCapability.ANSWER, notes.id) }
        assertTrue(form.level.requireAnswerPolicySelection)
        assertFalse(form.level.releaseValid(unpublished))
        assertNull(form.selection(request(), unpublished))
        val released = form.editing { draft -> draft.setRule(requireNotNull(draft.rule(AccessCapability.ANSWER)).copy(release = AccessAnswerRelease.unreviewed())).copy(requireAnswerPolicySelection = false) }
        assertEquals(AccessAnswerRelease.unreviewed(), sent(released, unpublished).single().release)
    }

    @Test fun whatTheEditorRefusesTheApprovalRefusesInTheSameWords() {
        val none = fresh()
        assertEquals("Select at least one source for Answer.", none.permissionsError(overview))
        assertEquals(none.level.pageError(AccessLevelPage.ANSWER_DATA, overview), none.permissionsError(overview))
        assertEquals("Choose at least one permission.", none.editing { it.enabled(AccessCapability.ANSWER, false, overview) }.permissionsError(overview))
        // An account that is no longer connected cannot be what a capability reads.
        val gone = overview.copy(sources = listOf(notes.copy(available = false)))
        assertEquals("Select at least one source for Answer.", none.editing { it.reading(AccessCapability.ANSWER, notes.id) }.permissionsError(gone))
        val sources = (1..257).map { AccessSourceInstance("notes:$it", "Note $it") }
        val many = overview.copy(sources = sources)
        val all = none.editing { it.reading(AccessCapability.ANSWER, *sources.map { source -> source.id }.toTypedArray()) }
        assertEquals("Answer can record at most 256 source selections.", all.permissionsError(many))
        assertNull(all.selection(request(), many))
        val allBlocked = none.editing { it.setBoundary(AccessSourceBoundary(AccessSourceMode.DENYLIST, sources.map { source -> source.id }), AccessCapability.ANSWER, true) }
        assertEquals("Answer can record at most 256 source selections.", allBlocked.permissionsError(many))
    }

    @Test fun aNewLevelWithFiltersIsRefusedWhileFiltersCannotBeAuthored() {
        val filtered = fresh().editing { it.reading(AccessCapability.ANSWER, files.id).setPolicy(filter, files.id, AccessCapability.ANSWER) }
        val disabled = overview.copy(sourceFilters = SourceFiltersAvailability(false))
        assertNull(filtered.permissionsError(overview))
        assertTrue(filtered.filtersUnavailable(disabled))
        assertEquals(FILTERS_UNAVAILABLE_MESSAGE, filtered.permissionsError(disabled))
        assertNull(filtered.selection(request(), disabled))
        // A filter the level would not save does not count.
        assertFalse(filtered.editing { it.reading(AccessCapability.ANSWER, notes.id) }.filtersUnavailable(disabled))
    }

    @Test fun dataAndPrivacyAsksOneDecisionPerScreenAndOnlyTheOnesThatApply() {
        fun pages(form: AccessAuthorizationForm) = authorizationPositions(form).map { it.step to it.dataPage }
        val both = fresh().editing { it.enabled(AccessCapability.DIRECT, true, overview) }
        assertEquals(listOf(
            AccessAuthorizationStep.PERMISSIONS to null,
            AccessAuthorizationStep.DATA to AccessLevelPage.ANSWER_DATA,
            AccessAuthorizationStep.DATA to AccessLevelPage.DIRECT_CHOICE,
            AccessAuthorizationStep.DATA to AccessLevelPage.FUTURE,
            AccessAuthorizationStep.DATA to AccessLevelPage.RELEASE,
            AccessAuthorizationStep.REVIEW to null,
        ), pages(both))
        assertEquals(pages(both), pages(both.editing { it.withDirectSameAsAnswer(false) }))
        // The decisions are the level editor's own for a new level, between its Permissions and its review.
        assertEquals(both.level.createPages().drop(1).dropLast(1), pages(both).mapNotNull { it.second })
        assertEquals(listOf(AccessLevelPage.DIRECT_DATA, AccessLevelPage.FUTURE), pages(both.editing { it.enabled(AccessCapability.ANSWER, false, overview) }).mapNotNull { it.second })
        assertEquals(listOf(AccessLevelPage.ANSWER_DATA, AccessLevelPage.FUTURE, AccessLevelPage.RELEASE), pages(fresh()).mapNotNull { it.second })
        val notesOnly = fresh().editing { it.enabled(AccessCapability.ANSWER, false, overview).enabled(AccessCapability.NOTES, true, overview) }
        assertEquals(listOf(AccessAuthorizationStep.PERMISSIONS to null, AccessAuthorizationStep.REVIEW to null), pages(notesOnly))
    }

    @Test fun aStepOpensOnItsFirstScreenAndGoingBackFromReviewLandsOnTheLastDecision() {
        val positions = authorizationPositions(fresh().editing { it.enabled(AccessCapability.DIRECT, true, overview) })
        assertEquals(1, authorizationPositionIndex(positions, AccessAuthorizationStep.DATA, null))
        assertEquals(4, authorizationPositionIndex(positions, AccessAuthorizationStep.DATA, AccessLevelPage.RELEASE))
        // A decision the approval no longer asks falls back to the step's first.
        assertEquals(1, authorizationPositionIndex(positions, AccessAuthorizationStep.DATA, AccessLevelPage.DIRECT_DATA))
        val review = authorizationPositionIndex(positions, AccessAuthorizationStep.REVIEW, AccessLevelPage.RELEASE)
        assertEquals(positions.lastIndex, review)
        assertEquals(AccessAuthorizationPosition(AccessAuthorizationStep.DATA, AccessLevelPage.RELEASE), positions[review - 1])
        assertEquals(0, authorizationPositionIndex(positions, AccessAuthorizationStep.PERMISSIONS, null))
    }
}

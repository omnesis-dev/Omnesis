// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessPolicyFamilySummary
import dev.omnesis.android.transport.dto.AccessPrincipalSummary
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceInstance
import dev.omnesis.android.transport.dto.AccessSourceMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * How the grant decision presents itself: one colour per capability, refusals named for every
 * capability they govern, and a review that states the access rather than the form fields.
 */
class AccessAuthorizationPresentationTest {

    /* ── A capability is one colour everywhere, and a granted one is never the withheld grey ── */

    @Test fun each_capability_holds_its_own_tone_when_granted() {
        assertEquals(
            AccessCapabilityTone.REVIEWED,
            capabilityTone(AccessCapabilitySlot.ANSWER, granted = true),
        )
        assertEquals(
            AccessCapabilityTone.RAW,
            capabilityTone(AccessCapabilitySlot.DIRECT, granted = true),
        )
        assertEquals(
            AccessCapabilityTone.WRITE,
            capabilityTone(AccessCapabilitySlot.NOTES, granted = true),
        )
    }

    @Test fun a_granted_capability_is_never_the_withheld_tone() {
        for (slot in AccessCapabilitySlot.entries) {
            assertNotEquals(AccessCapabilityTone.WITHHELD, capabilityTone(slot, granted = true))
            assertEquals(AccessCapabilityTone.WITHHELD, capabilityTone(slot, granted = false))
        }
    }

    /** Danger belongs to Direct alone: two dangers on one row means neither is read as one. */
    @Test fun unreviewed_answer_release_is_the_warning_tone_not_the_direct_danger() {
        assertEquals(
            AccessCapabilityTone.WARNING,
            capabilityTone(AccessCapabilitySlot.ANSWER, granted = true, unreviewed = true),
        )
        assertNotEquals(
            capabilityTone(AccessCapabilitySlot.DIRECT, granted = true),
            capabilityTone(AccessCapabilitySlot.ANSWER, granted = true, unreviewed = true),
        )
        // Only Answer is released; the flag never recolours the other two.
        assertEquals(
            AccessCapabilityTone.RAW,
            capabilityTone(AccessCapabilitySlot.DIRECT, granted = true, unreviewed = true),
        )
    }

    @Test fun a_badge_reads_out_whether_the_capability_is_held() {
        assertEquals(
            "Answer granted",
            capabilityBadgeDescription(AccessCapabilitySlot.ANSWER, granted = true),
        )
        assertEquals(
            "Direct not granted",
            capabilityBadgeDescription(AccessCapabilitySlot.DIRECT, granted = false),
        )
        assertEquals(
            "Answer granted, released without privacy review",
            capabilityBadgeDescription(AccessCapabilitySlot.ANSWER, granted = true, unreviewed = true),
        )
    }

    /* ── A refusal names every capability the list it sits in governs ── */

    @Test fun a_shared_source_list_names_both_capabilities_in_its_refusal() {
        val empty = AccessSourceSelectionState()
        assertEquals(
            "Select at least one source for Answer and Direct.",
            sourceBoundaryError(empty, known, AccessSourceScope.SHARED),
        )
        assertEquals(
            "Select at least one source for Answer.",
            sourceBoundaryError(empty, known, AccessSourceScope.ANSWER),
        )
        assertEquals(
            "Select at least one source for Direct.",
            sourceBoundaryError(empty, known, AccessSourceScope.DIRECT),
        )
    }

    @Test fun a_satisfied_source_list_earns_no_refusal() {
        val chosen = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional"))
        assertNull(sourceBoundaryError(chosen, known, AccessSourceScope.ANSWER))
        assertNull(
            sourceBoundaryError(
                AccessSourceSelectionState(mode = AccessSourceMode.ALL),
                known,
                AccessSourceScope.SHARED,
            ),
        )
    }

    @Test fun a_list_with_nothing_to_show_says_so_rather_than_asking_for_a_selection() {
        assertEquals(
            "No sources are connected. Connect a source before approving this access.",
            sourceBoundaryError(AccessSourceSelectionState(), emptySet(), AccessSourceScope.ANSWER),
        )
    }

    @Test fun the_source_selection_cap_is_named_for_the_list_that_holds_it() {
        val ids = (1..MAX_ACCESS_SOURCE_IDS + 1).mapTo(mutableSetOf()) { "notes:$it" }
        val state = AccessSourceSelectionState(allowedSourceIds = ids)
        assertEquals(
            "Answer and Direct can record at most $MAX_ACCESS_SOURCE_IDS source selections.",
            sourceBoundaryError(state, ids, AccessSourceScope.SHARED),
        )
    }

    /* ── The shared-vs-separate boundary is a plain two-option choice ── */

    @Test fun a_linked_boundary_is_one_list_serialized_to_both_capabilities() {
        val overview = overview()
        val form = AccessAuthorizationForm.initial(request(), overview).copy(
            directEnabled = true,
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
            directSources = AccessSourceSelectionState(allowedSourceIds = setOf("files:fictional")),
        )
        assertTrue(form.linkedSources)
        assertEquals(form.answerSources, form.directBoundary(answerOn = true))

        val rules = (form.selection(request(), overview) as AccessAuthorizationSelection.Connect).rules
        val answer = rules.single { it.capability == AccessCapability.ANSWER }
        val direct = rules.single { it.capability == AccessCapability.DIRECT }
        assertEquals(answer.sources, direct.sources)
        assertEquals(listOf("notes:fictional"), direct.sources.sourceIds)
    }

    @Test fun unlinking_hands_direct_the_boundary_that_was_in_force() {
        val form = AccessAuthorizationForm(
            directEnabled = true,
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
            directSources = AccessSourceSelectionState(),
        )
        val split = form.withLinkedSources(false, answerOn = true)
        assertFalse(split.linkedSources)
        assertEquals(setOf("notes:fictional"), split.directSources.allowedSourceIds)
        assertEquals(split.directSources, split.directBoundary(answerOn = true))

        val rejoined = split.withLinkedSources(true, answerOn = true)
        assertTrue(rejoined.linkedSources)
        assertEquals(rejoined.answerSources, rejoined.directBoundary(answerOn = true))
    }

    /** Direct on its own has no Answer list to share, linked or not. */
    @Test fun direct_alone_keeps_its_own_boundary() {
        val form = AccessAuthorizationForm(
            answerEnabled = false,
            directEnabled = true,
            directSources = AccessSourceSelectionState(allowedSourceIds = setOf("files:fictional")),
        )
        assertEquals(form.directSources, form.directBoundary(answerOn = false))
    }

    @Test fun the_second_reading_capability_only_joins_a_list_it_already_agrees_with() {
        val chosenForDirect = AccessAuthorizationForm(
            answerEnabled = false,
            directSources = AccessSourceSelectionState(allowedSourceIds = setOf("files:fictional")),
        )
        val bothOn = chosenForDirect.copy(directEnabled = true, answerEnabled = true)
            .relinkSources(answerOn = true, directOn = true)
        assertFalse(bothOn.linkedSources)
        assertEquals(setOf("files:fictional"), bothOn.directBoundary(answerOn = true).allowedSourceIds)

        val untouched = AccessAuthorizationForm(directEnabled = true).relinkSources(answerOn = true, directOn = true)
        assertTrue(untouched.linkedSources)
    }

    /* ── The review states the access as rows: one per source list, then Answer's privacy ── */

    @Test fun the_review_lists_one_source_row_per_list_the_form_asks_for() {
        val both = AccessAuthorizationForm(answerEnabled = true, directEnabled = true)
        assertEquals(listOf(AccessSourceScope.SHARED), both.copy(linkedSources = true).sourceScopes(answerOn = true))
        assertEquals(
            listOf(AccessSourceScope.ANSWER, AccessSourceScope.DIRECT),
            both.copy(linkedSources = false).sourceScopes(answerOn = true),
        )
        assertEquals(listOf(AccessSourceScope.ANSWER), both.copy(directEnabled = false).sourceScopes(answerOn = true))
        assertEquals(listOf(AccessSourceScope.DIRECT), both.copy(answerEnabled = false).sourceScopes(answerOn = false))
        val notesOnly = AccessAuthorizationForm(answerEnabled = false, notesEnabled = true)
        assertEquals(emptyList<AccessSourceScope>(), notesOnly.sourceScopes(answerOn = false))
        // A request that requires Answer reads sources even while the form has it switched off.
        assertEquals(listOf(AccessSourceScope.ANSWER), notesOnly.sourceScopes(answerOn = true))
    }

    @Test fun the_shared_and_answer_rows_read_the_answer_list_and_direct_reads_its_own() {
        val answer = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional"))
        val direct = AccessSourceSelectionState(allowedSourceIds = setOf("files:fictional"))
        val form = AccessAuthorizationForm(answerSources = answer, directSources = direct)
        assertEquals(answer, form.sources(AccessSourceScope.SHARED))
        assertEquals(answer, form.sources(AccessSourceScope.ANSWER))
        assertEquals(direct, form.sources(AccessSourceScope.DIRECT))
    }

    @Test fun a_source_list_is_summarised_as_everything_a_count_kept_or_a_count_blocked() {
        val overview = overview()
        assertEquals("All sources", sourceSummary(AccessSourceSelectionState(mode = AccessSourceMode.ALL), overview))
        assertEquals(
            "1 selected source",
            sourceSummary(AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")), overview),
        )
        assertEquals("2 selected sources", sourceSummary(AccessSourceSelectionState(allowedSourceIds = known), overview))
        // A source the list names but that is no longer connected is not counted as selected.
        assertEquals(
            "0 selected sources",
            sourceSummary(AccessSourceSelectionState(allowedSourceIds = setOf("mail:removed")), overview),
        )
        val blockingOne = AccessSourceSelectionState.from(
            AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("files:fictional")),
            known,
        )
        assertEquals("All except 1 blocked", sourceSummary(blockingOne, overview))
        val blockingNothingConnected = AccessSourceSelectionState.from(
            AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("mail:removed")),
            known,
        )
        assertEquals("All sources", sourceSummary(blockingNothingConnected, overview))
    }

    @Test fun answer_privacy_names_the_policy_or_says_there_is_none() {
        val overview = overview()
        val reviewed = AccessAuthorizationForm.initial(request(), overview)
        assertEquals("Everyday", reviewed.answerPrivacySummary(overview))
        assertEquals("Privacy policy", reviewed.copy(policyFamilyId = "policy_unpublished").answerPrivacySummary(overview))
        assertEquals(
            "No privacy review",
            reviewed.copy(answerRelease = AccessAnswerReleaseChoice.UNREVIEWED).answerPrivacySummary(overview),
        )
    }

    private val known = setOf("notes:fictional", "files:fictional")

    private fun overview() = AccessOverview(
        principals = emptyList<AccessPrincipalSummary>(),
        sources = known.map { AccessSourceInstance(it, it) },
        policyFamilies = listOf(AccessPolicyFamilySummary("policy_example", "Everyday", "3")),
        defaultPolicyFamilyId = "policy_example",
    )

    private fun request() = AccessAuthorizationRequest(
        id = "request_example",
        approvalId = "approval_example",
        status = "pending",
        clientId = "client_example",
        clientName = "Fictional assistant",
        redirectOrigin = "http://127.0.0.1:10000",
        resource = "https://gateway.example.com/mcp",
        scope = "omnesis:access",
        expiresAt = 2_000_000_000_000,
        requiresAnswer = false,
    )
}

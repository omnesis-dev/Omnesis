// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.AccessAnswerRelease
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessPolicyFamilySummary
import dev.omnesis.android.transport.dto.AccessPrincipalSummary
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceInstance
import dev.omnesis.android.transport.dto.AccessSourceMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
            capabilityTone(AccessCapability.ANSWER, granted = true),
        )
        assertEquals(
            AccessCapabilityTone.RAW,
            capabilityTone(AccessCapability.DIRECT, granted = true),
        )
        assertEquals(
            AccessCapabilityTone.WRITE,
            capabilityTone(AccessCapability.NOTES, granted = true),
        )
    }

    @Test fun a_granted_capability_is_never_the_withheld_tone() {
        for (capability in ACCESS_CAPABILITIES) {
            assertNotEquals(AccessCapabilityTone.WITHHELD, capabilityTone(capability, granted = true))
            assertEquals(AccessCapabilityTone.WITHHELD, capabilityTone(capability, granted = false))
        }
        assertEquals(AccessCapability.entries.toSet(), ACCESS_CAPABILITIES.toSet())
    }

    @Test fun the_capability_pills_read_out_what_is_allowed_and_what_is_not() {
        assertEquals("Answer and Direct allowed, Notes not allowed", AccessCapabilityHoldings(answer = true, direct = true, notes = false).description)
        assertEquals("Answer, Direct and Notes allowed", AccessCapabilityHoldings(answer = true, direct = true, notes = true).description)
        assertEquals("Notes allowed, Answer and Direct not allowed", AccessCapabilityHoldings(answer = false, direct = false, notes = true).description)
        assertEquals("Answer, Direct and Notes not allowed", AccessCapabilityHoldings(answer = false, direct = false, notes = false).description)
    }

    @Test fun the_capability_pills_are_the_rules_capabilities() {
        val rules = listOf(
            AccessGrantRule.notes(),
            AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()),
        )
        assertEquals(AccessCapabilityHoldings(answer = true, direct = false, notes = true), AccessCapabilityHoldings.of(rules))
    }

    /* ── The shared-vs-separate boundary is a plain two-option choice ── */

    @Test fun a_linked_boundary_is_one_list_serialized_to_both_capabilities() {
        val overview = overview()
        val form = AccessAuthorizationForm.initial(request(), overview).editing { it.reading(AccessCapability.ANSWER, "notes:fictional").enabled(AccessCapability.DIRECT, true, overview) }
        assertTrue(form.level.directLinked)

        val rules = (form.selection(request(), overview) as AccessAuthorizationSelection.Connect).rules
        val answer = rules.single { it.capability == AccessCapability.ANSWER }
        val direct = rules.single { it.capability == AccessCapability.DIRECT }
        assertEquals(answer.sources, direct.sources)
        assertEquals(listOf("notes:fictional"), direct.sources.sourceIds)
    }

    /** Direct on its own has no Answer list to share, linked or not. */
    @Test fun direct_alone_keeps_its_own_boundary() {
        val overview = overview()
        val form = AccessAuthorizationForm.initial(request(), overview).editing {
            it.enabled(AccessCapability.DIRECT, true, overview).withDirectSameAsAnswer(false).reading(AccessCapability.DIRECT, "files:fictional").enabled(AccessCapability.ANSWER, false, overview)
        }
        assertFalse(form.level.directLinked)
        val rules = (form.selection(request(), overview) as AccessAuthorizationSelection.Connect).rules
        assertEquals(listOf("files:fictional"), rules.single().sources.sourceIds)
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

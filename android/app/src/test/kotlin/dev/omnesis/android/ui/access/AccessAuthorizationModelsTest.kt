// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AccessAnswerRelease
import dev.omnesis.android.transport.dto.AccessAnswerReleaseMode
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessGrantSummary
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessPolicyFamilySummary
import dev.omnesis.android.transport.dto.AccessReconnectPrincipal
import dev.omnesis.android.transport.dto.AccessReconnectProposal
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceInstance
import dev.omnesis.android.transport.dto.AccessSourceMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessAuthorizationModelsTest {
    @Test fun notes_only_approval_needs_no_sources_or_privacy_policy() {
        val overview = overview().copy(sources = emptyList(), policyFamilies = emptyList())
        val form = AccessAuthorizationForm.initial(request(), overview).copy(answerEnabled = false, notesEnabled = true)
        val selection = form.selection(request(), overview) as AccessAuthorizationSelection.Connect
        assertEquals(listOf(AccessGrantRule.notes()), selection.rules)
        assertNull(form.copy(notesEnabled = false).selection(request(), overview))
        assertNull(form.copy(answerEnabled = true).selection(request(), overview))
    }

    private val known = setOf("notes:fictional", "files:fictional")

    @Test fun denylist_keeps_future_sources_allowed_and_preserves_unavailable_denials() {
        val state = AccessSourceSelectionState.from(
            AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("notes:fictional", "mail:removed")),
            known,
        )
        assertEquals(setOf("files:fictional"), state.allowedSourceIds)
        assertEquals(
            listOf("mail:removed", "notes:fictional"),
            state.boundary(known).sourceIds,
        )
        val withFuture = state.setAllowed("calendar:future", true)
        assertTrue(withFuture.permitsAnyKnownSource(known + "calendar:future"))
        assertFalse("calendar:future" in withFuture.boundary(known + "calendar:future").sourceIds)
    }

    @Test fun empty_effective_source_selection_cannot_be_approved() {
        val overview = overview()
        val form = AccessAuthorizationForm.initial(request(), overview)
        assertNull(form.selection(request(), overview))
        val allowed = form.copy(answerSources = form.answerSources.setAllowed("notes:fictional", true))
        assertTrue(allowed.selection(request(), overview) is AccessAuthorizationSelection.Connect)
    }

    @Test fun unavailable_sources_never_make_an_empty_grant_valid() {
        val overview = overview().copy(
            sources = listOf(AccessSourceInstance("notes:fictional", "Removed notes", available = false)),
        )
        val form = AccessAuthorizationForm.initial(request(), overview).copy(
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
        )
        assertNull(form.selection(request(), overview))
    }

    @Test fun blocking_everything_stays_blocked_when_a_source_is_connected_later() {
        val blocked = AccessSourceSelectionState(mode = AccessSourceMode.ALL, allowedSourceIds = known).blockAll(known)
        assertEquals(AccessSourceMode.ALLOWLIST, blocked.mode)
        assertFalse(blocked.futureSourcesAllowed)
        assertFalse(blocked.permitsAnyKnownSource(known))
        assertEquals(emptyList<String>(), blocked.boundary(known).sourceIds)
    }

    @Test fun unchecking_a_source_under_all_sources_is_recorded_rather_than_lost() {
        val state = AccessSourceSelectionState(mode = AccessSourceMode.ALL, allowedSourceIds = known)
            .setAllowed("notes:fictional", false)
        assertEquals(AccessSourceMode.DENYLIST, state.mode)
        assertFalse(state.allows("notes:fictional"))
        assertTrue(state.allows("files:fictional"))
        assertEquals(listOf("notes:fictional"), state.boundary(known).sourceIds)
    }

    @Test fun the_future_source_choice_never_changes_which_sources_are_allowed_now() {
        val allowlist = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional"))
        assertTrue(allowlist.futureSourcesAllowed.not())

        val opened = allowlist.setFutureSourcesAllowed(true, known)
        assertEquals(AccessSourceMode.DENYLIST, opened.mode)
        assertTrue(opened.futureSourcesAllowed)
        assertTrue(opened.allows("notes:fictional"))
        assertFalse(opened.allows("files:fictional"))

        val closed = opened.setFutureSourcesAllowed(false, known)
        assertEquals(AccessSourceMode.ALLOWLIST, closed.mode)
        assertEquals(listOf("notes:fictional"), closed.boundary(known).sourceIds)

        val everything = AccessSourceSelectionState(allowedSourceIds = known).setFutureSourcesAllowed(true, known)
        assertEquals(AccessSourceMode.ALL, everything.mode)
        assertEquals(emptyList<String>(), everything.boundary(known).sourceIds)
    }

    /** Unreviewed release is chosen outright: there is no second box confirming the first. */
    @Test fun unreviewed_answer_release_is_the_choice_itself() {
        val overview = overview()
        val base = AccessAuthorizationForm.initial(request(), overview).copy(
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
            answerRelease = AccessAnswerReleaseChoice.UNREVIEWED,
        )
        assertEquals(
            AccessAnswerReleaseMode.UNREVIEWED,
            (base.selection(request(), overview)
                as? AccessAuthorizationSelection.Connect)?.rules?.single()?.release?.mode,
        )
    }

    /** The owner names nothing: the credential is labelled with the client's own name. */
    @Test fun the_credential_is_labelled_with_the_client_name_within_the_gateway_limit() {
        val overview = overview()
        val form = AccessAuthorizationForm.initial(request(), overview).copy(
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
        )
        val selection = form.selection(request(), overview) as AccessAuthorizationSelection.Connect
        assertEquals("Fictional assistant", selection.credentialLabel)

        val long = form.selection(request().copy(clientName = "n".repeat(200)), overview)
            as AccessAuthorizationSelection.Connect
        assertEquals(160, long.credentialLabel.length)

        val emoji = form.selection(request().copy(clientName = "\uD83E\uDD8A".repeat(100)), overview)
            as AccessAuthorizationSelection.Connect
        assertTrue(emoji.credentialLabel.length <= 160)
        assertFalse(emoji.credentialLabel.last().isHighSurrogate())
    }

    /* ── A client the gateway already knows starts from the access it holds today ── */

    @Test fun a_fresh_client_starts_with_reviewed_answer_and_the_default_policy() {
        val form = AccessAuthorizationForm.initial(request(), overview())
        assertTrue(form.answerEnabled)
        assertFalse(form.directEnabled)
        assertFalse(form.notesEnabled)
        assertEquals(AccessAnswerReleaseChoice.REVIEWED, form.answerRelease)
        assertEquals("policy_example", form.policyFamilyId)
        assertEquals(AccessSourceSelectionState(), form.answerSources)
    }

    @Test fun a_known_client_is_prefilled_from_its_grant_rules() {
        val overview = overview().copy(
            policyFamilies = overview().policyFamilies + AccessPolicyFamilySummary("policy_other", "Strict", "1"),
        )
        val form = AccessAuthorizationForm.initial(
            request(),
            overview,
            reconnect = reconnect(
                AccessGrantRule.notes(),
                AccessGrantRule.answer(
                    AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional")),
                    AccessAnswerRelease.reviewed("policy_other"),
                ),
                AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("files:fictional"))),
            ),
        )
        assertTrue(form.answerEnabled)
        assertTrue(form.directEnabled)
        assertTrue(form.notesEnabled)
        assertEquals("policy_other", form.policyFamilyId)
        assertEquals(AccessAnswerReleaseChoice.REVIEWED, form.answerRelease)
        assertEquals(setOf("notes:fictional"), form.answerSources.allowedSourceIds)
        assertFalse(form.answerSources.futureSourcesAllowed)
        assertEquals(AccessSourceMode.DENYLIST, form.directSources.mode)
        assertTrue(form.directSources.allows("notes:fictional"))
        assertFalse(form.directSources.allows("files:fictional"))
        // Two boundaries that differ are edited as two lists.
        assertFalse(form.linkedSources)

        val rules = (form.selection(request(), overview) as AccessAuthorizationSelection.Connect).rules
        assertEquals(
            listOf(AccessCapability.NOTES, AccessCapability.ANSWER, AccessCapability.DIRECT),
            rules.map { it.capability },
        )
        assertEquals(listOf("notes:fictional"), rules[1].sources.sourceIds)
        assertEquals(listOf("files:fictional"), rules[2].sources.sourceIds)
    }

    @Test fun a_known_client_with_one_boundary_for_both_capabilities_edits_one_list() {
        val everything = AccessSourceBoundary(AccessSourceMode.ALL, emptyList())
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            reconnect = reconnect(
                AccessGrantRule.answer(everything, AccessAnswerRelease.unreviewed()),
                AccessGrantRule.direct(everything),
            ),
        )
        assertTrue(form.linkedSources)
        assertEquals(AccessAnswerReleaseChoice.UNREVIEWED, form.answerRelease)
        assertEquals(AccessSourceMode.ALL, form.answerSources.mode)
        // The default policy stays on hand for the moment Answer is switched back to reviewed.
        assertEquals("policy_example", form.policyFamilyId)
    }

    @Test fun a_known_client_without_answer_keeps_answer_off() {
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            reconnect = reconnect(AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("files:fictional")))),
        )
        assertFalse(form.answerEnabled)
        assertTrue(form.directEnabled)
        assertEquals(setOf("files:fictional"), form.directSources.allowedSourceIds)
        assertEquals(listOf(AccessAuthorizationStep.PERMISSIONS, AccessAuthorizationStep.DATA, AccessAuthorizationStep.REVIEW), authorizationSteps(form, requiresAnswer = false))
    }

    @Test fun a_known_client_whose_policy_is_no_longer_published_is_reviewed_by_the_default() {
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            reconnect = reconnect(
                AccessGrantRule.answer(
                    AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional")),
                    AccessAnswerRelease.reviewed("policy_unpublished"),
                ),
            ),
        )
        assertEquals(AccessAnswerReleaseChoice.REVIEWED, form.answerRelease)
        assertEquals("policy_example", form.policyFamilyId)
        val rules = (form.selection(request(), overview()) as AccessAuthorizationSelection.Connect).rules
        assertEquals("policy_example", rules.single().release?.policyFamilyId)
    }

    @Test fun a_known_client_on_a_gateway_with_no_published_policy_keeps_reviewed_with_nothing_to_send() {
        val overview = overview().copy(policyFamilies = emptyList(), defaultPolicyFamilyId = null)
        val form = AccessAuthorizationForm.initial(
            request(),
            overview,
            reconnect = reconnect(
                AccessGrantRule.answer(
                    AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional")),
                    AccessAnswerRelease.reviewed("policy_unpublished"),
                ),
            ),
        )
        assertEquals("", form.policyFamilyId)
        assertNull(form.selection(request(), overview))
    }

    @Test fun a_known_client_referencing_a_source_no_longer_connected_keeps_the_reference() {
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            reconnect = reconnect(
                AccessGrantRule.answer(
                    AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("mail:removed")),
                    AccessAnswerRelease.reviewed("policy_example"),
                ),
            ),
        )
        assertEquals(setOf("mail:removed"), form.answerSources.unavailableReferencedIds)
        assertEquals(listOf("mail:removed"), form.answerSources.boundary(known).sourceIds)
    }

    @Test fun source_exception_cap_is_enforced_locally() {
        val sources = (1..257).map { AccessSourceInstance("notes:$it", "Note $it") }
        val overview = overview().copy(sources = sources)
        val form = AccessAuthorizationForm.initial(request(), overview).copy(
            answerSources = AccessSourceSelectionState(
                mode = AccessSourceMode.ALLOWLIST,
                allowedSourceIds = sources.mapTo(mutableSetOf()) { it.id },
            ),
        )
        assertNull(form.selection(request(), overview))
    }

    @Test fun deadline_copy_counts_down_and_expires() {
        assertEquals("Expires in 10 minutes.", authorizationDeadlineText(700_000, 100_000))
        assertEquals("This request has expired.", authorizationDeadlineText(100_000, 100_000))
    }

    private fun overview() = AccessOverview(
        principals = emptyList(),
        sources = known.map { AccessSourceInstance(it, it) },
        policyFamilies = listOf(AccessPolicyFamilySummary("policy_example", "Everyday", "3")),
        defaultPolicyFamilyId = "policy_example",
    )

    /**
     * The chip titles are a cross-platform contract: iOS and the portal render the
     * same steps from their own copies of these strings, so a change here that is
     * not mirrored there is a divergence, not a tweak.
     */
    @Test
    fun `step titles match the iOS wizard`() {
        assertEquals(
            listOf("Connection", "Permissions", "Data & privacy", "Review"),
            AccessAuthorizationStep.entries.map { it.title },
        )
    }

    /**
     * Only the one title too wide for a narrow phone is shortened; the full
     * title stays the step's accessible name.
     */
    @Test
    fun `only the widest step is abbreviated`() {
        assertEquals(
            listOf("Connection", "Permissions", "Data", "Review"),
            AccessAuthorizationStep.entries.map { it.shortTitle },
        )
        AccessAuthorizationStep.entries
            .filter { it != AccessAuthorizationStep.DATA }
            .forEach { assertEquals(it.title, it.shortTitle) }
    }

    /**
     * The step list is what the chips number, so a flow that drops a step must
     * renumber the rest. iOS derives the same two shapes.
     */
    @Test
    fun `a grant that reads sources asks every step`() {
        val form = AccessAuthorizationForm(answerEnabled = true)
        assertEquals(
            listOf(
                AccessAuthorizationStep.PERMISSIONS,
                AccessAuthorizationStep.DATA,
                AccessAuthorizationStep.REVIEW,
            ),
            authorizationSteps(form, requiresAnswer = false),
        )
    }

    @Test
    fun `a notes-only grant skips data and privacy`() {
        val form = AccessAuthorizationForm(
            answerEnabled = false,
            directEnabled = false,
            notesEnabled = true,
        )
        val steps = authorizationSteps(form, requiresAnswer = false)
        assertEquals(
            listOf(AccessAuthorizationStep.PERMISSIONS, AccessAuthorizationStep.REVIEW),
            steps,
        )
        // Review is the second chip, not the third.
        assertEquals(1, steps.indexOf(AccessAuthorizationStep.REVIEW))
    }

    @Test
    fun `a request that requires Answer keeps data and privacy`() {
        val form = AccessAuthorizationForm(answerEnabled = false, directEnabled = false)
        assertTrue(authorizationSteps(form, requiresAnswer = true).contains(AccessAuthorizationStep.DATA))
    }

    /**
     * The four failures below need four different actions from the owner, so a
     * single "try again" is the one answer that helps with none of them. iOS
     * classifies the same cases into the same sentences.
     */
    @Test
    fun `an untrusted certificate says to re-pair`() {
        val message = accessAuthorizationUnmappedMessage(
            GatewayException.Network(javax.net.ssl.SSLHandshakeException("bad chain")),
        )
        assertTrue(message, message.contains("not trusted"))
        assertTrue(message, message.contains("Re-pair"))
    }

    @Test
    fun `an unreachable gateway says to check the network`() {
        for (cause in listOf(
            java.net.UnknownHostException("gateway.example"),
            java.net.ConnectException("refused"),
            java.net.SocketTimeoutException("timed out"),
        )) {
            val message = accessAuthorizationUnmappedMessage(GatewayException.Network(cause))
            assertTrue(message, message.contains("Could not reach your Omnesis gateway"))
            assertTrue(message, message.contains("same network"))
        }
    }

    @Test
    fun `an unrecognised network fault still names itself`() {
        val message = accessAuthorizationUnmappedMessage(
            GatewayException.Network(java.io.IOException("stream reset")),
        )
        assertTrue(message, message.contains("IOException"))
    }

    @Test
    fun `a reply this version cannot read says to update`() {
        val message = accessAuthorizationUnmappedMessage(GatewayException.Decoding("bad field"))
        assertTrue(message, message.contains("Update Omnesis"))
    }

    @Test
    fun `a server fault carries its status`() {
        val message = accessAuthorizationUnmappedMessage(
            GatewayException.ServerError(502, "bad gateway"),
        )
        assertTrue(message, message.contains("502"))
    }

    @Test
    fun `an unclassifiable throwable keeps the plain wording`() {
        val message = accessAuthorizationUnmappedMessage(IllegalStateException("boom"))
        assertEquals("The authorization request could not be loaded or updated. Try again.", message)
    }

    private fun reconnect(vararg rules: AccessGrantRule) = AccessReconnectProposal(
        matchedBy = "client",
        principal = AccessReconnectPrincipal("principal_example", "Fictional assistant"),
        grant = AccessGrantSummary(
            id = "grant_example",
            name = "Fictional assistant access",
            revision = 2,
            rules = rules.toList(),
            credentials = emptyList(),
        ),
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

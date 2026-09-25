// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.AccessAnswerRelease
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessConnectionLevel
import dev.omnesis.android.transport.dto.AccessConnectionMatch
import dev.omnesis.android.transport.dto.AccessConnectionProposal
import dev.omnesis.android.transport.dto.AccessCredentialSummary
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessGrantSummary
import dev.omnesis.android.transport.dto.AccessLevelSummary
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessPolicyFamilySummary
import dev.omnesis.android.transport.dto.AccessPrincipalSummary
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

/**
 * The Connection step: which access level a new connection uses or which connection a new
 * sign-in replaces, the steps each path asks, and the decision and review each one produces.
 */
class AccessConnectionChoiceTest {

    /* ── Preselection ── */

    @Test fun without_a_match_the_step_opens_on_a_new_level_named_by_the_gateway() {
        val form = AccessAuthorizationForm.initial(request(), overview(), proposal())
        val choice = requireNotNull(form.connection)
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
        assertEquals("Fictional assistant 2", choice.name)
        assertEquals("Fictional reading", choice.levelName)
        assertFalse(choice.replacing)
        assertNull(choice.suggestedConnection(overview(), NOW))
        // The permissions a new level starts with are the defaults.
        assertTrue(form.answerEnabled)
        assertFalse(form.directEnabled)
        assertEquals("policy_example", form.policyFamilyId)
        assertEquals(
            listOf(
                AccessAuthorizationStep.CONNECTION,
                AccessAuthorizationStep.PERMISSIONS,
                AccessAuthorizationStep.DATA,
                AccessAuthorizationStep.REVIEW,
            ),
            authorizationSteps(form, requiresAnswer = false),
        )
    }

    @Test fun a_level_name_the_gateway_left_blank_starts_from_the_client_name_within_the_limit() {
        val long = "n".repeat(140)
        val choice = AccessConnectionChoice.initial(
            request().copy(clientName = "  $long "),
            overview(),
            proposal().copy(defaultName = long, defaultLevelName = " "),
            NOW,
        )
        assertEquals(120, choice.name.length)
        assertEquals(120, choice.levelName.length)
        assertEquals("n".repeat(120), choice.levelName)
    }

    @Test fun an_existing_level_recommendation_preselects_the_matched_level_and_offers_it_first() {
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            proposal(recommended = "existing-level", match = match(levelId = "level_research")),
        )
        val choice = requireNotNull(form.connection)
        assertEquals(AccessConnectionPath.EXISTING_LEVEL, choice.path)
        assertEquals("level_research", choice.levelId)
        assertEquals("level_research", choice.suggestedLevel(overview())?.id)
        // The suggested level first, then the rest by name regardless of case.
        assertEquals(
            listOf("level_research", "level_archive", "level_capture"),
            choice.orderedLevels(overview()).map { it.id },
        )
        assertEquals(
            listOf(AccessAuthorizationStep.CONNECTION, AccessAuthorizationStep.REVIEW),
            authorizationSteps(form, requiresAnswer = false),
        )
        assertEquals(
            AccessAuthorizationSelection.NewConnection(
                "Fictional assistant 2",
                AccessConnectionLevel.Existing("level_research", 3),
            ),
            form.selection(request(), overview()),
        )
    }

    @Test fun without_a_suggestion_the_levels_are_offered_by_name() {
        val choice = AccessConnectionChoice.initial(request(), overview(), proposal(), NOW)
        assertNull(choice.suggestedLevel(overview()))
        assertEquals(
            listOf("level_archive", "level_capture", "level_research"),
            choice.orderedLevels(overview()).map { it.id },
        )
    }

    @Test fun a_level_without_answer_cannot_serve_an_agent_that_needs_answer() {
        val bound = request().copy(requiresAnswer = true)
        val archive = overview().levels.single { it.id == "level_archive" }
        assertEquals("This agent needs Answer.", unavailableReason(archive.rules, bound))
        assertNull(unavailableReason(archive.rules, request()))

        // Recommended, but unable to serve this request: the step opens on a new level instead.
        val choice = AccessConnectionChoice.initial(
            bound,
            overview(),
            proposal(recommended = "existing-level", match = match(levelId = "level_archive")),
            NOW,
        )
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)

        // Chosen anyway, it cannot be approved.
        val chosen = choice.copy(levelId = "level_archive")
        assertFalse(chosen.canContinue(bound, overview()))
        val form = AccessAuthorizationForm.initial(bound, overview(), proposal()).copy(connection = chosen)
        assertNull(form.selection(bound, overview()))
    }

    @Test fun a_replace_recommendation_opens_on_the_matched_connection_and_suggests_it() {
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            proposal(recommended = "replace", match = match(matchedBy = "device")),
        )
        val choice = requireNotNull(form.connection)
        assertEquals(AccessConnectionPath.REPLACE, choice.path)
        assertEquals("principal_laptop", choice.connectionId)
        assertEquals("principal_laptop", choice.suggestedConnection(overview(), NOW)?.id)
        assertEquals(
            listOf(AccessAuthorizationStep.CONNECTION, AccessAuthorizationStep.REVIEW),
            authorizationSteps(form, requiresAnswer = false),
        )
        assertEquals(
            AccessAuthorizationSelection.ReplaceConnection("principal_laptop", 5),
            form.selection(request(), overview()),
        )
        // Going back to normal mode keeps the other answers.
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.copy(replacing = false).path)
    }

    @Test fun a_replace_recommendation_whose_connection_is_gone_opens_on_a_new_level() {
        val choice = AccessConnectionChoice.initial(
            request(),
            overview().copy(principals = emptyList()),
            proposal(recommended = "replace", match = match(matchedBy = "device")),
            NOW,
        )
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
        assertNull(choice.suggestedConnection(overview().copy(principals = emptyList()), NOW))
    }

    @Test fun a_recommendation_this_build_does_not_know_opens_on_a_new_level() {
        val choice = AccessConnectionChoice.initial(
            request(),
            overview(),
            proposal(recommended = "something-later", match = match(levelId = "level_research")),
            NOW,
        )
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
    }

    @Test fun a_replace_recommendation_whose_connection_lacks_answer_opens_on_a_new_level() {
        val bound = request().copy(requiresAnswer = true)
        val form = AccessAuthorizationForm.initial(
            bound,
            overview(),
            proposal(
                recommended = "replace",
                match = match(
                    levelId = "level_archive",
                    matchedBy = "device",
                    rules = archiveRules,
                    connectionId = "principal_aurora",
                    connectionName = "Aurora phone",
                ),
            ),
            nowMillis = NOW,
        )
        val choice = requireNotNull(form.connection)
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
        assertFalse(choice.replacing)
        // The list still marks it, beside the reason it cannot be picked.
        assertEquals("principal_aurora", choice.suggestedConnection(overview(), NOW)?.id)
        // Picked by hand in replace mode, it still cannot serve the request.
        assertFalse(choice.copy(replacing = true, connectionId = "principal_aurora").canContinue(bound, overview()))
    }

    @Test fun a_new_level_recommendation_with_a_matched_level_still_suggests_that_level() {
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            proposal(recommended = "new-level", match = match(levelId = "level_research")),
            nowMillis = NOW,
        )
        val choice = requireNotNull(form.connection)
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
        assertNull(choice.levelId)
        assertEquals("level_research", choice.suggestedLevel(overview())?.id)
        assertEquals("level_research", choice.orderedLevels(overview()).first().id)
    }

    @Test fun the_replace_suggestion_marks_the_matched_connection_whichever_is_picked() {
        val choice = AccessConnectionChoice.initial(
            request(),
            overview(),
            proposal(recommended = "replace", match = match(matchedBy = "device")),
            NOW,
        )
        assertEquals("principal_laptop", choice.suggestedConnection(overview(), NOW)?.id)
        assertEquals(
            "principal_laptop",
            choice.copy(connectionId = "principal_desk").suggestedConnection(overview(), NOW)?.id,
        )
        assertEquals("principal_laptop", choice.copy(connectionId = null).suggestedConnection(overview(), NOW)?.id)
        // A match the gateway did not recommend replacing is not suggested, even on its connection.
        assertNull(
            choice.copy(proposal = proposal(recommended = "existing-level", match = match()))
                .suggestedConnection(overview(), NOW),
        )
    }

    @Test fun a_new_level_starts_from_a_copy_of_the_matched_connections_permissions() {
        val rules = listOf(
            AccessGrantRule.notes(),
            AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("files:fictional"))),
        )
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            proposal(match = match(levelId = null, rules = rules)),
        )
        assertEquals(AccessConnectionPath.NEW_LEVEL, form.connection?.path)
        assertFalse(form.answerEnabled)
        assertTrue(form.directEnabled)
        assertTrue(form.notesEnabled)
        val selection = form.selection(request(), overview()) as AccessAuthorizationSelection.NewConnection
        assertEquals("Fictional assistant 2", selection.name)
        assertEquals(AccessConnectionLevel.New("Fictional reading", rules), selection.level)
    }

    /* ── Names ── */

    @Test fun a_connection_needs_a_name_and_a_new_level_needs_one_too() {
        val base = AccessAuthorizationForm.initial(request(), overview(), proposal()).copy(
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
        )
        val choice = requireNotNull(base.connection)
        assertTrue(choice.canContinue(request(), overview()))

        val unnamed = choice.copy(name = "   ")
        assertEquals("Enter a name for this connection.", unnamed.nameError)
        assertFalse(unnamed.canContinue(request(), overview()))
        assertNull(base.copy(connection = unnamed).selection(request(), overview()))

        val unnamedLevel = choice.copy(levelName = "")
        assertEquals("Enter a name for this access level.", unnamedLevel.levelNameError(overview()))
        assertFalse(unnamedLevel.canContinue(request(), overview()))

        // An existing level asks no level name, and a replacement asks no name at all.
        assertTrue(unnamedLevel.copy(levelId = "level_research").canContinue(request(), overview()))
        assertTrue(unnamed.copy(replacing = true, connectionId = "principal_laptop").canContinue(request(), overview()))

        // Names are sent trimmed.
        val padded = base.copy(connection = choice.copy(name = "  Desk agent ", levelName = " Desk reading  "))
        val selection = padded.selection(request(), overview()) as AccessAuthorizationSelection.NewConnection
        assertEquals("Desk agent", selection.name)
        assertEquals("Desk reading", (selection.level as AccessConnectionLevel.New).name)
    }

    @Test fun a_new_level_named_like_a_live_level_is_refused_before_the_gateway_is_asked() {
        val base = AccessAuthorizationForm.initial(request(), overview(), proposal()).copy(
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
        )
        val choice = requireNotNull(base.connection)
        assertNull(choice.levelNameError(overview()))

        // Trimmed and regardless of case, as the gateway compares live level names.
        listOf("Research", "  RESEARCH ", "Archive").forEach { taken ->
            val clash = choice.copy(levelName = taken)
            assertEquals("An access level with that name already exists.", clash.levelNameError(overview()))
            assertFalse(clash.canContinue(request(), overview()))
            assertNull(base.copy(connection = clash).selection(request(), overview()))
        }

        // A name that only contains a live level's name is free, and so is one no live level has.
        assertNull(choice.copy(levelName = "Research 2").levelNameError(overview()))
        assertNull(choice.copy(levelName = "Research").levelNameError(overview().copy(levels = emptyList())))

        // Only a new level is named: an existing level or a replacement ignores the leftover name.
        val clash = choice.copy(levelName = "research")
        assertTrue(clash.copy(levelId = "level_capture").canContinue(request(), overview()))
        assertTrue(clash.copy(replacing = true, connectionId = "principal_laptop").canContinue(request(), overview()))
    }

    @Test fun an_unpicked_replacement_or_a_level_that_went_away_cannot_continue() {
        val choice = AccessConnectionChoice.initial(request(), overview(), proposal(), NOW)
        assertFalse(choice.copy(replacing = true).canContinue(request(), overview()))
        assertFalse(choice.copy(levelId = "level_removed").canContinue(request(), overview()))
    }

    /* ── Lists ── */

    @Test fun live_connections_are_listed_most_recently_used_first_then_by_name() {
        assertEquals(
            listOf("principal_desk", "principal_laptop", "principal_aurora", "principal_zed"),
            liveConnections(overview(), NOW).map { it.id },
        )
        assertEquals(3_000L, liveConnections(overview(), NOW).first().lastUsedAt)
    }

    @Test fun expired_and_non_interactive_connections_are_not_offered_for_replacement() {
        val base = overview()
        val overview = base.copy(
            principals = base.principals + listOf(
                principal(
                    "principal_lapsed",
                    "Lapsed agent",
                    grant("grant_lapsed", 1, "level_research", researchRules, 8_000).copy(expiresAt = NOW),
                ),
                principal(
                    "principal_trial",
                    "Trial agent",
                    grant("grant_trial", 1, "level_research", researchRules, null).copy(expiresAt = NOW + 1),
                ),
                AccessPrincipalSummary(
                    "principal_service",
                    "Sync service",
                    "service",
                    listOf(grant("grant_service", 1, "level_research", researchRules, 9_000)),
                ),
            ),
        )
        assertEquals(
            listOf("principal_desk", "principal_laptop", "principal_aurora", "principal_trial", "principal_zed"),
            liveConnections(overview, NOW).map { it.id },
        )

        // Recommended for replacement, an expired connection opens the step on a new level.
        val choice = AccessConnectionChoice.initial(
            request(),
            overview,
            proposal(
                recommended = "replace",
                match = match(matchedBy = "device", connectionId = "principal_lapsed", connectionName = "Lapsed agent"),
            ),
            NOW,
        )
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
        assertNull(choice.suggestedConnection(overview, NOW))
    }

    @Test fun counts_and_last_use_are_worded_for_the_list() {
        assertEquals("No connections", connectionCountLabel(0))
        assertEquals("1 connection", connectionCountLabel(1))
        assertEquals("4 connections", connectionCountLabel(4))
        assertEquals("Never used", lastUsedLabel(null, 10_000_000))
        assertEquals("Last used 2h ago", lastUsedLabel(10_000_000 - 2 * 3_600_000, 10_000_000))
    }

    /* ── Review ── */

    @Test fun a_new_level_is_reviewed_under_its_new_name_from_the_form() {
        val form = AccessAuthorizationForm.initial(request(), overview(), proposal())
        val review = reviewSummary(request(), overview(), form)
        assertEquals("Fictional assistant 2", review.connectionName)
        assertEquals("Fictional reading (new)", review.accessLevel)
        assertNull(review.replaces)
        assertEquals(form, review.permissions)
        assertNull(sharedLevelFootnote(review.otherConnections))
    }

    @Test fun an_existing_level_is_reviewed_with_its_own_rules_and_the_connections_it_shares() {
        val form = AccessAuthorizationForm.initial(request(), overview(), proposal()).let {
            it.copy(connection = it.connection?.copy(levelId = "level_research"))
        }
        val review = reviewSummary(request(), overview(), form)
        assertEquals("Fictional assistant 2", review.connectionName)
        assertEquals("Research", review.accessLevel)
        assertNull(review.replaces)
        assertTrue(review.permissions.answerEnabled)
        assertTrue(review.permissions.directEnabled)
        // A policy the level names but that is no longer published is stated, not replaced.
        assertEquals("Privacy policy", review.permissions.answerPrivacySummary(overview()))
        assertEquals(2, review.otherConnections)
        assertEquals(
            "Also used by 2 other connections. Changing this access level later changes all of them.",
            sharedLevelFootnote(review.otherConnections),
        )
        val single = form.copy(connection = form.connection?.copy(levelId = "level_capture"))
        assertEquals(
            "Also used by 1 other connection. Changing this access level later changes all of them.",
            sharedLevelFootnote(reviewSummary(request(), overview(), single).otherConnections),
        )
    }

    @Test fun a_replacement_is_reviewed_as_the_connection_it_takes_over() {
        val form = AccessAuthorizationForm.initial(
            request(),
            overview(),
            proposal(recommended = "replace", match = match(matchedBy = "device")),
        )
        val review = reviewSummary(request(), overview(), form)
        assertEquals("Northstar laptop", review.connectionName)
        assertEquals("Research", review.accessLevel)
        assertEquals("The current sign-in of Northstar laptop", review.replaces)
        assertEquals(
            listOf(AccessCapability.ANSWER, AccessCapability.DIRECT),
            listOfNotNull(
                AccessCapability.ANSWER.takeIf { review.permissions.answerEnabled },
                AccessCapability.DIRECT.takeIf { review.permissions.directEnabled },
                AccessCapability.NOTES.takeIf { review.permissions.notesEnabled },
            ),
        )
        // The replaced connection is one of the level's two; one other shares it.
        assertEquals(1, review.otherConnections)
    }

    /* ── A gateway that predates connections ── */

    @Test fun a_gateway_without_proposals_keeps_the_connect_flow() {
        val reconnect = AccessReconnectProposal(
            matchedBy = "client",
            principal = AccessReconnectPrincipal("principal_example", "Fictional research agent"),
            grant = grant("grant_example", 2, null, listOf(AccessGrantRule.notes()), null),
        )
        val form = AccessAuthorizationForm.initial(request(), overview(), reconnect = reconnect)
        assertNull(form.connection)
        assertTrue(form.notesEnabled)
        assertEquals(
            listOf(AccessAuthorizationStep.PERMISSIONS, AccessAuthorizationStep.REVIEW),
            authorizationSteps(form, requiresAnswer = false),
        )
        assertTrue(form.selection(request(), overview()) is AccessAuthorizationSelection.Connect)
        val review = reviewSummary(request(), overview(), form, legacyConnectionName = "Fictional research agent")
        assertEquals("Fictional research agent", review.connectionName)
        assertNull(review.accessLevel)
        assertEquals("Fictional assistant", reviewSummary(request(), overview(), form).connectionName)
    }

    private val researchRules = listOf(
        AccessGrantRule.answer(
            AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional")),
            AccessAnswerRelease.reviewed("policy_unpublished"),
        ),
        AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALL, emptyList())),
    )

    private fun proposal(recommended: String = "new-level", match: AccessConnectionMatch? = null) =
        AccessConnectionProposal(
            defaultName = "Fictional assistant 2",
            defaultLevelName = "Fictional reading",
            match = match,
            recommended = recommended,
        )

    private fun match(
        levelId: String? = "level_research",
        matchedBy: String = "client",
        rules: List<AccessGrantRule> = researchRules,
        connectionId: String = "principal_laptop",
        connectionName: String = "Northstar laptop",
    ) = AccessConnectionMatch(
        connectionId = connectionId,
        connectionName = connectionName,
        matchedBy = matchedBy,
        levelId = levelId,
        grant = grant("grant_laptop", 5, levelId, rules, 2_000),
    )

    private fun grant(id: String, revision: Int, levelId: String?, rules: List<AccessGrantRule>, lastUsedAt: Long?) =
        AccessGrantSummary(
            id = id,
            name = "$id access",
            revision = revision,
            rules = rules,
            credentials = listOf(AccessCredentialSummary("credential_$id", "Sign-in", "active", lastUsedAt = lastUsedAt)),
            levelId = levelId,
        )

    private fun principal(id: String, name: String, grant: AccessGrantSummary, revokedAt: Long? = null) =
        AccessPrincipalSummary(id, name, "interactive", listOf(grant), revokedAt)

    private fun overview() = AccessOverview(
        principals = listOf(
            principal("principal_zed", "zed tablet", grant("grant_zed", 1, "level_capture", listOf(AccessGrantRule.notes()), null)),
            principal("principal_laptop", "Northstar laptop", grant("grant_laptop", 5, "level_research", researchRules, 2_000)),
            principal("principal_aurora", "Aurora phone", grant("grant_aurora", 1, "level_archive", archiveRules, null)),
            principal("principal_desk", "Desk agent", grant("grant_desk", 2, "level_research", researchRules, 3_000)),
            principal(
                "principal_gone",
                "Retired agent",
                grant("grant_gone", 1, "level_research", researchRules, 9_000),
                revokedAt = 1,
            ),
        ),
        sources = listOf(
            AccessSourceInstance("notes:fictional", "Fictional Notes"),
            AccessSourceInstance("files:fictional", "Project Files"),
        ),
        policyFamilies = listOf(AccessPolicyFamilySummary("policy_example", "Everyday", "3")),
        defaultPolicyFamilyId = "policy_example",
        levels = listOf(
            AccessLevelSummary("level_research", "Research", 3, researchRules, 2),
            AccessLevelSummary("level_capture", "Capture", 1, listOf(AccessGrantRule.notes()), 1),
            AccessLevelSummary("level_archive", "archive", 2, archiveRules, 1),
        ),
    )

    private val archiveRules get() = listOf(
        AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("files:fictional"))),
    )

    private companion object {
        /** The instant connection expiry is judged against. */
        const val NOW = 1_000_000L
    }

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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Test

class AccessLevelDraftTest {
    private val policy = ScopePolicy("scope-chat:one", ScopeAudience("level-example", "answer"),
        listOf(ScopeRule(listOf(ScopeRef("participant", label = "Maya", identifiers = listOf(ScopeIdentifier("email", "maya@example.org")))), "hide")), "share")
    private val overview = AccessOverview(emptyList(), listOf(AccessSourceInstance("scope-chat:one", "First account"), AccessSourceInstance("scope-chat:two", "Second account")))
    private fun level(rules: List<AccessGrantRule>) = AccessLevelSummary("level-example", "Research assistant", 7, rules, 2)
    @Test fun newFilteredRulesDeclareZeroRevision() {
        val draft = AccessLevelDraft.opening(null, overview).setPolicy(policy, policy.sourceId, AccessCapability.ANSWER)
        assertEquals(0, draft.serializedRules.single().filterRevision)
    }
    @Test fun savedDirectCopyIsExplicitAndLaterAnswerChangesStaySeparate() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(filterRevision = 4, scopePolicies = listOf(policy))
        val direct = AccessGrantRule.direct(answer.sources).copy(filterRevision = 2)
        var draft = AccessLevelDraft.opening(level(listOf(answer, direct)), overview)
        assertFalse(draft.directSameAsAnswer)
        assertTrue(draft.rule(AccessCapability.DIRECT)!!.scopePolicies.isEmpty())
        draft = draft.copyAnswer().setPolicy(null, policy.sourceId, AccessCapability.ANSWER)
        assertEquals("direct", draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single().audience.capability)
        draft = draft.enabled(AccessCapability.ANSWER, false, overview)
        assertEquals(mapOf("answer" to 4, "direct" to 2), draft.expectedFilterRevisions)
    }
    @Test fun policiesStayWithTheirSourceAccountAndIdentifiersDoNotGrow() {
        val second = policy.copy(sourceId = "scope-chat:two")
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(scopePolicies = listOf(policy, second))
        val draft = AccessLevelDraft.opening(level(listOf(answer)), overview).setPolicy(null, policy.sourceId, AccessCapability.ANSWER)
        assertEquals(listOf(second), draft.rule(AccessCapability.ANSWER)!!.scopePolicies)
        assertEquals(listOf("maya@example.org"), second.rules.single().match.single().identifiers!!.map { it.value })
    }
    @Test fun newDirectLinkMaterializesIndependentPolicyAudience() {
        val draft = AccessLevelDraft.opening(null, overview).enabled(AccessCapability.DIRECT, true, overview)
            .setPolicy(policy.copy(audience = ScopeAudience("new", "answer")), policy.sourceId, AccessCapability.ANSWER)
        assertEquals(ScopeAudience("new", "direct"), draft.serializedRules.first { it.capability == AccessCapability.DIRECT }.scopePolicies.single().audience)
    }
    @Test fun typedIdentifiersRejectOpaqueAndWrongKindValues() {
        assertNull(scopeTypedIdentifier("opaque-member", "phone"))
        assertNull(scopeTypedIdentifier("maya@example.org", "phone"))
        assertEquals("+15550100123", scopeTypedIdentifier("+1 (555) 010-0123", "phone")!!.value)
        assertEquals("example.org", scopeTypedIdentifier("EXAMPLE.ORG", "domain")!!.value)
    }
    @Test fun filteredRuleRoundtripsWithRevision() {
        val rule = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(filterRevision = 9, scopePolicies = listOf(policy))
        val encoded = OmnesisJson.encodeToString(AccessGrantRule.serializer(), rule)
        assertEquals(rule, OmnesisJson.decodeFromString(AccessGrantRule.serializer(), encoded))
        assertTrue(encoded.contains("filterRevision"))
        assertTrue(encoded.contains("scopePolicies"))
    }
    @Test fun consentCopyPreservesIdentifiersAndDoesNotLinkDifferentFilters() {
        val boundary = AccessSourceBoundary(AccessSourceMode.ALL, emptyList())
        val form = AccessAuthorizationForm.describing(listOf(
            AccessGrantRule.answer(boundary, AccessAnswerRelease.unreviewed()).copy(filterRevision = 4, scopePolicies = listOf(policy)),
            AccessGrantRule.direct(boundary),
        ), overview, false)
        assertFalse(form.linkedSources)
        assertEquals(listOf(policy), form.scopePolicies["answer"])
        val request = AccessAuthorizationRequest("request-example", "approval-example", "pending", "client-example", "Research assistant", redirectOrigin = "https://client.example", resource = "https://gateway.example/mcp", scope = "omnesis:access", expiresAt = 1800000000000, requiresAnswer = false)
        val rules = form.ownRules(request, overview)!!
        assertEquals(policy.rules, rules.first { it.capability == AccessCapability.ANSWER }.scopePolicies.single().rules)
        assertEquals("new", rules.first { it.capability == AccessCapability.ANSWER }.scopePolicies.single().audience.accessLevel)
        assertTrue(rules.first { it.capability == AccessCapability.DIRECT }.scopePolicies.isEmpty())
    }

    @Test fun sourcePreparationBlocksEmptyListsButUnrelatedKindsDoNot() {
        val empty = ScopePolicy.empty("scope-chat:one", "new", "answer")
        assertFalse(empty.readyToSave(listOf(ScopeKindReadiness("participant", false, reason = "backfill"))))
        assertTrue(empty.readyToSave(listOf(ScopeKindReadiness("folder", false, reason = "metadata-refresh"))))
        assertTrue(policy.readyToSave(listOf(ScopeKindReadiness("participant", true), ScopeKindReadiness("folder", false))))
        assertFalse(policy.readyToSave(listOf(ScopeKindReadiness("participant", false))))
    }

    @Test fun missingPrivacyPolicyNeverDefaultsToUnreviewedRelease() {
        var draft = AccessLevelDraft.opening(null, overview).copy(name = "Research assistant")
        assertFalse(draft.valid)
        val answer = draft.rule(AccessCapability.ANSWER)!!
        draft = draft.setRule(answer.copy(release = AccessAnswerRelease.unreviewed())).copy(requireAnswerPolicySelection = false)
        assertTrue(draft.valid)
    }

    @Test fun unlinkingANewDraftMaterializesTheWholeAnswerPolicy() {
        var draft = AccessLevelDraft.opening(null, overview).enabled(AccessCapability.DIRECT, true, overview)
            .setPolicy(policy, policy.sourceId, AccessCapability.ANSWER)
        draft = draft.withDirectSameAsAnswer(false).setPolicy(null, policy.sourceId, AccessCapability.ANSWER)
        assertEquals(policy.rules, draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single().rules)
        assertEquals("direct", draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single().audience.capability)
    }
    @Test fun unlinkingAConsentDraftCopiesCapturedIdentifiers() {
        val form = AccessAuthorizationForm(scopePolicies = mapOf("answer" to listOf(policy))).withLinkedSources(false, true)
        assertEquals(policy.rules, form.scopePolicies["direct"]!!.single().rules)
        assertEquals("direct", form.scopePolicies["direct"]!!.single().audience.capability)
    }

    @Test fun disablingAnswerInConsentRetainsLinkedDirectRestrictions() {
        val form = AccessAuthorizationForm(directEnabled = true, scopePolicies = mapOf("answer" to listOf(policy)))
            .withAnswerEnabled(false, false)
        assertFalse(form.linkedSources)
        assertEquals(policy.rules, form.scopePolicies["direct"]!!.single().rules)
        assertEquals("direct", form.scopePolicies["direct"]!!.single().audience.capability)
    }

    @Test fun disablingAnswerRetainsAnIndependentDirectCopy() {
        val draft = AccessLevelDraft.opening(null, overview).enabled(AccessCapability.DIRECT, true, overview)
            .setPolicy(policy, policy.sourceId, AccessCapability.ANSWER).enabled(AccessCapability.ANSWER, false, overview)
        assertFalse(draft.directSameAsAnswer)
        assertEquals(policy.rules, draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single().rules)
    }

    @Test fun explicitCopyCannotAddOrRemoveFiltersWhenAuthoringIsUnavailable() {
        val directPolicy = policy.copy(audience = policy.audience.copy(capability = "direct"))
        data class Case(val answer: List<ScopePolicy>, val direct: List<ScopePolicy>, val enabled: Boolean, val permitted: Boolean)
        listOf(Case(listOf(policy), emptyList(), false, false), Case(emptyList(), listOf(directPolicy), false, false),
            Case(emptyList(), emptyList(), false, true), Case(listOf(policy), listOf(directPolicy), true, true)).forEach { case ->
            val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(policy.sourceId)), AccessAnswerRelease.unreviewed()).copy(scopePolicies = case.answer)
            val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALL, emptyList())).copy(scopePolicies = case.direct)
            val draft = AccessLevelDraft.opening(level(listOf(answer, direct)), overview)
            assertEquals(case.permitted, draft.canCopyAnswer(case.enabled))
            val copied = draft.copyAnswer(case.enabled)
            if (case.permitted) {
                assertEquals(answer.sources, copied.rule(AccessCapability.DIRECT)!!.sources)
                assertEquals(case.answer.map { it.rules }, copied.rule(AccessCapability.DIRECT)!!.scopePolicies.map { it.rules })
            } else assertEquals(draft, copied)
        }
    }
    @Test fun readOnlyBoundariesRetainKnownAndUnknownFilteredSources() {
        val missing = policy.copy(sourceId = "scope-chat:missing")
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(scopePolicies = listOf(policy, missing))
        var draft = AccessLevelDraft.opening(level(listOf(answer)), overview)
        listOf(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(policy.sourceId)), AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf(missing.sourceId))).forEach {
            assertEquals(draft, draft.setBoundary(it, AccessCapability.ANSWER, false))
        }
        val retained = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(policy.sourceId, missing.sourceId))
        draft = draft.setBoundary(retained, AccessCapability.ANSWER, false)
        assertEquals(retained, draft.rule(AccessCapability.ANSWER)!!.sources)
        assertEquals(listOf(policy, missing), draft.rule(AccessCapability.ANSWER)!!.scopePolicies)
        draft = draft.setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(policy.sourceId)), AccessCapability.ANSWER, true)
        assertEquals(listOf(policy), draft.rule(AccessCapability.ANSWER)!!.scopePolicies)
        assertNull(draft.enabled(AccessCapability.ANSWER, false, overview).rule(AccessCapability.ANSWER))
    }
    @Test fun consentRelinkingCannotReplaceOrRemoveReadOnlyFiltersButUnlinkingRetainsThem() {
        listOf("answer", "direct").forEach { capability ->
            val form = AccessAuthorizationForm(linkedSources = false, scopePolicies = mapOf(capability to listOf(policy)))
            assertEquals(form, form.withLinkedSources(true, true, false))
            assertTrue(form.withLinkedSources(true, true, true).linkedSources)
        }
        assertTrue(AccessAuthorizationForm(linkedSources = false).withLinkedSources(true, true, false).linkedSources)
        val shared = AccessAuthorizationForm(scopePolicies = mapOf("answer" to listOf(policy)))
        assertEquals(policy.rules, shared.withLinkedSources(false, true, false).scopePolicies["direct"]!!.single().rules)
    }
    @Test fun consentBoundaryGuardChecksUnknownFilteredIdsAndLeavesUnfilteredCapabilitiesEditable() {
        val known = overview.sources.map { it.id }.toSet()
        val missing = policy.copy(sourceId = "scope-chat:missing")
        val form = AccessAuthorizationForm(linkedSources = false,
            answerSources = AccessSourceSelectionState.from(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), known),
            scopePolicies = mapOf("answer" to listOf(missing)))
        val blocked = AccessSourceSelectionState.from(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, known.toList()), known)
        assertEquals(form, form.withSources(blocked, AccessSourceScope.ANSWER, known, false))
        assertEquals(blocked, form.withSources(blocked, AccessSourceScope.DIRECT, known, false).directSources)
    }

    @Test fun newAuthoritySelectionChecksOnlyEmittedPoliciesAndKeepsExistingReuse() {
        val request = AccessAuthorizationRequest("request-example", "approval-example", "pending", "client-example", "Research assistant", redirectOrigin = "https://client.example", resource = "https://gateway.example/mcp", scope = "omnesis:access", expiresAt = 1800000000000, requiresAnswer = false)
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(filterRevision = 7, scopePolicies = listOf(policy))
        val catalogue = overview.copy(levels = listOf(level(listOf(answer))))
        val form = AccessAuthorizationForm.describing(listOf(answer), catalogue, false)
        val choice = AccessConnectionChoice(AccessConnectionProposal("Fresh connection", "Fresh level", recommended = "new-level"), "Fresh connection", "Fresh level")
        assertTrue(form.ownRules(request, catalogue)!!.single().scopePolicies.isNotEmpty())
        assertEquals(0, form.ownRules(request, catalogue)!!.single().filterRevision)
        assertEquals("new", form.ownRules(request, catalogue)!!.single().scopePolicies.single().audience.accessLevel)
        assertNull(form.selection(request, catalogue))
        assertNull(choice.selection(request, catalogue, form))
        assertTrue(choice.copy(levelId = "level-example").selection(request, catalogue, form) != null)
        val enabled = catalogue.copy(sourceFilters = SourceFiltersAvailability(true))
        assertTrue(form.selection(request, enabled) != null)
        assertTrue(choice.selection(request, enabled, form) != null)
        val disabled = catalogue.copy(sourceFilters = SourceFiltersAvailability(false))
        val notes = form.copy(answerEnabled = false, notesEnabled = true)
        assertEquals(listOf(policy), notes.scopePolicies["answer"])
        assertTrue(notes.selection(request, disabled) != null)
        assertTrue(choice.selection(request, disabled, notes) != null)
        val unfiltered = form.copy(scopePolicies = emptyMap())
        assertTrue(unfiltered.selection(request, disabled) != null)
        assertTrue(choice.selection(request, disabled, unfiltered) != null)
        val cleared = AccessAuthorizationForm.describing(listOf(answer.copy(filterRevision = 7, scopePolicies = emptyList())), disabled, false)
        assertNull(cleared.ownRules(request, disabled)!!.single().filterRevision)
        assertTrue(choice.selection(request, disabled, cleared) != null)
    }

}

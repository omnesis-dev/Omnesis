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
        val draft = AccessLevelDraft.opening(null, overview).setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(policy.sourceId)), AccessCapability.ANSWER, true).setPolicy(policy, policy.sourceId, AccessCapability.ANSWER)
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
        val draft = AccessLevelDraft.opening(null, overview).enabled(AccessCapability.DIRECT, true, overview).setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(policy.sourceId)), AccessCapability.ANSWER, true)
            .setPolicy(policy.copy(audience = ScopeAudience("new", "answer")), policy.sourceId, AccessCapability.ANSWER)
        assertEquals(ScopeAudience("new", "direct"), draft.serializedRules.first { it.capability == AccessCapability.DIRECT }.scopePolicies.single().audience)
    }
    @Test fun aPermissionSwitchedOffAndBackOnKeepsItsBoundaryAndFilters() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:one")), AccessAnswerRelease.unreviewed()).copy(filterRevision = 4, scopePolicies = listOf(policy))
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:two"))).copy(filterRevision = 2)
        val opened = AccessLevelDraft.opening(level(listOf(answer, direct)), overview)
        val off = opened.enabled(AccessCapability.ANSWER, false, overview)
        assertNull(off.rule(AccessCapability.ANSWER))
        assertEquals(direct, off.rule(AccessCapability.DIRECT))
        val restored = off.enabled(AccessCapability.ANSWER, true, overview)
        assertEquals(answer, restored.rule(AccessCapability.ANSWER))
        assertEquals(opened.rules.toSet(), restored.rules.toSet())
        assertTrue(restored.removedRules.isEmpty())
        assertFalse(restored.isChangedFrom(opened.originalLevel))
        val both = opened.enabled(AccessCapability.DIRECT, false, overview).enabled(AccessCapability.ANSWER, false, overview)
        assertEquals(direct, both.enabled(AccessCapability.DIRECT, true, overview).rule(AccessCapability.DIRECT))
        assertEquals(opened, opened.enabled(AccessCapability.NOTES, false, overview))
    }
    @Test fun choosingSeparateDataAfterReusingAnswerRestoresTheDirectBoundaryTheCopyReplaced() {
        val answerOnly = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:one"))
        val directOnly = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:two"))
        val linked = AccessLevelDraft.opening(null, overview).setBoundary(answerOnly, AccessCapability.ANSWER, true).enabled(AccessCapability.DIRECT, true, overview)
        assertTrue(linked.directSameAsAnswer)
        val first = linked.withDirectSameAsAnswer(false)
        assertEquals(answerOnly, first.rule(AccessCapability.DIRECT)!!.sources)
        val chosen = first.setBoundary(directOnly, AccessCapability.DIRECT, true)
        val relinked = chosen.withDirectSameAsAnswer(true)
        assertEquals(answerOnly, relinked.serializedRules.first { it.capability == AccessCapability.DIRECT }.sources)
        val separate = relinked.withDirectSameAsAnswer(false)
        assertEquals(directOnly, separate.rule(AccessCapability.DIRECT)!!.sources)
        assertEquals(chosen, separate)
        assertEquals(separate, separate.withDirectSameAsAnswer(false))
    }
    @Test fun aSavedDirectThatReadsExactlyWhatAnswerReadsOpensLinked() {
        val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:one"))
        val answer = AccessGrantRule.answer(boundary, AccessAnswerRelease.unreviewed()).copy(scopePolicies = listOf(policy), filterRevision = 3)
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:one")))
            .copy(scopePolicies = listOf(policy.copy(audience = ScopeAudience("level-example", "direct"))), filterRevision = 1)
        val opened = AccessLevelDraft.opening(level(listOf(answer, direct)), overview)
        assertTrue(opened.directLinked)
        assertNull(opened.separateDirect)
        assertFalse(opened.isChangedFrom(opened.originalLevel))
        // Unlinking a level that opened linked starts Direct's own list from Answer's.
        val own = opened.withDirectSameAsAnswer(false)
        assertEquals(boundary, own.rule(AccessCapability.DIRECT)!!.sources)
        assertEquals(ScopeAudience("level-example", "direct"), own.rule(AccessCapability.DIRECT)!!.scopePolicies.single().audience)
        // A different filter, a different account or a different choice about new sources keeps Direct's own list.
        listOf(
            direct.copy(scopePolicies = emptyList()),
            direct.copy(sources = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:two"))),
            direct.copy(sources = AccessSourceBoundary(AccessSourceMode.DENYLIST, emptyList())),
        ).forEach { other -> assertFalse(AccessLevelDraft.opening(level(listOf(answer, other)), overview).directSameAsAnswer) }
    }
    @Test fun aSavedLevelLinkedToAnswerStatesItOnTheLevelPage() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:one")), AccessAnswerRelease.unreviewed())
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:two")))
        val linked = AccessLevelDraft.opening(level(listOf(answer, direct)), overview).withDirectSameAsAnswer(true)
        val decisions = levelDecisions(linked.name, linked.serializedRules, overview, linked = linked.directLinked)
        assertEquals(AccessDecision(AccessLevelPage.DIRECT_DATA, "Direct data", "Same sources and filters as Answer"), decisions.single { it.title == "Direct data" })
        assertEquals(AccessCapabilityHoldings(answer = true, direct = true, notes = false), decisions.single { it.title == "Permissions" }.capabilities)
    }
    @Test fun aDraftSurvivesBeingSavedAndRestored() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(filterRevision = 4, scopePolicies = listOf(policy))
        val draft = AccessLevelDraft.opening(level(listOf(answer, AccessGrantRule.notes())), overview).enabled(AccessCapability.ANSWER, false, overview)
        assertEquals(draft, OmnesisJson.decodeFromString(AccessLevelDraft.serializer(), OmnesisJson.encodeToString(AccessLevelDraft.serializer(), draft)))
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
        val draft = AccessLevelDraft.copying(listOf(
            AccessGrantRule.answer(boundary, AccessAnswerRelease.unreviewed()).copy(filterRevision = 4, scopePolicies = listOf(policy)),
            AccessGrantRule.direct(boundary),
        ), overview)
        assertFalse(draft.directSameAsAnswer)
        assertEquals(NEW_ACCESS_LEVEL_ID, draft.id)
        assertNull(draft.expectedRevision)
        val rules = draft.serializedRules
        assertEquals(policy.rules, rules.first { it.capability == AccessCapability.ANSWER }.scopePolicies.single().rules)
        assertEquals("new", rules.first { it.capability == AccessCapability.ANSWER }.scopePolicies.single().audience.accessLevel)
        assertEquals(0, rules.first { it.capability == AccessCapability.ANSWER }.filterRevision)
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
            .setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:one")), AccessCapability.ANSWER, true)
        assertTrue(draft.requireAnswerPolicySelection)
        assertFalse(draft.validFor(overview))
        val answer = draft.rule(AccessCapability.ANSWER)!!
        draft = draft.setRule(answer.copy(release = AccessAnswerRelease.unreviewed(), sources = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()))).copy(requireAnswerPolicySelection = false)
        assertFalse(draft.validFor(overview))
        draft = draft.setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("scope-chat:one")), AccessCapability.ANSWER, true)
        assertTrue(draft.validFor(overview))
    }

    @Test fun unlinkingANewDraftMaterializesTheWholeAnswerPolicy() {
        var draft = AccessLevelDraft.opening(null, overview).enabled(AccessCapability.DIRECT, true, overview)
            .setPolicy(policy, policy.sourceId, AccessCapability.ANSWER)
        draft = draft.withDirectSameAsAnswer(false).setPolicy(null, policy.sourceId, AccessCapability.ANSWER)
        assertEquals(policy.rules, draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single().rules)
        assertEquals("direct", draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single().audience.capability)
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
        assertEquals(listOf(policy, missing), draft.rule(AccessCapability.ANSWER)!!.scopePolicies)
        assertNull(draft.enabled(AccessCapability.ANSWER, false, overview).rule(AccessCapability.ANSWER))
    }
    @Test fun aDeselectedSourceKeepsItsFilterInTheDraftAndSavesWithoutIt() {
        val all = AccessSourceBoundary(AccessSourceMode.ALL, emptyList())
        val answer = AccessGrantRule.answer(all, AccessAnswerRelease.unreviewed()).copy(filterRevision = 3, scopePolicies = listOf(policy))
        val saved = AccessLevelDraft.opening(level(listOf(answer)), overview)
        val blocked = saved.setBoundary(AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf(policy.sourceId)), AccessCapability.ANSWER, true)
        assertEquals(listOf(policy), blocked.rule(AccessCapability.ANSWER)!!.scopePolicies)
        assertTrue(blocked.serializedRules.single().scopePolicies.isEmpty())
        assertNull(blocked.dataError(AccessCapability.ANSWER, overview))
        assertTrue(blocked.validFor(overview))
        assertEquals("1 account selected · all content", ruleDataSummary(blocked.rule(AccessCapability.ANSWER)!!, overview))
        val restored = blocked.setBoundary(all, AccessCapability.ANSWER, true)
        assertEquals(saved.rules, restored.rules)
        assertEquals(listOf(policy), restored.serializedRules.single().scopePolicies)
        assertFalse(restored.isChangedFrom(level(listOf(answer))))
        val removed = blocked.setPolicy(null, policy.sourceId, AccessCapability.ANSWER)
        assertNull(removed.dataError(AccessCapability.ANSWER, overview))
        assertTrue(removed.validFor(overview))
    }
    @Test fun directSwitchedOnBesideAnswerStartsLinkedAndWithoutAnswerStartsEmpty() {
        val one = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(policy.sourceId))
        val answer = AccessGrantRule.answer(one, AccessAnswerRelease.unreviewed()).copy(filterRevision = 3, scopePolicies = listOf(policy))
        val authoring = overview.copy(sourceFilters = SourceFiltersAvailability(true))
        val on = AccessLevelDraft.opening(level(listOf(answer)), authoring).enabled(AccessCapability.DIRECT, true, authoring)
        assertTrue(on.directLinked)
        val direct = on.serializedRules.single { it.capability == AccessCapability.DIRECT }
        assertEquals(one, direct.sources)
        assertEquals(listOf(policy.copy(audience = policy.audience.copy(capability = "direct"))), direct.scopePolicies)
        // Leaving the link starts Direct's own list from a copy of Answer's.
        assertEquals(one, on.withDirectSameAsAnswer(false).rule(AccessCapability.DIRECT)!!.sources)
        val alone = AccessLevelDraft.opening(level(listOf(AccessGrantRule.notes())), overview).enabled(AccessCapability.DIRECT, true, overview)
        assertFalse(alone.directLinked)
        assertEquals(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()), alone.rule(AccessCapability.DIRECT)!!.sources)
    }
    @Test fun aCapabilityTurnedOffAndOnAgainKeepsTheRevisionItsSavedFiltersAreFencedOn() {
        val all = AccessSourceBoundary(AccessSourceMode.ALL, emptyList())
        val answer = AccessGrantRule.answer(all, AccessAnswerRelease.unreviewed()).copy(filterRevision = 4, scopePolicies = listOf(policy))
        val saved = AccessLevelDraft.opening(level(listOf(answer, AccessGrantRule.notes())), overview)
        val toggled = saved.enabled(AccessCapability.ANSWER, false, overview).enabled(AccessCapability.ANSWER, true, overview)
        assertEquals(4, toggled.rule(AccessCapability.ANSWER)!!.filterRevision)
        val refiltered = toggled.setBoundary(all, AccessCapability.ANSWER, true).setPolicy(policy, policy.sourceId, AccessCapability.ANSWER)
        assertEquals(4, refiltered.serializedRules.first { it.capability == AccessCapability.ANSWER }.filterRevision)
        assertEquals(mapOf("answer" to 4), refiltered.expectedFilterRevisions)
        val direct = saved.enabled(AccessCapability.DIRECT, true, overview).setBoundary(all, AccessCapability.DIRECT, true)
            .setPolicy(policy.copy(audience = ScopeAudience("level-example", "direct")), policy.sourceId, AccessCapability.DIRECT)
        assertEquals(0, direct.serializedRules.first { it.capability == AccessCapability.DIRECT }.filterRevision)
    }

    @Test fun newAuthoritySelectionChecksOnlyEmittedPoliciesAndKeepsExistingReuse() {
        val request = AccessAuthorizationRequest("request-example", "approval-example", "pending", "client-example", "Research assistant", redirectOrigin = "https://client.example", resource = "https://gateway.example/mcp", scope = "omnesis:access", expiresAt = 1800000000000, requiresAnswer = false)
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(filterRevision = 7, scopePolicies = listOf(policy))
        val catalogue = overview.copy(levels = listOf(level(listOf(answer))))
        val form = AccessAuthorizationForm(AccessLevelDraft.copying(listOf(answer), catalogue).copy(name = "Fresh level"))
        val choice = AccessConnectionChoice(AccessConnectionProposal("Fresh connection", "Fresh level", recommended = "new-level"), "Fresh connection")
        assertTrue(form.level.serializedRules.single().scopePolicies.isNotEmpty())
        assertEquals(0, form.level.serializedRules.single().filterRevision)
        assertEquals("new", form.level.serializedRules.single().scopePolicies.single().audience.accessLevel)
        assertNull(form.selection(request, catalogue))
        assertNull(choice.selection(request, catalogue, form))
        assertTrue(choice.copy(levelId = "level-example").selection(request, catalogue, form) != null)
        val enabled = catalogue.copy(sourceFilters = SourceFiltersAvailability(true))
        assertTrue(form.selection(request, enabled) != null)
        assertTrue(choice.selection(request, enabled, form) != null)
        val disabled = catalogue.copy(sourceFilters = SourceFiltersAvailability(false))
        val notes = form.copy(level = form.level.enabled(AccessCapability.ANSWER, false, disabled).enabled(AccessCapability.NOTES, true, disabled))
        assertEquals(listOf(policy.rules), notes.level.removedRules.getValue(AccessCapability.ANSWER).scopePolicies.map { it.rules })
        assertTrue(notes.selection(request, disabled) != null)
        assertTrue(choice.selection(request, disabled, notes) != null)
        val unfiltered = form.copy(level = form.level.setPolicy(null, policy.sourceId, AccessCapability.ANSWER))
        assertTrue(unfiltered.selection(request, disabled) != null)
        assertTrue(choice.selection(request, disabled, unfiltered) != null)
        val cleared = AccessLevelDraft.copying(listOf(answer.copy(filterRevision = 7, scopePolicies = emptyList())), disabled)
        assertNull(cleared.serializedRules.single().filterRevision)
        assertTrue(choice.selection(request, disabled, form.copy(level = cleared.copy(name = "Fresh level"))) != null)
    }

}

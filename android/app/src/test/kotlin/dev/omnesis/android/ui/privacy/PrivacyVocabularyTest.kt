// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.isUnspecified
import androidx.compose.ui.unit.sp
import dev.omnesis.android.transport.dto.PrivacyAuditEventDisplay
import dev.omnesis.android.transport.dto.PrivacyAuditEventSummary
import dev.omnesis.android.transport.dto.PrivacyAuditStatusDisplay
import dev.omnesis.android.transport.dto.PrivacyExchangeApproval
import dev.omnesis.android.transport.dto.PrivacyExchangeFailure
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.transport.dto.PrivacyFinding
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrivacyVocabularyTest {

    /* ── The caller's name ── */

    @Test
    fun narrativeNameDropsOnlyABareRegistrySlug() {
        assertEquals("Atlas", externalAgentNarrativeName(agent("Atlas (openclaw)")))
        assertEquals("Atlas", externalAgentNarrativeName(agent("Atlas (hermes)")))
        assertEquals("Atlas", externalAgentNarrativeName(agent("Atlas (open-claw.v2)")))
    }

    @Test
    fun narrativeNameKeepsAParentheticalThatIsPartOfTheName() {
        assertEquals("Acme (support desk)", externalAgentNarrativeName(agent("Acme (support desk)")))
        assertEquals("Acme (Support)", externalAgentNarrativeName(agent("Acme (Support)")))
        assertEquals("Acme (openclaw) beta", externalAgentNarrativeName(agent("Acme (openclaw) beta")))
    }

    @Test
    fun narrativeNameNeverCollapsesToNothing() {
        assertEquals("(openclaw)", externalAgentNarrativeName(agent("(openclaw)")))
        assertEquals("External agent", externalAgentNarrativeName(agent("")))
    }

    @Test
    fun theTechnicalRecordKeepsTheFullSelfAssertedName() {
        assertEquals("Atlas (openclaw)", externalAgentName(agent("Atlas (openclaw)")))
    }

    @Test
    fun aGatewayAuthoredNarrativeNameWinsOverTheOldGatewayFallbackParser() {
        val identity = PrivacyExternalAgentIdentity(
            displayName = "Research principal",
            narrativeName = "Research assistant",
            source = "principal",
        )

        assertEquals("Research assistant", externalAgentNarrativeName(identity))
    }

    /* ── Outcomes ── */

    @Test
    fun sharedReadsAsSharedWithTheAgentAndTakesAReleasedTone() {
        val shared = privacyOutcomeDisplay("shared")

        assertEquals("Shared with the agent", shared.label)
        assertEquals(PrivacyTone.RELEASED, shared.tone)
        // Nothing that means "kept private" may share a tone with a release.
        assertNotEquals(shared.tone, privacyOutcomeDisplay("not_shared").tone)
        assertNotEquals(shared.tone, privacyOutcomeDisplay("shared_with_reductions").tone)
    }

    @Test
    fun everyOutcomeInTheClosedSetHasItsOwnSentenceAndTone() {
        assertEquals("Needs your review", privacyOutcomeDisplay("needs_review").label)
        assertEquals(PrivacyTone.REVIEW, privacyOutcomeDisplay("needs_review").tone)
        assertEquals("Shared with details removed", privacyOutcomeDisplay("shared_with_reductions").label)
        assertEquals("Not shared", privacyOutcomeDisplay("not_shared").label)
        assertEquals(PrivacyTone.KEPT, privacyOutcomeDisplay("not_shared").tone)
        assertEquals("Nothing shared; check failed", privacyOutcomeDisplay("failed").label)
        assertEquals("Approved, waiting for agent", privacyOutcomeDisplay("ready").label)
    }

    @Test
    fun concreteExchangeOutcomesNameTheirRecipient() {
        assertEquals("Shared with Atlas", privacyExchangeOutcomeDisplay(exchange("shared")).label)
        assertEquals(
            "Shared with Atlas, details removed",
            privacyExchangeOutcomeDisplay(exchange("shared_with_reductions")).label,
        )
        assertEquals("Approved, waiting for Atlas", privacyExchangeOutcomeDisplay(exchange("ready")).label)
    }

    @Test
    fun failedStageClassificationIsMutuallyExclusive() {
        val generation = exchange("failed").copy(status = "failed")
        assertTrue(privacyAnswerGenerationFailed(generation))
        assertFalse(privacyReviewFailed(generation))

        val review = generation.copy(draftAnswer = "An invented draft.")
        assertFalse(privacyAnswerGenerationFailed(review))
        assertTrue(privacyReviewFailed(review))
        assertEquals("Nothing shared; answer failed", privacyExchangeOutcomeDisplay(generation).label)
        assertEquals(
            "Nothing shared; privacy check failed",
            privacyExchangeOutcomeDisplay(review).label,
        )

        val legacyReview = generation.copy(
            review = PrivacyExchangeReview(fallbackCause = "request_failed"),
        )
        assertFalse(privacyAnswerGenerationFailed(legacyReview))
        assertTrue(privacyReviewFailed(legacyReview))

        val authoritativeGeneration = generation.copy(
            draftAnswer = "An invented draft.",
            failure = PrivacyExchangeFailure(
                code = "invented_failure",
                message = "An invented failure.",
                stage = "answer_generation",
            ),
        )
        assertTrue(privacyAnswerGenerationFailed(authoritativeGeneration))
        assertFalse(privacyReviewFailed(authoritativeGeneration))
        assertEquals("Omnesis could not draft an answer", privacyDraftActorLabel(authoritativeGeneration))

        val authoritativeReview = generation.copy(
            failure = PrivacyExchangeFailure(
                code = "invented_failure",
                message = "An invented failure.",
                stage = "privacy_check",
            ),
        )
        assertFalse(privacyAnswerGenerationFailed(authoritativeReview))
        assertTrue(privacyReviewFailed(authoritativeReview))

        val unknownStage = generation.copy(
            failure = PrivacyExchangeFailure(
                code = "future_failure",
                message = "An invented failure.",
                stage = "future_stage",
            ),
        )
        assertTrue(privacyAnswerGenerationFailed(unknownStage))
        assertFalse(privacyReviewFailed(unknownStage))
    }

    @Test
    fun runningExchangeTruthfullyDescribesDraftGenerationAndNeedsPolling() {
        val running = exchange("checking").copy(
            status = "running",
            sharedAnswer = null,
            draftAnswer = null,
            pendingCandidate = null,
        )

        assertTrue(privacyExchangeNeedsPolling(running))
        assertEquals("Omnesis is drafting an answer", privacyDraftActorLabel(running))
        assertEquals(
            "No draft has been recorded yet. Nothing has left this machine.",
            privacyUnavailableDraftCopy(running),
        )

        val drafted = running.copy(draftAnswer = "An invented local draft.")
        assertEquals("Omnesis drafted an answer", privacyDraftActorLabel(drafted))
    }

    @Test
    fun runningExchangePollsSequentiallyAndStopsAtTerminalState() = runTest {
        var running = true
        var waits = 0
        var refreshes = 0

        pollRunningPrivacyExchange(
            isRunning = { running },
            wait = { waits += 1 },
            refresh = {
                refreshes += 1
                running = false
            },
        )

        assertEquals(1, waits)
        assertEquals(1, refreshes)
    }

    @Test
    fun runningExchangeDoesNotRefreshAfterBecomingTerminalDuringWait() = runTest {
        var running = true
        var refreshes = 0

        pollRunningPrivacyExchange(
            isRunning = { running },
            wait = { running = false },
            refresh = { refreshes += 1 },
        )

        assertEquals(0, refreshes)
    }

    @Test
    fun anUnknownOutcomeFallsBackToCheckingRatherThanEchoingTheToken() {
        val display = privacyOutcomeDisplay("some_future_outcome")

        assertEquals("Checking", display.label)
        assertFalse(display.label.contains("some_future_outcome"))
    }

    @Test
    fun feedLabelsDropTheRepeatedRecipientAndQuietOnlyOrdinaryOutcomes() {
        val shared = privacyFeedOutcomeDisplay(exchange("shared"))
        assertEquals("Shared", shared.outcome.label)
        assertTrue(shared.quiet)
        assertEquals(
            "Shared, details removed",
            privacyFeedOutcomeDisplay(exchange("shared_with_reductions")).outcome.label,
        )
        assertTrue(privacyFeedOutcomeDisplay(exchange("not_shared")).quiet)
        assertFalse(privacyFeedOutcomeDisplay(exchange("needs_review")).quiet)
        assertFalse(privacyFeedOutcomeDisplay(exchange("failed")).quiet)

        val unknown = privacyFeedOutcomeDisplay(exchange("future_outcome"))
        assertEquals("Outcome not recognised", unknown.outcome.label)
        assertFalse(unknown.quiet)
    }

    @Test
    fun everyKnownFeedOutcomeBelongsToExactlyOneNarrowFilter() {
        val outcomes = listOf(
            "checking",
            "needs_review",
            "ready",
            "shared",
            "shared_with_reductions",
            "not_shared",
            "failed",
            "canceled",
        )
        val narrowing = PrivacyFeedFilter.entries.filterNot { it == PrivacyFeedFilter.ALL }
        outcomes.forEach { outcome ->
            val item = exchange(outcome)
            assertEquals(1, narrowing.count { privacyFeedFilterMatches(it, item) })
            assertTrue(privacyFeedFilterMatches(PrivacyFeedFilter.ALL, item))
        }
    }

    @Test
    fun anUnknownFeedOutcomePassesEveryFilter() {
        val unknown = exchange("future_outcome")
        PrivacyFeedFilter.entries.forEach { filter ->
            assertTrue(privacyFeedFilterMatches(filter, unknown))
        }
    }

    @Test
    fun feedCountsUseOnlyTheLoadedRowsTheyAreGiven() {
        val counts = privacyFeedFilterCounts(
            listOf(exchange("shared"), exchange("shared_with_reductions"), exchange("failed")),
        )
        assertEquals(3, counts[PrivacyFeedFilter.ALL])
        assertEquals(2, counts[PrivacyFeedFilter.SHARED])
        assertEquals(1, counts[PrivacyFeedFilter.FAILED])
        assertEquals(0, counts[PrivacyFeedFilter.WAITING])
    }

    @Test
    fun feedGroupsRowsByLocalDayAndKeepsUnknownDates() {
        val zone = ZoneOffset.UTC
        val now = Instant.parse("2026-09-03T12:00:00Z").toEpochMilli()
        val today = exchange("shared").copy(
            taskId = "today",
            sharedAt = Instant.parse("2026-09-03T10:15:00Z").toEpochMilli(),
        )
        val todayAgain = today.copy(
            taskId = "today-again",
            sharedAt = Instant.parse("2026-09-03T09:00:00Z").toEpochMilli(),
        )
        val yesterday = today.copy(
            taskId = "yesterday",
            sharedAt = Instant.parse("2026-09-02T20:00:00Z").toEpochMilli(),
        )
        val older = today.copy(
            taskId = "older",
            sharedAt = Instant.parse("2026-08-31T20:00:00Z").toEpochMilli(),
        )
        val undated = exchange("failed").copy(taskId = "undated", createdAt = 0, resolvedAt = null)

        val days = privacyFeedDays(
            listOf(today, todayAgain, yesterday, older, undated),
            nowMillis = now,
            zoneId = zone,
            locale = Locale.US,
        )

        assertEquals("Today", days[0].heading)
        assertEquals("Yesterday", days[1].heading)
        assertTrue(days[2].heading.contains("Aug"))
        assertEquals("Date unknown", days[3].heading)
        assertEquals(listOf("today", "today-again"), days.first().exchanges.map { it.taskId })
        assertEquals("10:15", formatPrivacyFeedTime(today.sharedAt, zone, Locale.US, use24HourClock = true))
        assertEquals("10:15 AM", formatPrivacyFeedTime(today.sharedAt, zone, Locale.US, use24HourClock = false))
        assertEquals("Unknown", formatPrivacyFeedTime(null, zone, Locale.US))
        assertEquals(
            "Thursday, September 3, 2026 at 10:15",
            formatPrivacyFeedDateTime(today.sharedAt, zone, Locale.US, use24HourClock = true),
        )
        assertEquals(
            "Thursday, September 3, 2026 at 10:15 AM",
            formatPrivacyFeedDateTime(today.sharedAt, zone, Locale.US, use24HourClock = false),
        )
        assertEquals("Unknown", formatPrivacyFeedDateTime(null, zone, Locale.US))

        val frenchDays = privacyFeedDays(
            listOf(older),
            nowMillis = now,
            zoneId = zone,
            locale = Locale.FRANCE,
        )
        assertTrue(frenchDays.single().heading.contains("août"))
        assertFalse(frenchDays.single().heading.contains("Aug"))
    }

    /* ── Audit status decode ── */

    @Test
    fun onlyTheFourAuditStatusCodesRender() {
        assertEquals(
            PrivacyTone.RELEASED,
            privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("allowed", "Allowed"))?.tone,
        )
        assertEquals(
            PrivacyTone.REDUCED,
            privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("reduced", "Reduced"))?.tone,
        )
        assertEquals(
            PrivacyTone.REVIEW,
            privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("held", "Held for you"))?.tone,
        )
        assertEquals(
            PrivacyTone.KEPT,
            privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("blocked", "Blocked"))?.tone,
        )
        assertEquals(
            "Held for you",
            privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("held", "Held for you"))?.label,
        )
    }

    @Test
    fun anAbsentOrUnknownAuditStatusRendersNothingAtAll() {
        assertNull(privacyAuditStatusDisplay(null))
        // A model's raw terminal stop reason must never reach the screen styled
        // as if it were a privacy decision.
        assertNull(privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("stop", "stop")))
        assertNull(privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("approval_required", "…")))
        assertNull(privacyAuditStatusDisplay(PrivacyAuditStatusDisplay("held", "   ")))
    }

    /* ── The decision sentence ── */

    @Test
    fun theDecisionIsAlwaysAWholeSentence() {
        assertEquals(
            "Your policy allowed this answer, and Atlas received it.",
            exchangeDecisionCopy(exchange("shared")),
        )
        assertEquals(
            "Omnesis removed details from this answer, then Atlas received the rest.",
            exchangeDecisionCopy(exchange("shared_with_reductions")),
        )
        assertEquals(
            "Omnesis is holding this answer until you decide. Nothing has been shared.",
            exchangeDecisionCopy(exchange("needs_review")),
        )
        assertEquals(
            "You chose not to share. Nothing was shared.",
            exchangeDecisionCopy(exchange("not_shared").copy(userDecision = "denied")),
        )
    }

    @Test
    fun anUnattendedRequestExplainsWhyApprovalWasUnavailable() {
        val unattended = exchange("not_shared").copy(
            denialReason = "approval_not_available",
            approval = null,
            userDecision = null,
        )

        assertEquals(
            "The privacy check recommended approval, but this request has no approval flow. " +
                "Omnesis did not share the answer.",
            exchangeDecisionCopy(unattended),
        )
    }

    @Test
    fun aSharedOutcomeWinsOverAContradictoryUnavailableApprovalReason() {
        val contradictory = exchange("shared").copy(
            denialReason = "approval_not_available",
        )

        assertEquals(
            "Your policy allowed this answer, and Atlas received it.",
            exchangeDecisionCopy(contradictory),
        )
    }

    @Test
    fun aHardStopAfterYourApprovalSaysSoRatherThanClaimingYouShared() {
        val blocked = exchange("not_shared").copy(
            userDecision = "approved_but_blocked",
            review = PrivacyExchangeReview(fallbackCause = "hard_stop"),
        )

        assertEquals(
            "You approved this once, but Omnesis blocked it. Nothing was shared.",
            exchangeDecisionCopy(blocked),
        )
    }

    @Test
    fun anAutomaticHardStopDoesNotImplyTheOperatorWasInvolved() {
        val blocked = exchange("not_shared").copy(
            review = PrivacyExchangeReview(fallbackCause = "hard_stop"),
        )

        assertEquals(
            "Omnesis blocked this answer automatically. Nothing was shared.",
            exchangeDecisionCopy(blocked),
        )
    }

    @Test
    fun anApprovedButUndeliveredAnswerIsNotDescribedAsReceived() {
        val ready = exchange("ready").copy(userDecision = "approved")

        assertEquals(
            "You approved this once. Atlas has not received it yet.",
            exchangeDecisionCopy(ready),
        )
        assertFalse(exchangeDecisionCopy(ready).contains("received it."))
    }

    /* ── Pause copy and findings ── */

    @Test
    fun aReviewerThatCouldNotRunListsNoFindingsItNeverReached() {
        val review = PrivacyExchangeReview(
            fallbackCause = "request_failed",
            findings = listOf(finding("schedule", "exact", "user")),
            rationale = "unused",
        )

        assertTrue(reviewFindings(review).isEmpty())
        assertEquals("Automatic privacy check unavailable", privacyPauseCopy(review).title)
    }

    @Test
    fun aPolicyPauseShowsItsFindingsAndTheReviewersOwnReason() {
        val review = PrivacyExchangeReview(
            fallbackCause = "policy_requires_review",
            findings = listOf(finding("schedule", "exact", "user")),
            rationale = "Exact schedule detail needs your approval.",
        )

        assertEquals(1, reviewFindings(review).size)
        assertEquals("Your privacy policy asks you to decide", privacyPauseCopy(review).title)
        assertEquals("Exact schedule detail needs your approval.", privacyPauseCopy(review).message)
    }

    /* ── Whose sentence the pause message is ── */

    @Test
    fun aPauseMessageIsMarkedAQuotationOnlyWhenItIsTheReviewersOwnSentence() {
        val reviewersOwnWords = privacyPauseCopy(
            PrivacyExchangeReview(
                fallbackCause = "policy_requires_review",
                rationale = "Exact schedule detail needs your approval.",
            ),
        )
        assertTrue(reviewersOwnWords.quotesTheReviewer)

        // The reviewer said nothing usable, so the card falls back to copy
        // Omnesis wrote — which must not be attributed to the reviewer.
        val silent = listOf(
            privacyPauseCopy(null),
            privacyPauseCopy(PrivacyExchangeReview(fallbackCause = "policy_requires_review")),
            privacyPauseCopy(
                PrivacyExchangeReview(fallbackCause = "policy_requires_review", rationale = "   "),
            ),
        )
        for (copy in silent) {
            assertEquals("Nothing will be shared unless you approve this exact answer.", copy.message)
            assertFalse(copy.quotesTheReviewer)
        }

        // Both fallback states speak for Omnesis even when a rationale exists.
        assertFalse(
            privacyPauseCopy(
                PrivacyExchangeReview(fallbackCause = "request_failed", rationale = "unused"),
            ).quotesTheReviewer,
        )
        assertFalse(
            privacyPauseCopy(
                PrivacyExchangeReview(fallbackCause = "hard_stop", rationale = "unused"),
            ).quotesTheReviewer,
        )
    }

    /* ── Whose words a ledger step carries ── */

    @Test
    fun onlyTheStepsCarryingTheExchangesOwnWordsAreQuoted() {
        assertEquals(
            PrivacyQuotedParts(text = "question", detail = "stated purpose"),
            quotedParts("external_request"),
        )
        assertEquals(PrivacyQuotedParts(text = "draft answer"), quotedParts("candidate_generated"))
        assertEquals(PrivacyQuotedParts(text = "reduced answer"), quotedParts("reduction_generated"))
        assertEquals(PrivacyQuotedParts(text = "privacy check summary"), quotedParts("privacy_review"))
        assertEquals(PrivacyQuotedParts(text = "answer that was shared"), quotedParts("released"))

        val omnesisOwnVoice = listOf(
            "agent_trace",
            "approval_requested",
            "approval_resolved",
            "denied",
            "failed",
            "truncated",
            "egress",
        )
        for (kind in omnesisOwnVoice) {
            assertEquals("$kind speaks for Omnesis", PrivacyQuotedParts(), quotedParts(kind))
        }
    }

    @Test
    fun aStepKindThisBuildHasNeverHeardOfStaysProse() {
        assertEquals(PrivacyAuditStepKind.UNKNOWN, privacyAuditStepKind("some_future_kind"))
        assertEquals(PrivacyAuditStepKind.UNKNOWN, privacyAuditStepKind(""))
        assertEquals(PrivacyQuotedParts(), quotedParts("some_future_kind"))
    }

    private fun quotedParts(wireKind: String) =
        privacyAuditQuotedParts(privacyAuditStepKind(wireKind))

    /* ── How a quotation is set ── */

    @Test
    fun aQuoteTakesTheTypewriterFaceAStepBelowTheProseItSitsAmong() {
        val quoted = privacyQuoteTextStyle(TextStyle(fontSize = 16.sp, lineHeight = 22.sp))

        assertEquals(FontFamily.Monospace, quoted.fontFamily)
        // A monospace face sets wider at the same nominal size, so the step
        // back is what keeps a quotation quieter than the prose around it.
        assertEquals(16f * 0.88f, quoted.fontSize.value, 0.001f)
        assertEquals(22f * 0.88f, quoted.lineHeight.value, 0.001f)
    }

    @Test
    fun aQuoteWithNoSizeToStepDownFromKeepsWhatItInherits() {
        val quoted = privacyQuoteTextStyle(TextStyle())

        assertEquals(FontFamily.Monospace, quoted.fontFamily)
        assertTrue(quoted.fontSize.isUnspecified)
        assertTrue(quoted.lineHeight.isUnspecified)
    }

    @Test
    fun findingLabelsNameACategoryWithoutQuotingTheHeldAnswer() {
        assertEquals("Exact schedule", privacyFindingLabel(finding("schedule", "exact", "user")))
        assertEquals("Schedule", privacyFindingLabel(finding("schedule", "summary", "user")))
        assertEquals(
            "Private Communication",
            privacyFindingLabel(finding("private_communication", "summary", "user")),
        )
        assertEquals(
            "Another person",
            privacyFindingLabel(finding("schedule", "exact", "other_person")),
        )
    }

    /* ── The spine's running order ── */

    private fun auditEvent(id: String, kind: String, at: Long) = PrivacyAuditEventSummary(
        id = id,
        taskId = "task-example",
        kind = kind,
        createdAt = at,
        display = PrivacyAuditEventDisplay(title = kind),
    )

    @Test
    fun theSpineRunsInTheLedgersOrderAndBothCardsAlwaysAppear() {
        val ledger = listOf(
            auditEvent("e1", "external_request", 1_000),
            auditEvent("e2", "agent_trace", 2_000),
            auditEvent("e3", "candidate_generated", 3_000),
            auditEvent("e4", "privacy_review", 4_000),
            auditEvent("e5", "released", 5_000),
            auditEvent("e6", "egress", 6_000),
        )

        val order = privacySpineOrder(exchange("shared"), ledger)

        // The agent's step was recorded before the draft, so it sits above the
        // draft card: the ledger decides, not the card's importance.
        assertEquals(
            listOf("e2", "e3", "e4"),
            order.inside.map { it.key },
        )
        assertEquals("e5", order.released?.id)
        assertEquals(listOf("e6"), order.afterRelease.map { it.id })
        assertEquals(1_000L, order.askedAt)
    }

    @Test
    fun aLedgerThatRecordedNothingStillGetsBothCards() {
        val order = privacySpineOrder(exchange("shared"), emptyList())

        assertEquals(listOf("draft", "check"), order.inside.map { it.key })
        assertNull(order.released)
        assertEquals(exchange("shared").createdAt, order.askedAt)
    }

    @Test
    fun onlyTheFirstMomentOfEachDayCarriesItsDate() {
        val day = 24L * 60 * 60 * 1000
        val breaks = privacyDayBreaks(
            listOf(
                "a" to 1_700_000_000_000,
                "b" to 1_700_000_010_000,
                "c" to 1_700_000_000_000 + day * 2,
                // A moment with no instant cannot open a day, and must not end
                // the run either.
                "d" to null,
            ),
        )

        assertEquals(setOf("a", "c"), breaks)
    }


    @Test
    fun aCategoryIsNeverPrintedAsItsWireToken() {
        assertEquals("Private Communication", privacyCategoryLabel("private_communication"))
        assertEquals("Sensitive Information", privacyCategoryLabel(""))
    }

    /* ── Watches ── */

    @Test
    fun aFiringsDisclosureIsNamedRatherThanEchoed() {
        assertEquals("Existence only", subscriptionDisclosureLabel("existence"))
        assertEquals("Unknown", subscriptionDisclosureLabel("summary"))
    }

    /* ── Resolution copy ── */

    @Test
    fun resolutionCopyDistinguishesApprovalFromAPostApprovalBlock() {
        assertEquals("Answer approved", privacyResolutionCopy("released", null).title)
        assertEquals("Answer blocked", privacyResolutionCopy("denied", "hard_stop").title)
        assertEquals("Approval expired", privacyResolutionCopy("denied", "expired").title)
        assertEquals("Answer not shared", privacyResolutionCopy("denied", "user_denied").title)
    }

    @Test
    fun aReleasedResolutionNamesTheConcreteRecipient() {
        assertEquals(
            "The answer is ready for Research assistant to collect.",
            privacyResolutionCopy(
                "released",
                null,
                PrivacyExternalAgentIdentity(
                    displayName = "Research principal",
                    narrativeName = "Research assistant",
                    source = "principal",
                ),
            ).message,
        )
    }

    @Test
    fun aBoundaryThatPausedAgainSaysTheDecisionIsStillOpen() {
        assertEquals(
            "Still waiting for your decision",
            privacyResolutionCopy("approval_required", null).title,
        )
    }

    @Test
    fun aFailureCarriesTheGatewaysSafeExplanation() {
        val failed = exchange("failed").copy(
            failure = PrivacyExchangeFailure("reviewer_unreachable", "The reviewer model was unreachable."),
        )

        assertEquals("The reviewer model was unreachable.", failed.failure?.message)
        assertEquals(
            "The privacy check did not run because Omnesis produced no answer. Nothing was shared.",
            exchangeDecisionCopy(failed),
        )
    }

    private fun agent(name: String) = PrivacyExternalAgentIdentity(displayName = name, source = "token")

    private fun finding(category: String, detailLevel: String, subject: String) = PrivacyFinding(
        category = category,
        detailLevel = detailLevel,
        subject = subject,
        disposition = "approval",
        description = "A category-level explanation.",
    )

    private fun exchange(outcome: String) = PrivacyExchangePresentation(
        taskId = "task-example",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = agent("Atlas (openclaw)"),
        workflow = PrivacyExchangeWorkflow("Prepare project update", "Prepare an invented update."),
        question = "What is the next milestone?",
        status = "released",
        outcome = outcome,
        createdAt = 100,
        resolvedAt = 200,
        sharedAt = if (outcome.startsWith("shared")) 300 else null,
        approval = if (outcome == "needs_review") {
            PrivacyExchangeApproval(id = "approval-example", status = "pending", expiresAt = 400)
        } else {
            null
        },
    )
}

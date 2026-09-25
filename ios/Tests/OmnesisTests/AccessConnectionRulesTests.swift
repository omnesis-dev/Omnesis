// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Connection step's rules around its paths: which levels and
/// connections can serve a request, names, lists and copy, the flow a
/// gateway without proposals keeps, and what a refusal says.
final class AccessConnectionRulesTests: XCTestCase {
    private let fixtures = AccessConnectionFixtures()

    func testAnAgentThatNeedsAnswerCannotUseLevelsOrConnectionsWithoutIt() {
        let needsAnswer = fixtures.request(requiresAnswer: true)
        XCTAssertEqual(
            accessConnectionUnavailableReason(rules: [.notes], request: needsAnswer),
            "This agent needs Answer."
        )
        XCTAssertNil(accessConnectionUnavailableReason(rules: fixtures.answerRules, request: needsAnswer))
        XCTAssertNil(accessConnectionUnavailableReason(rules: [.notes], request: fixtures.request()))

        let notesMatch = AccessConnectionFixtures.grant("grant-desk", rules: [.notes], levelId: fixtures.notesLevel.id)
        let noAnswer = fixtures.overview(principals: [
            AccessConnectionFixtures.principal("principal-desk", name: "Northstar desk", grants: [notesMatch]),
        ])
        let recommended = AccessConnectionProposal(
            defaultName: "Northstar Assistant",
            defaultLevelName: "Northstar Assistant",
            match: AccessConnectionProposal.Match(
                connectionId: "principal-desk",
                connectionName: "Northstar desk",
                matchedBy: "device",
                levelId: fixtures.notesLevel.id,
                grant: notesMatch
            ),
            recommended: .replace
        )
        var choice = fixtures.opened(recommended, request: needsAnswer, overview: noAnswer)
        XCTAssertFalse(choice.replacing)
        XCTAssertEqual(choice.path, .newLevel)

        choice.levelId = fixtures.notesLevel.id
        XCTAssertFalse(choice.isComplete(request: needsAnswer, overview: noAnswer))
        let form = fixtures.form(request: needsAnswer, overview: noAnswer)
        XCTAssertNil(choice.selection(request: needsAnswer, overview: noAnswer, form: form))
        choice.levelId = nil
        choice.replacing = true
        choice.connectionId = "principal-desk"
        XCTAssertFalse(choice.isComplete(request: needsAnswer, overview: noAnswer))

        let levelWithoutAnswer = AccessConnectionProposal(
            defaultName: "Northstar Assistant",
            defaultLevelName: "Northstar Assistant",
            match: recommended.match,
            recommended: .existingLevel
        )
        let unpreselected = fixtures.opened(levelWithoutAnswer, request: needsAnswer, overview: noAnswer)
        XCTAssertEqual(unpreselected.path, .newLevel)
        XCTAssertEqual(unpreselected.suggestedLevelId, fixtures.notesLevel.id)
    }

    func testNamesAreRequiredAndCutToTheGatewayLimit() {
        let request = fixtures.request()
        let overview = fixtures.overview()
        var choice = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        choice.name = "   "
        XCTAssertEqual(choice.nameError, "Enter a name for this connection.")
        XCTAssertFalse(choice.isComplete(request: request, overview: overview))
        choice.name = "Northstar desk"
        choice.levelName = ""
        XCTAssertEqual(choice.levelNameError(overview: overview), "Enter a name for this access level.")
        XCTAssertFalse(choice.isComplete(request: request, overview: overview))
        choice.levelId = fixtures.zetaLevel.id
        XCTAssertNil(choice.levelNameError(overview: overview))
        XCTAssertTrue(choice.isComplete(request: request, overview: overview))

        XCTAssertEqual(accessConnectionClampedName(String(repeating: "a", count: 130)).count, 120)
        let fill = String(repeating: "N", count: 119)
        XCTAssertEqual(accessConnectionClampedName(fill + "🎉"), fill)
        XCTAssertNil(accessConnectionTrimmedName(" \n "))
        XCTAssertEqual(accessConnectionTrimmedName(" desk "), "desk")

        let long = AccessConnectionProposal(
            defaultName: String(repeating: "b", count: 150),
            defaultLevelName: String(repeating: "c", count: 150),
            match: nil,
            recommended: .newLevel
        )
        let clamped = fixtures.opened(long)
        XCTAssertEqual(clamped.name.utf16.count, 120)
        XCTAssertEqual(clamped.levelName.utf16.count, 120)
    }

    func testLiveConnectionsListOnlyLiveOnesMostRecentlyUsedFirst() {
        typealias Fixture = AccessConnectionFixtures
        let rules = fixtures.answerRules
        let listed = fixtures.overview(principals: [
            Fixture.principal("p-revoked", name: "Revoked", grants: [Fixture.grant("g1", rules: rules, lastUsed: [9])], revokedAt: 1),
            Fixture.principal("p-revoked-grant", name: "Revoked grant", grants: [Fixture.grant("g2", rules: rules, revokedAt: 1)]),
            Fixture.principal("p-service", name: "Service", grants: [Fixture.grant("g3", rules: rules)], kind: "service"),
            Fixture.principal("p-beta", name: "beta", grants: [Fixture.grant("g4", rules: rules)]),
            Fixture.principal("p-alpha", name: "Alpha", grants: [Fixture.grant("g5", rules: rules, lastUsed: [nil])]),
            Fixture.principal("p-old", name: "Old", grants: [Fixture.grant("g6", rules: rules, lastUsed: [100])]),
            Fixture.principal("p-new", name: "New", grants: [Fixture.grant("g7", rules: rules, lastUsed: [50, 200, nil])]),
        ])
        let connections = accessLiveConnections(listed, nowMillis: fixtures.now)
        XCTAssertEqual(connections.map(\.id), ["p-new", "p-old", "p-alpha", "p-beta"])
        XCTAssertEqual(connections.first?.lastUsedAt, 200)
        XCTAssertNil(connections.last?.lastUsedAt)
        XCTAssertEqual(AccessConnectionCopy.lastUsed(nil), "Never used")
        XCTAssertTrue(AccessConnectionCopy.lastUsed(1_800_000_000_000).hasPrefix("Last used "))
        XCTAssertNil(connections.first?.level(in: fixtures.overview()))
        XCTAssertEqual(
            accessLiveConnections(fixtures.overview(), nowMillis: fixtures.now).first?.level(in: fixtures.overview())?.name,
            "Research assistants"
        )
    }

    func testCountsAndFootnotesPluralise() {
        XCTAssertEqual(AccessConnectionCopy.connectionCount(0), "No connections")
        XCTAssertEqual(AccessConnectionCopy.connectionCount(1), "1 connection")
        XCTAssertEqual(AccessConnectionCopy.connectionCount(3), "3 connections")
        XCTAssertEqual(
            AccessConnectionCopy.sharedLevel(otherConnections: 3),
            "Also used by 3 other connections. Changing this access level later changes all of them."
        )
    }

    /// No `connection` in the lookup: no Connection step, the permissions
    /// flow on its own, approved with `connect`, pre-filled from the
    /// principal that gateway would reconnect to.
    func testAGatewayWithoutProposalsKeepsTheConnectFlow() {
        let request = fixtures.request()
        let overview = fixtures.overview()
        let plain = AccessAuthorizationOpening(
            request: request,
            overview: overview,
            connection: nil,
            reconnect: nil,
            nowMillis: fixtures.now
        )
        XCTAssertNil(plain.choice)
        XCTAssertEqual(plain.step, .permissions)
        XCTAssertEqual(accessAuthorizationSteps(choice: nil, readsSources: true), [.permissions, .data, .review])
        XCTAssertEqual(accessAuthorizationSteps(choice: nil, readsSources: false), [.permissions, .review])
        XCTAssertEqual(AccessConnectionReview.legacy(request: request, reconnect: nil).connectionName, "Northstar Assistant")

        let reconnect = AccessReconnectProposal(
            matchedBy: "client",
            principal: AccessReconnectProposal.Principal(id: "principal-desk", name: "Northstar desk"),
            grant: AccessConnectionFixtures.grant("grant-desk", rules: [.notes])
        )
        let recognised = AccessAuthorizationOpening(
            request: request,
            overview: overview,
            connection: nil,
            reconnect: reconnect,
            nowMillis: fixtures.now
        )
        XCTAssertNil(recognised.choice)
        XCTAssertEqual(recognised.step, .permissions)
        XCTAssertEqual(
            recognised.form.selection(request: request, overview: overview),
            .connect(rules: [.notes], credentialLabel: "Northstar Assistant")
        )
        XCTAssertEqual(
            AccessConnectionReview.legacy(request: request, reconnect: reconnect),
            AccessConnectionReview(connectionName: "Northstar desk", accessLevel: nil, replaces: nil, levelFootnote: nil)
        )
    }

    func testRefusalsNameWhatChanged() {
        let taken = GatewayClient.Error.serverError(status: 409, body: #"{"error":"level-name-taken"}"#)
        XCTAssertTrue(accessAuthorizationIsLevelNameTaken(taken))
        XCTAssertFalse(accessAuthorizationIsStaleSelectionError(taken))
        XCTAssertFalse(accessAuthorizationIsTerminalError(taken))
        let stale = GatewayClient.Error.serverError(status: 409, body: #"{"error":"stale-revision"}"#)
        XCTAssertTrue(accessAuthorizationIsStaleSelectionError(stale))
        XCTAssertFalse(accessAuthorizationIsLevelNameTaken(stale))
        for code in ["stale-revision", "inactive-grant", "invalid-selection"] {
            XCTAssertEqual(
                accessAuthorizationDecisionMessage(errorCode: code, choiceRefresh: .refreshed),
                "Access choices changed. Review the refreshed request."
            )
        }
    }

    /// A taken level name sends the owner to the Connection step; a stale
    /// selection does too once its choices were refreshed, or to Permissions
    /// on a gateway without proposals. Anything else stays where it is.
    func testARefusalReturnsTheWizardToTheStepThatFixesIt() {
        let taken = GatewayClient.Error.serverError(status: 409, body: #"{"error":"level-name-taken"}"#)
        let stale = GatewayClient.Error.serverError(status: 409, body: #"{"error":"stale-revision"}"#)
        XCTAssertEqual(accessAuthorizationRefusalStep(error: taken, hasChoice: true, refreshed: false), .connection)
        XCTAssertNil(accessAuthorizationRefusalStep(error: taken, hasChoice: false, refreshed: false))
        XCTAssertEqual(accessAuthorizationRefusalStep(error: stale, hasChoice: true, refreshed: true), .connection)
        XCTAssertEqual(accessAuthorizationRefusalStep(error: stale, hasChoice: false, refreshed: true), .permissions)
        XCTAssertNil(accessAuthorizationRefusalStep(error: stale, hasChoice: true, refreshed: false))
        XCTAssertNil(
            accessAuthorizationRefusalStep(error: AccessAuthorizationLocalError.expired, hasChoice: true, refreshed: true)
        )
    }

    /// A new level's name that a listed level already has, ignoring case and
    /// surrounding spaces, bars the step with the gateway's own wording
    /// before anything is sent. Only a new level is checked.
    func testANewLevelNameAlreadyInUseBarsTheStep() {
        let request = fixtures.request()
        let overview = fixtures.overview()
        var form = fixtures.form()
        form.answerSources.allowAll(fixtures.known)
        var choice = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        XCTAssertNil(choice.levelNameError(overview: overview))
        for taken in ["Research assistants", "  research ASSISTANTS ", "Notes Only"] {
            choice.levelName = taken
            XCTAssertEqual(choice.levelNameError(overview: overview), "An access level with that name already exists.")
            XCTAssertEqual(choice.levelNameError(overview: overview), AccessConnectionCopy.levelNameTaken)
            XCTAssertFalse(choice.isComplete(request: request, overview: overview))
            XCTAssertNil(choice.selection(request: request, overview: overview, form: form))
        }
        choice.levelName = "Research assistants 2"
        XCTAssertNil(choice.levelNameError(overview: overview))
        XCTAssertTrue(choice.isComplete(request: request, overview: overview))
        XCTAssertNotNil(choice.selection(request: request, overview: overview, form: form))
        XCTAssertNil(choice.levelNameError(overview: fixtures.overview(levels: [])))

        choice.levelName = "Zeta"
        choice.levelId = fixtures.zetaLevel.id
        XCTAssertNil(choice.levelNameError(overview: overview))
        XCTAssertTrue(choice.isComplete(request: request, overview: overview))
        choice.levelId = nil
        choice.replacing = true
        XCTAssertNil(choice.levelNameError(overview: overview))
    }

    /// Only a new level sends a name, so a refused name bars that path alone.
    func testATakenLevelNameBarsOnlyTheNewLevelPath() {
        var choice = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        XCTAssertTrue(choice.levelNameRefusalApplies(true))
        XCTAssertFalse(choice.levelNameRefusalApplies(false))
        choice.levelId = fixtures.zetaLevel.id
        XCTAssertFalse(choice.levelNameRefusalApplies(true))
        choice.levelId = nil
        choice.replacing = true
        XCTAssertFalse(choice.levelNameRefusalApplies(true))
    }

    /// A refreshed choice keeps the names the owner typed while it opens on
    /// the same path, and otherwise opens as the refreshed proposal does.
    func testARefreshKeepsTypedNamesOnlyOnTheSamePath() {
        var typed = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        typed.name = "desk helper"
        typed.levelName = "desk helpers"
        let refreshedNew = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        let kept = refreshedNew.keepingNames(from: typed)
        XCTAssertEqual(kept.name, "desk helper")
        XCTAssertEqual(kept.levelName, "desk helpers")
        XCTAssertEqual(kept.path, .newLevel)
        let refreshedExisting = fixtures.opened(fixtures.proposal(.existingLevel))
        XCTAssertEqual(refreshedExisting.keepingNames(from: typed), refreshedExisting)
        XCTAssertEqual(refreshedNew.keepingNames(from: nil), refreshedNew)
    }

    /// Replace mode does not hide the suggested level: it still leads the
    /// list the owner returns to.
    func testAReplaceRecommendationStillListsTheMatchedLevelFirst() {
        let choice = fixtures.opened(fixtures.proposal(.replace, matchedBy: "device"))
        XCTAssertTrue(choice.replacing)
        XCTAssertEqual(choice.suggestedLevelId, "level-research")
        XCTAssertEqual(
            choice.orderedLevels(overview: fixtures.overview()).map(\.id),
            ["level-research", "level-notes", "level-zeta"]
        )
        XCTAssertEqual(choice.suggestion(for: fixtures.researchLevel), "Northstar desk uses this access level.")
    }

    /// The suggestion sits in the matched connection's own row whichever
    /// connection is picked, and only for a replace recommendation.
    func testTheReplaceSuggestionStaysOnTheMatchedConnection() {
        typealias Fixture = AccessConnectionFixtures
        let other = Fixture.principal(
            "principal-other",
            name: "Riverside planner",
            grants: [Fixture.grant("grant-other", rules: fixtures.answerRules)]
        )
        let overview = fixtures.overview(principals: [
            Fixture.principal("principal-desk", name: "Northstar desk", grants: [fixtures.deskGrant]),
            other,
        ])
        let rows = accessLiveConnections(overview, nowMillis: fixtures.now)
        XCTAssertEqual(rows.map(\.id), ["principal-desk", "principal-other"])
        let suggested = "Already connected on this device."

        var choice = fixtures.opened(fixtures.proposal(.replace, matchedBy: "device"), overview: overview)
        XCTAssertEqual(rows.map { choice.suggestion(for: $0) }, [suggested, nil])
        choice.connectionId = "principal-other"
        XCTAssertEqual(rows.map { choice.suggestion(for: $0) }, [suggested, nil])

        var byClient = fixtures.opened(fixtures.proposal(.existingLevel), overview: overview)
        byClient.replacing = true
        byClient.connectionId = "principal-desk"
        XCTAssertEqual(rows.map { byClient.suggestion(for: $0) }, [nil, nil])
    }

    /// A level picked before it left the overview no longer completes the
    /// step or produces a selection.
    func testAChoiceIsIncompleteOnceItsLevelIsGone() {
        let request = fixtures.request()
        let choice = fixtures.opened(fixtures.proposal(.existingLevel))
        XCTAssertTrue(choice.isComplete(request: request, overview: fixtures.overview()))
        let levelGone = fixtures.overview(levels: [fixtures.zetaLevel, fixtures.notesLevel])
        XCTAssertFalse(choice.isComplete(request: request, overview: levelGone))
        XCTAssertNil(choice.selection(request: request, overview: levelGone, form: fixtures.form(overview: levelGone)))
        XCTAssertNil(choice.review(overview: levelGone).accessLevel)
    }

    /// The review of an existing level or a replacement prints the rules
    /// taken on, named by their own policy: by name when it is listed,
    /// otherwise as a privacy policy, never as the default policy.
    func testTheReviewPrintsTheRulesTakenOnWithTheirOwnPolicy() {
        typealias Fixture = AccessConnectionFixtures
        let request = fixtures.request()
        let retiredRules: [AccessGrantRule] = [
            .answer(
                sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                release: .reviewed(policyFamilyId: "policy-retired")
            ),
            .notes,
        ]
        let level = Fixture.level("level-retired", name: "retired policy", rules: retiredRules)
        let grant = Fixture.grant("grant-desk", rules: retiredRules, revision: 6, levelId: level.id)
        let overview = fixtures.overview(
            levels: [level],
            principals: [Fixture.principal("principal-desk", name: "Northstar desk", grants: [grant])]
        )
        let blank = fixtures.form(overview: overview)
        XCTAssertEqual(accessAnswerPrivacySummary(form: blank, overview: overview), "Work-safe")

        var choice = fixtures.opened(fixtures.proposal(.replace, matchedBy: "device"), overview: overview)
        XCTAssertEqual(choice.path, .replace)
        let replaced = choice.reviewForm(request: request, overview: overview, form: blank)
        XCTAssertEqual(replaced.holdings(request: request), AccessCapabilityHoldings(answer: true, notes: true))
        XCTAssertEqual(replaced.policyFamilyId, "policy-retired")
        XCTAssertEqual(accessAnswerPrivacySummary(form: replaced, overview: overview), "Privacy policy")

        choice.replacing = false
        choice.levelId = level.id
        XCTAssertEqual(choice.path, .existingLevel)
        let joined = choice.reviewForm(request: request, overview: overview, form: blank)
        XCTAssertEqual(joined.holdings(request: request), AccessCapabilityHoldings(answer: true, notes: true))
        XCTAssertEqual(accessAnswerPrivacySummary(form: joined, overview: overview), "Privacy policy")

        let listed = fixtures.opened(fixtures.proposal(.replace, matchedBy: "device"))
        let listedReview = listed.reviewForm(request: request, overview: fixtures.overview(), form: fixtures.form())
        XCTAssertEqual(accessAnswerPrivacySummary(form: listedReview, overview: fixtures.overview()), "Work-safe")
    }

    /// A connection whose grant has expired cannot be taken over: it is not
    /// listed, and one expiring exactly now counts as expired.
    func testAnExpiredConnectionIsNotListed() {
        typealias Fixture = AccessConnectionFixtures
        let rules = fixtures.answerRules
        let overview = fixtures.overview(principals: [
            Fixture.principal("p-open", name: "open", grants: [Fixture.grant("g1", rules: rules)]),
            Fixture.principal("p-later", name: "later", grants: [Fixture.grant("g2", rules: rules, expiresAt: fixtures.now + 1)]),
            Fixture.principal("p-now", name: "now", grants: [Fixture.grant("g3", rules: rules, expiresAt: fixtures.now)]),
            Fixture.principal("p-past", name: "past", grants: [Fixture.grant("g4", rules: rules, expiresAt: fixtures.now - 1)]),
        ])
        XCTAssertEqual(accessLiveConnections(overview, nowMillis: fixtures.now).map(\.id), ["p-later", "p-open"])
    }

    /// A replace recommendation whose connection has expired opens on a new
    /// access level, with the connection no longer listed to suggest; once a
    /// connection is picked, the review and the selection no longer depend
    /// on the clock.
    func testAnExpiredReplaceTargetFallsBackToANewLevel() {
        let request = fixtures.request()
        let expiring = AccessConnectionFixtures.grant(
            "grant-desk",
            rules: fixtures.deskGrant.rules,
            revision: 6,
            levelId: fixtures.researchLevel.id,
            expiresAt: fixtures.now + 1000
        )
        let overview = fixtures.overview(principals: [
            AccessConnectionFixtures.principal("principal-desk", name: "Northstar desk", grants: [expiring]),
        ])
        let proposal = fixtures.proposal(.replace, matchedBy: "device")

        let expired = AccessConnectionChoice.opening(
            request: request,
            overview: overview,
            proposal: proposal,
            nowMillis: fixtures.now + 1000
        )
        XCTAssertFalse(expired.replacing)
        XCTAssertEqual(expired.path, .newLevel)
        XCTAssertNil(expired.connectionId)
        XCTAssertTrue(accessLiveConnections(overview, nowMillis: fixtures.now + 1000).isEmpty)

        let picked = fixtures.opened(proposal, overview: overview)
        XCTAssertTrue(picked.replacing)
        XCTAssertEqual(picked.connectionId, "principal-desk")
        XCTAssertTrue(picked.isComplete(request: request, overview: overview))
        XCTAssertEqual(
            picked.selection(request: request, overview: overview, form: fixtures.form(overview: overview)),
            .replaceConnection(connectionId: "principal-desk", expectedGrantRevision: 6)
        )
        XCTAssertEqual(picked.review(overview: overview).connectionName, "Northstar desk")
    }
}

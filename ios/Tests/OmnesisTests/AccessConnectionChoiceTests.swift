// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Connection step's paths: what it preselects from the gateway's
/// proposal, and what each path sends, reviews and walks through.
final class AccessConnectionChoiceTests: XCTestCase {
    private let fixtures = AccessConnectionFixtures()

    /// Nothing matched: a new connection on a new level, both named from the
    /// proposal, with the permissions wizard ahead of the review.
    func testANewLevelIsTheDefaultWithoutAMatch() {
        let choice = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        XCTAssertEqual(choice.path, .newLevel)
        XCTAssertFalse(choice.replacing)
        XCTAssertEqual(choice.name, "Northstar Assistant 2")
        XCTAssertEqual(choice.levelName, "Northstar Assistant")
        XCTAssertNil(choice.suggestedLevelId)
        XCTAssertNil(choice.suggestion(for: fixtures.deskConnection))
        XCTAssertNil(choice.prefillRules)
        XCTAssertEqual(choice.steps(readsSources: true), [.connection, .permissions, .data, .review])
        XCTAssertEqual(choice.steps(readsSources: false), [.connection, .permissions, .review])
        XCTAssertEqual(
            choice.orderedLevels(overview: fixtures.overview()).map(\.name),
            ["notes only", "Research assistants", "Zeta"]
        )

        let opening = AccessAuthorizationOpening(
            request: fixtures.request(),
            overview: fixtures.overview(),
            connection: fixtures.proposal(.newLevel, match: false),
            reconnect: nil,
            nowMillis: fixtures.now
        )
        XCTAssertEqual(opening.step, .connection)
        XCTAssertEqual(opening.form.holdings(request: fixtures.request()), AccessCapabilityHoldings(answer: true))
    }

    /// A new level sends its name with the rules the wizard drew, both names
    /// trimmed.
    func testANewLevelSendsItsNameWithTheFormRules() {
        let request = fixtures.request()
        let overview = fixtures.overview()
        var choice = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        choice.name = "  Northstar desk  "
        choice.levelName = " Desk helpers "
        var form = fixtures.form()
        XCTAssertNil(choice.selection(request: request, overview: overview, form: form))
        form.answerSources.allowAll(fixtures.known)
        let rules: [AccessGrantRule] = [.answer(
            sources: AccessSourceBoundary(mode: .allowlist, sourceIds: fixtures.known.sorted()),
            release: .reviewed(policyFamilyId: "policy-work-safe")
        )]
        XCTAssertEqual(
            choice.selection(request: request, overview: overview, form: form),
            .newConnection(name: "Northstar desk", level: .new(name: "Desk helpers", rules: rules))
        )
        XCTAssertEqual(choice.effectiveRules(request: request, overview: overview, form: form), rules)
        XCTAssertEqual(
            choice.review(overview: overview),
            AccessConnectionReview(
                connectionName: "Northstar desk",
                accessLevel: "Desk helpers (new)",
                replaces: nil,
                levelFootnote: nil
            )
        )
    }

    /// A match whose level is live: that level is listed first, tagged,
    /// preselected, and the new connection joins it at its revision.
    func testAnExistingLevelRecommendationPreselectsTheMatchedLevel() {
        let request = fixtures.request()
        let overview = fixtures.overview()
        let choice = fixtures.opened(fixtures.proposal(.existingLevel))
        XCTAssertEqual(choice.path, .existingLevel)
        XCTAssertEqual(choice.levelId, "level-research")
        XCTAssertEqual(
            choice.orderedLevels(overview: overview).map(\.id),
            ["level-research", "level-notes", "level-zeta"]
        )
        XCTAssertEqual(choice.suggestion(for: fixtures.researchLevel), "Northstar desk uses this access level.")
        XCTAssertNil(choice.suggestion(for: fixtures.zetaLevel))
        XCTAssertEqual(choice.steps(readsSources: true), [.connection, .review])
        let form = fixtures.form()
        XCTAssertEqual(
            choice.selection(request: request, overview: overview, form: form),
            .newConnection(
                name: "Northstar Assistant 2",
                level: .existing(levelId: "level-research", expectedLevelRevision: 4)
            )
        )
        XCTAssertEqual(
            choice.review(overview: overview),
            AccessConnectionReview(
                connectionName: "Northstar Assistant 2",
                accessLevel: "Research assistants",
                replaces: nil,
                levelFootnote: "Also used by 2 other connections. Changing this access level later changes all of them."
            )
        )
        XCTAssertEqual(
            choice.reviewForm(request: request, overview: overview, form: form).holdings(request: request),
            AccessCapabilityHoldings(answer: true, notes: true)
        )
    }

    /// A new level still starts from the matched connection's permissions,
    /// and the matched level keeps its tag without being preselected.
    func testANewLevelWithAMatchIsPrefilledFromItsPermissions() {
        let opening = AccessAuthorizationOpening(
            request: fixtures.request(),
            overview: fixtures.overview(),
            connection: fixtures.proposal(.newLevel),
            reconnect: nil,
            nowMillis: fixtures.now
        )
        XCTAssertEqual(opening.choice?.path, .newLevel)
        XCTAssertEqual(opening.choice?.suggestedLevelId, "level-research")
        XCTAssertEqual(
            opening.form.holdings(request: fixtures.request()),
            AccessCapabilityHoldings(answer: true, notes: true)
        )
        XCTAssertEqual(
            opening.form.rules(request: fixtures.request(), overview: fixtures.overview()),
            [.notes] + fixtures.answerRules
        )
    }

    /// The agent's own device: replace mode with its connection picked and
    /// suggested in its row, and a review that keeps the connection's name
    /// and level.
    func testAReplaceRecommendationOpensReplaceModeOnTheMatchedConnection() {
        let request = fixtures.request()
        let overview = fixtures.overview()
        var choice = fixtures.opened(fixtures.proposal(.replace, matchedBy: "device"))
        XCTAssertTrue(choice.replacing)
        XCTAssertEqual(choice.path, .replace)
        XCTAssertEqual(choice.connectionId, "principal-desk")
        XCTAssertEqual(choice.suggestion(for: fixtures.deskConnection), "Already connected on this device.")
        choice.name = ""
        XCTAssertNil(choice.nameError)
        XCTAssertEqual(choice.steps(readsSources: true), [.connection, .review])
        let form = fixtures.form()
        XCTAssertEqual(
            choice.selection(request: request, overview: overview, form: form),
            .replaceConnection(connectionId: "principal-desk", expectedGrantRevision: 6)
        )
        XCTAssertEqual(choice.effectiveRules(request: request, overview: overview, form: form), fixtures.deskGrant.rules)
        XCTAssertEqual(
            choice.review(overview: overview),
            AccessConnectionReview(
                connectionName: "Northstar desk",
                accessLevel: "Research assistants",
                replaces: "The current sign-in of Northstar desk",
                levelFootnote: "Also used by 1 other connection. Changing this access level later changes all of them."
            )
        )
        let alone = fixtures.overview(levels: [
            AccessConnectionFixtures.level("level-research", name: "Research assistants", rules: fixtures.answerRules),
        ])
        XCTAssertNil(choice.review(overview: alone).levelFootnote)
    }

    /// Switching back from replace mode is a new connection again, and
    /// nothing is selected in replace mode until the owner picks.
    func testTheOwnerCanMoveBetweenModes() {
        let request = fixtures.request()
        let overview = fixtures.overview()
        var choice = fixtures.opened(fixtures.proposal(.newLevel, match: false))
        choice.replacing = true
        XCTAssertEqual(choice.path, .replace)
        XCTAssertNil(choice.suggestion(for: fixtures.deskConnection))
        XCTAssertFalse(choice.isComplete(request: request, overview: overview))
        choice.connectionId = "principal-desk"
        XCTAssertTrue(choice.isComplete(request: request, overview: overview))
        choice.replacing = false
        XCTAssertEqual(choice.path, .newLevel)
    }

    /// A recommendation whose level or connection is gone opens on a new
    /// level, with no replace row left to suggest; a matched level that is
    /// still live keeps its tag.
    func testARecommendationThatNoLongerAppliesOpensOnANewLevel() {
        let levelGone = fixtures.opened(
            fixtures.proposal(.existingLevel),
            overview: fixtures.overview(levels: [fixtures.zetaLevel])
        )
        XCTAssertEqual(levelGone.path, .newLevel)
        XCTAssertNil(levelGone.suggestedLevelId)

        let revoked = fixtures.overview(principals: [
            AccessConnectionFixtures.principal(
                "principal-desk",
                name: "Northstar desk",
                grants: [fixtures.deskGrant],
                revokedAt: 5
            ),
        ])
        let connectionGone = fixtures.opened(fixtures.proposal(.replace, matchedBy: "device"), overview: revoked)
        XCTAssertFalse(connectionGone.replacing)
        XCTAssertTrue(accessLiveConnections(revoked, nowMillis: fixtures.now).isEmpty)
        XCTAssertEqual(connectionGone.path, .newLevel)
        XCTAssertEqual(connectionGone.suggestedLevelId, "level-research")
    }
}

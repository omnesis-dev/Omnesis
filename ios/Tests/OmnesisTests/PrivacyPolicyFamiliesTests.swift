// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The policy catalogue as Settings lists it, which family it marks as the
/// default, and the policy a review record names — all pure functions of the
/// wire types, so they run in the sim-less logic lane.
final class PrivacyPolicyFamiliesTests: XCTestCase {
    private let reviewRecordFields = """
    "recipeVersion":"v1","provider":"anthropic","model":"reviewer-example","confidence":0.9,
    "policyRevision":"rev-1","findings":[],"rationale":"Approval is required."
    """

    private func family(
        _ id: String,
        name: String,
        archivedAt: Int64? = nil,
        grants: [String] = []
    )
        -> PrivacyPolicyFamilySummary {
        PrivacyPolicyFamilySummary(
            id: id,
            name: name,
            currentRevision: "rev_\(id)",
            currentVersion: 1,
            updatedAt: 1_786_851_000_000,
            archivedAt: archivedAt,
            affectedGrantIds: grants
        )
    }

    // MARK: Listing

    func testListingDropsRetiredFamiliesAndLeadsWithTheDefault() {
        let listed = privacyPolicyFamiliesForListing(
            [
                family("work", name: "Work safe"),
                family("retired", name: "Old desk", archivedAt: 1_786_720_000_000),
                family("default", name: "Household"),
                family("research", name: "Research desk"),
            ],
            defaultFamilyId: "default"
        )

        XCTAssertEqual(listed.map(\.id), ["default", "research", "work"])
    }

    func testListingOrdersByNameCaseInsensitivelyThenById() {
        let listed = privacyPolicyFamiliesForListing(
            [
                family("b", name: "beta desk"),
                family("a", name: "Alpha desk"),
                family("c", name: "Charlie desk"),
                family("a2", name: "alpha desk"),
            ],
            defaultFamilyId: nil
        )

        XCTAssertEqual(listed.map(\.id), ["a", "a2", "b", "c"])
    }

    func testListingMarksNothingWhenNoDefaultIsKnown() {
        let listed = privacyPolicyFamiliesForListing(
            [family("work", name: "Work safe"), family("household", name: "Household")],
            defaultFamilyId: nil
        )

        XCTAssertEqual(listed.map(\.id), ["household", "work"])
    }

    func testADefaultAbsentFromTheCatalogueChangesNothing() {
        let listed = privacyPolicyFamiliesForListing(
            [family("work", name: "Work safe"), family("household", name: "Household")],
            defaultFamilyId: "not-in-the-catalogue"
        )

        XCTAssertEqual(listed.map(\.id), ["household", "work"])
    }

    func testListingIsEmptyWhenEveryFamilyIsRetired() {
        let listed = privacyPolicyFamiliesForListing(
            [family("retired", name: "Old desk", archivedAt: 1)],
            defaultFamilyId: "retired"
        )

        XCTAssertTrue(listed.isEmpty)
    }

    // MARK: The default marker across refreshes

    func testAnOverviewAnswerReplacesTheMarker() {
        XCTAssertEqual(privacyDefaultPolicyMarker(previous: nil, advice: .reported("household")), "household")
        XCTAssertEqual(privacyDefaultPolicyMarker(previous: "work", advice: .reported("household")), "household")
    }

    func testAnOverviewNamingNoDefaultMarksNothing() {
        XCTAssertNil(privacyDefaultPolicyMarker(previous: "work", advice: .reported(nil)))
    }

    func testAFailedOverviewKeepsTheLastKnownMarker() {
        XCTAssertEqual(privacyDefaultPolicyMarker(previous: "work", advice: .unavailable), "work")
    }

    func testAMarkerNeverKnownStaysUnknownRatherThanGuessed() {
        XCTAssertNil(privacyDefaultPolicyMarker(previous: nil, advice: .unavailable))
    }

    // MARK: Row copy

    func testGovernanceLineCountsGrants() {
        XCTAssertEqual(privacyPolicyGovernanceLine(grantCount: 0), "governs no grant yet")
        XCTAssertEqual(privacyPolicyGovernanceLine(grantCount: 1), "governs 1 grant")
        XCTAssertEqual(privacyPolicyGovernanceLine(grantCount: 3), "governs 3 grants")
    }

    func testShortRevisionKeepsTheFirstTwelveCharacters() {
        XCTAssertEqual(privacyPolicyShortRevision("rev_household_0a1b2c3d4e5f6a7b"), "rev_househol")
        XCTAssertEqual(privacyPolicyShortRevision("0123456789ab"), "0123456789ab")
        XCTAssertEqual(privacyPolicyShortRevision("short"), "short")
    }

    func testDisplayNameFallsBackToPolicy() {
        XCTAssertEqual(privacyPolicyDisplayName(" Work safe "), "Work safe")
        XCTAssertEqual(privacyPolicyDisplayName("   "), "Policy")
        XCTAssertEqual(privacyPolicyDisplayName(nil), "Policy")
    }

    // MARK: The policy a review names

    func testReviewedPolicyNeedsAFamilyId() {
        XCTAssertNil(privacyReviewedPolicy(familyId: nil, name: "Work safe"))
        XCTAssertNil(privacyReviewedPolicy(familyId: "  ", name: "Work safe"))
    }

    func testReviewedPolicyTrimsTheIdAndKeepsANamelessRecordNameless() {
        XCTAssertEqual(
            privacyReviewedPolicy(familyId: " policy-work-safe ", name: nil),
            PrivacyReviewedPolicy(familyId: "policy-work-safe", name: nil)
        )
        XCTAssertEqual(
            privacyReviewedPolicy(familyId: "policy-work-safe", name: " Work safe "),
            PrivacyReviewedPolicy(familyId: "policy-work-safe", name: "Work safe")
        )
        XCTAssertEqual(
            privacyReviewedPolicy(familyId: "policy-work-safe", name: "  "),
            PrivacyReviewedPolicy(familyId: "policy-work-safe", name: nil)
        )
    }

    func testReviewedUnderLabelNamesThePolicyOrInvitesTheReader() {
        XCTAssertEqual(
            privacyReviewedUnderLabel(PrivacyReviewedPolicy(familyId: "p", name: "Work safe")),
            "Reviewed under Work safe"
        )
        XCTAssertEqual(
            privacyReviewedUnderLabel(PrivacyReviewedPolicy(familyId: "p", name: nil)),
            "See the policy it was reviewed under"
        )
    }

    func testReviewRecordDecodesTheFamilyItWasJudgedUnder() throws {
        let record = try JSONDecoder().decode(
            PrivacyReviewRecord.self,
            from: Data("""
            {\(reviewRecordFields),"policyFamilyId":"policy-work-safe","policyFamilyName":"Work safe"}
            """.utf8)
        )

        XCTAssertEqual(record.policyFamilyId, "policy-work-safe")
        XCTAssertEqual(record.policyFamilyName, "Work safe")
        XCTAssertEqual(
            record.reviewedPolicy,
            PrivacyReviewedPolicy(familyId: "policy-work-safe", name: "Work safe")
        )
    }

    /// A record written before families were named carries neither field;
    /// it still decodes and names no policy.
    func testReviewRecordWithoutAFamilyStillDecodes() throws {
        let record = try JSONDecoder().decode(
            PrivacyReviewRecord.self,
            from: Data("{\(reviewRecordFields)}".utf8)
        )

        XCTAssertNil(record.policyFamilyId)
        XCTAssertNil(record.policyFamilyName)
        XCTAssertNil(record.reviewedPolicy)
    }

    private func exchange(review: String) throws -> PrivacyExchangePresentation {
        try JSONDecoder().decode(
            PrivacyExchangePresentation.self,
            from: Data("""
            {"taskId":"task-1","conversationId":"conversation-1","workflowId":"workflow-1",
            "review":{\(review)}}
            """.utf8)
        )
    }

    /// The exchange's review is decoded best-effort, so the fields must ride
    /// along without turning a review that carries them into an absent one.
    func testExchangeReviewDecodesTheFamilyItWasJudgedUnder() throws {
        let exchange = try exchange(
            review: """
            "fallbackCause":null,"findings":[],"rationale":"Released.",
            "policyFamilyId":"policy-work-safe","policyFamilyName":"Work safe"
            """
        )

        XCTAssertEqual(
            exchange.review?.reviewedPolicy,
            PrivacyReviewedPolicy(familyId: "policy-work-safe", name: "Work safe")
        )
    }

    func testExchangeReviewWithoutAFamilyStillDecodes() throws {
        let exchange = try exchange(review: "\"fallbackCause\":null,\"findings\":[],\"rationale\":\"Released.\"")

        XCTAssertNotNil(exchange.review)
        XCTAssertNil(exchange.review?.reviewedPolicy)
    }
}

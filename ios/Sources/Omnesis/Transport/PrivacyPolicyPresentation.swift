// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// The policy catalogue as Settings lists it, and the policy a review record
// names. Free of SwiftUI, like the rest of the Privacy vocabulary, so both are
// unit testable in the sim-less logic lane.

// MARK: - The policy a review names

/// The policy a review was judged against, when the record names one. The
/// id is the identity; the name is what the family was called at review time
/// and is absent on a record whose writer did not keep it.
struct PrivacyReviewedPolicy: Equatable, Sendable {
    let familyId: String
    let name: String?
}

func privacyReviewedPolicy(familyId: String?, name: String?) -> PrivacyReviewedPolicy? {
    let trimmedId = familyId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmedId.isEmpty else { return nil }
    return PrivacyReviewedPolicy(familyId: trimmedId, name: privacyPolicyName(name))
}

/// The row that opens a reviewed policy: named when the record kept the name,
/// otherwise an invitation that promises no name it cannot show.
func privacyReviewedUnderLabel(_ policy: PrivacyReviewedPolicy) -> String {
    if let name = policy.name {
        return "Reviewed under \(name)"
    }
    return "See the policy it was reviewed under"
}

/// A family's name as a screen title or row heading: "Policy" when there is
/// none, so a nameless family still gets a heading a reader can act on.
func privacyPolicyDisplayName(_ name: String?) -> String {
    privacyPolicyName(name) ?? "Policy"
}

private func privacyPolicyName(_ name: String?) -> String? {
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
}

extension PrivacyReviewRecord {
    var reviewedPolicy: PrivacyReviewedPolicy? {
        privacyReviewedPolicy(familyId: policyFamilyId, name: policyFamilyName)
    }
}

extension PrivacyExchangeReview {
    var reviewedPolicy: PrivacyReviewedPolicy? {
        privacyReviewedPolicy(familyId: policyFamilyId, name: policyFamilyName)
    }
}

// MARK: - Which family is the default

/// What the access overview said about the default family on one refresh.
enum PrivacyDefaultPolicyAdvice: Equatable, Sendable {
    /// The overview answered; `nil` means it names no default.
    case reported(String?)
    /// The overview could not be asked, or the gateway has no access client.
    case unavailable
}

/// The family the list marks as the default, carried across refreshes. An
/// answer from the overview replaces the marker, including with nothing when
/// the overview names no family; a refresh that could not ask keeps the last
/// known marker, and a list that has never been told marks nothing rather
/// than guess.
func privacyDefaultPolicyMarker(previous: String?, advice: PrivacyDefaultPolicyAdvice) -> String? {
    switch advice {
    case .reported(let familyId): familyId
    case .unavailable: previous
    }
}

// MARK: - The catalogue as listed

/// The families Settings lists: retired ones dropped, the default first, the
/// rest by name compared case-insensitively in the root locale — the same
/// order on every device, whatever its language — with the id as the tiebreak
/// so two families with one name keep a stable order. The default leads
/// because it is the one a grant that names no policy is judged against, so
/// it is the one most readers came to check; with no known default nothing
/// leads.
func privacyPolicyFamiliesForListing(
    _ families: [PrivacyPolicyFamilySummary],
    defaultFamilyId: String?
)
    -> [PrivacyPolicyFamilySummary] {
    families
        .filter { $0.archivedAt == nil }
        .sorted { lhs, rhs in
            if let defaultFamilyId, (lhs.id == defaultFamilyId) != (rhs.id == defaultFamilyId) {
                return lhs.id == defaultFamilyId
            }
            switch lhs.name.compare(rhs.name, options: [.caseInsensitive], locale: nil) {
            case .orderedAscending: return true
            case .orderedDescending: return false
            case .orderedSame: return lhs.id < rhs.id
            }
        }
}

/// How many grants a family currently governs, as a phrase. Zero is worded as
/// "yet" because a family with no grant is usually one the owner just wrote.
func privacyPolicyGovernanceLine(grantCount: Int) -> String {
    switch grantCount {
    case 0: "governs no grant yet"
    case 1: "governs 1 grant"
    default: "governs \(grantCount) grants"
    }
}

/// A revision as the list shows it: enough of the digest to tell two apart,
/// not the whole hash.
func privacyPolicyShortRevision(_ revision: String) -> String {
    String(revision.prefix(12))
}

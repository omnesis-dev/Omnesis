// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
enum AccessAuthorizationPreviewMode {
    case connectionNewLevel
    case connectionExistingLevel
    case connectionReplaceSuggested
    case connectionReplaceOtherPicked
    case connectionReplacePicker
    case connectionLongNames
    case connectionLongNamesReplace
    case existingLevelReview
    case replaceReview
    case longNamesReview
    case existingLevelAloneReview
    case levelNameClash
    case levelNameTaken
    case oldGateway
    case permissions
    case data
    case sharedSources
    case allSources
    case unreviewed
    case review
    case requestedConnection
    case requestedPermissions
    case requestedSources
    case requestedReview
    /// The canonical request approved onto the existing "Research assistant" level, at the review.
    case requestedExistingReview
    case notesOnly
    case conflict
    case success
    case denied
}

/// The sheet's state for one preview mode, opened the way a lookup opens it
/// and then moved to the step and edits the mode shows.
@available(iOS 17.0, *)
struct AccessAuthorizationPreviewState {
    var choice: AccessConnectionChoice?
    var level: AccessDraftDecisions
    var step: AccessFlowStep
    var actionError: Error?
    var actionChoiceRefresh = AccessAuthorizationChoiceRefresh.notAttempted
    var outcome: AccessAuthorizationOutcome?

    init(request: AccessAuthorizationRequest, overview: AccessOverview, mode: AccessAuthorizationPreviewMode) {
        let opening = AccessAuthorizationOpening(
            request: request,
            overview: overview,
            connection: Self.proposal(for: mode),
            reconnect: nil,
            nowMillis: Int64(Date().timeIntervalSince1970 * 1000)
        )
        choice = opening.choice
        level = opening.level
        step = opening.step
        if !applyConnectionMode(mode) { applyWizardMode(mode) }
    }

    private static func proposal(for mode: AccessAuthorizationPreviewMode) -> AccessConnectionProposal? {
        switch mode {
        case .oldGateway: nil
        case .requestedConnection, .requestedPermissions, .requestedSources, .requestedReview, .requestedExistingReview:
            PreviewMocks.accessCanonicalProposal
        case .connectionExistingLevel, .existingLevelReview: PreviewMocks.accessProposalLevelMatch
        case .connectionReplaceSuggested, .connectionReplaceOtherPicked, .replaceReview:
            PreviewMocks.accessProposalDeviceMatch
        case .connectionLongNames, .connectionLongNamesReplace, .longNamesReview: PreviewMocks.accessProposalLongNames
        default: PreviewMocks.accessProposalNoMatch
        }
    }

    /// The modes about the Connection step and what it leads to. Returns
    /// false for a mode this does not cover.
    private mutating func applyConnectionMode(_ mode: AccessAuthorizationPreviewMode) -> Bool {
        switch mode {
        case .connectionNewLevel, .connectionExistingLevel, .connectionReplaceSuggested, .connectionLongNames, .oldGateway,
             .requestedConnection:
            break
        case .connectionReplacePicker, .connectionLongNamesReplace:
            choice?.replacing = true
        case .connectionReplaceOtherPicked:
            // A connection other than the one the gateway recognised, so the
            // suggestion stays on its own row.
            choice?.connectionId = "principal-northstar"
        case .existingLevelReview, .replaceReview, .longNamesReview:
            step = .review
        case .requestedExistingReview:
            choice?.levelId = PreviewMocks.accessCanonicalLevelId
            step = .review
        case .existingLevelAloneReview:
            // A level no connection uses yet, so nobody else shares it.
            choice?.levelId = PreviewMocks.accessNotesLevel.id
            step = .review
        case .levelNameClash:
            // Typed in another case than the listed level's name.
            choice?.levelName = PreviewMocks.accessResearchLevel.name.lowercased()
        case .levelNameTaken:
            // A name no listed level has, refused by a gateway where a level
            // with it was created after the overview was read.
            choice?.levelName = "Design reviewers"
            actionError = GatewayClient.Error.serverError(status: 409, body: #"{"error":"level-name-taken"}"#)
        default:
            return false
        }
        return true
    }

    /// The modes about the permissions wizard and the decision's outcome.
    private mutating func applyWizardMode(_ mode: AccessAuthorizationPreviewMode) {
        switch mode {
        case .data:
            step = .answerData
        case .sharedSources:
            // Answer and Direct both on, so the wizard asks whether Direct
            // reads what Answer reads.
            level.setHeld("direct", true)
            allowEverySource()
            step = .directChoice
        case .allSources:
            level.draft.setBoundary(.init(mode: .all, sourceIds: []), capability: "answer", authoringEnabled: true)
            step = .answerData
        case .unreviewed:
            level.setRelease(.unreviewed)
            step = .release
        case .review:
            allowEverySource()
            step = .review
        case .requestedPermissions, .requestedSources, .requestedReview:
            // What the agent asked for: Answer and Direct, over every connected source.
            level.setHeld("direct", true)
            allowEverySource()
            step = mode == .requestedPermissions ? .permissions : mode == .requestedSources ? .answerData : .review
        case .notesOnly:
            level.setHeld("answer", false)
            level.setHeld("notes", true)
            step = .review
        case .conflict:
            actionError = GatewayClient.Error.serverError(status: 409, body: #"{"error":"invalid-selection"}"#)
            actionChoiceRefresh = .refreshed
        case .success:
            outcome = .approved
        case .denied:
            outcome = .denied
        default:
            step = .permissions
        }
    }

    /// Ticks every connected account for Answer, as the list's "Allow all" does.
    private mutating func allowEverySource() {
        if let all = level.selection(settingAllowed: true, for: level.overview.sources, capability: "answer") {
            level.setSourceSelection(all, capability: "answer")
        }
    }
}
#endif

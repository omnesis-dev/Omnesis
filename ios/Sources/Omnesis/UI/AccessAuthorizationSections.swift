// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The final review of what approval connects: the connection and the access
/// level it uses. A new level is followed by the decisions this approval made
/// for it, each as the level editor lists it, and its Permissions row carries
/// the capability pills; an existing level carries them on its own row and is
/// not taken apart.
@available(iOS 17.0, *)
struct AccessAuthorizationReviewSection: View {
    let connection: AccessConnectionReview
    /// The decisions this approval makes for a new level.
    let decisions: AccessDraftDecisions
    /// What the access level allows, as the pills under an existing level's name.
    let holdings: AccessCapabilityHoldings
    /// Opens the screen that changes a decision. The connection's own rows
    /// name the step that asks for names.
    let change: (AccessFlowStep) -> Void

    private var lines: [AccessDecisionLine] {
        var lines = [AccessDecisionLine(title: "Connection", value: connection.connectionName, step: .name)]
        if let accessLevel = connection.accessLevel {
            let pills = connection.decidesPermissions ? nil : holdings
            lines.append(.init(title: "Access level", value: accessLevel, step: .name, holdings: pills))
        }
        if let replaces = connection.replaces { lines.append(.init(title: "Replaces", value: replaces, step: .name)) }
        return connection.decidesPermissions ? lines + decisions.decisionLines : lines
    }

    var body: some View {
        AccessSectionHeading(AccessConnectionCopy.reviewAccess, first: true)
        AccessDecisionRows(lines: lines, change: change)
        if let footnote = connection.levelFootnote {
            Text(footnote).accessText(.rowSecondary, color: AccessUI.secondary).padding(.top, 16)
        }
        Text("Access can be edited or revoked later from Settings → Access in the Omnesis Portal.")
            .accessText(.rowSecondary, color: AccessUI.secondary)
            .padding(.top, 16)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Review rows") {
    let overview = PreviewMocks.accessCanonicalOverview
    AccessScroll {
        AccessAuthorizationReviewSection(
            connection: .init(
                connectionName: "Northstar Assistant",
                accessLevel: "Research assistant",
                replaces: nil,
                levelFootnote: nil,
                decidesPermissions: false
            ),
            decisions: AccessDraftDecisions(
                draft: AccessLevelDraft(level: overview.levels[0], overview: overview),
                overview: overview,
                original: AccessLevelDraft(level: overview.levels[0], overview: overview)
            ),
            holdings: accessCapabilityHoldings(rules: overview.levels[0].rules),
            change: { _ in }
        )
    }
    .background(Theme.bgPrimary)
}
#endif
#endif

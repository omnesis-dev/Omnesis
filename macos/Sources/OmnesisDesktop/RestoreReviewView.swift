// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopRestoreReviewView: View {
    @Environment(DesktopStore.self) private var store
    let review: DesktopRestoreReview
    var body: some View {
        DisclosureGroup("Choices saved before restoring") {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
                Text(
                    "These are reference choices. Restoring does not turn them back on. Choose your models and how long information is kept in Settings."
                )
                .foregroundStyle(DesktopTheme.secondary)
                Text("Models used before restoring").font(DesktopDesignTokens.Typography.body.weight(.medium))
                ForEach(review.modelAssignments.keys.sorted(), id: \.self) { role in
                    LabeledContent(
                        role.replacingOccurrences(of: "-", with: " ").capitalized,
                        value: review.modelAssignments[role].flatMap { $0 } ?? "Disabled"
                    )
                }
                if review.modelAssignments.isEmpty { Text("No previous model choices were saved.").foregroundStyle(DesktopTheme.secondary) }
                Text("Previous automatic deletion").font(DesktopDesignTokens.Typography.body.weight(.medium))
                ForEach(Array(review.storageRetention.prefix(50).enumerated()), id: \.offset) { _, rule in
                    LabeledContent(sourceName(rule.sourceId), value: "After \(rule.maxAgeDays.formatted()) days")
                }
                if review.storageRetention.count > 50 {
                    Text(
                        "Showing the first 50 of \(review.storageRetention.count) saved source rules. All automatic source deletion remains paused."
                    )
                    .foregroundStyle(DesktopTheme.secondary)
                } else if review.storageRetention.isEmpty {
                    Text("No automatic source deletion rules were saved.").foregroundStyle(DesktopTheme.secondary)
                }
                LabeledContent("Activity history", value: review.activityRetention.maxAge ?? "No automatic age limit saved")
            }.padding(.top, DesktopDesignTokens.Space.small)
        }
    }

    private func sourceName(_ id: String) -> String {
        guard let source = store.sources.first(where: { $0.id == id }) else { return "Saved source (\(id))" }
        let name = store.descriptors.first(where: { $0.id == source.type })?.name ?? source.type
        return "\(name) · \(source.accountId)"
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopRestoreReviewView: View {
    @Environment(DesktopStore.self) private var store
    let review: DesktopRestoreReview
    var body: some View {
        DisclosureGroup("Choices saved before restoring") {
            VStack(alignment: .leading, spacing: 12) {
                Text(
                    "These are reference choices. Restoring does not turn them back on. Choose models and deletion policies separately in Settings."
                )
                .foregroundStyle(.secondary)
                Text("Previous model assignments").font(.headline)
                ForEach(review.modelAssignments.keys.sorted(), id: \.self) { role in
                    LabeledContent(
                        role.replacingOccurrences(of: "-", with: " ").capitalized,
                        value: review.modelAssignments[role].flatMap { $0 } ?? "Disabled"
                    )
                }
                if review.modelAssignments.isEmpty { Text("No model assignments were saved.").foregroundStyle(.secondary) }
                Text("Previous automatic deletion").font(.headline)
                ForEach(Array(review.storageRetention.prefix(50).enumerated()), id: \.offset) { _, rule in
                    LabeledContent(sourceName(rule.sourceId), value: "After \(rule.maxAgeDays.formatted()) days")
                }
                if review.storageRetention.count > 50 {
                    Text(
                        "Showing the first 50 of \(review.storageRetention.count) saved source rules. All automatic source deletion remains paused."
                    )
                    .foregroundStyle(.secondary)
                } else if review.storageRetention.isEmpty {
                    Text("No automatic source deletion rules were saved.").foregroundStyle(.secondary)
                }
                LabeledContent("Activity history", value: review.activityRetention.maxAge ?? "No automatic age limit saved")
            }.padding(.top, 8)
        }
    }

    private func sourceName(_ id: String) -> String {
        guard let source = store.sources.first(where: { $0.id == id }) else { return "Saved source (\(id))" }
        let name = store.descriptors.first(where: { $0.id == source.type })?.name ?? source.type
        return "\(name) · \(source.accountId)"
    }
}

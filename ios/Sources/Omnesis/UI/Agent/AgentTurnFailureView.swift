// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The same terminal failure surface in text and voice conversations.
struct AgentTurnFailureView: View {
    let failure: AgentTurnFailure

    var body: some View {
        // Two registers, deliberately: the sentence says what went
        // wrong in the reader's language, the line beneath carries
        // the code and the provider's own disposition for whoever
        // has to go and fix the model assignment.
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.danger)
                Text(failure.message)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let detail = failure.detailLine {
                Text(detail)
                    .font(Theme.monospace(size: 10))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Theme.danger.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What the picker shows in place of a field's items while the field cannot be used: the gateway's sentence, a
/// button to resync the account when that is the remedy, progress while it resyncs, and a spinner while the
/// account's list is on its way. The editor asks the gateway again by itself, so nothing here needs refreshing.
struct SourceFilterFieldStateView: View {
    let state: FilterFieldState
    /// The source's name, as the resync button says it: "Gmail".
    let sourceName: String
    var resyncing = false
    var problem: String?
    let resync: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch state {
            case .listPending(let text):
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    AccessCountingSpinner()
                    sentence(text)
                }
                .accessibilityElement(children: .combine)
            case .resyncing(let processed, let total, let text):
                sentence(text)
                ProgressView(value: Double(min(processed, max(total, 1))), total: Double(max(total, 1)))
                    .tint(Theme.accent)
                    .accessibilityLabel(text)
            case .needsResync(_, let text):
                sentence(text)
                Button(action: resync) {
                    HStack(spacing: 10) {
                        if resyncing { AccessCountingSpinner() }
                        Text(sourceFilterResyncTitle(sourceName))
                    }
                }
                .buttonStyle(AccessSecondaryButtonStyle())
                .disabled(resyncing)
                AccessProblemText(text: problem, top: 0)
            default:
                state.text.map(sentence)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    private func sentence(_ text: String) -> some View {
        Text(text).accessText(.subtitle).fixedSize(horizontal: false, vertical: true)
    }
}

/// The button that resyncs an account in place so its records carry what a filter needs: "Resync Gmail".
func sourceFilterResyncTitle(_ sourceName: String) -> String {
    "Resync " + sourceName
}

#if DEBUG
#Preview("Needs a resync") {
    SourceFilterFieldStateView(
        state: .needsResync(cost: nil, text: "Label filters need Gmail to be resynced. Your mail stays searchable meanwhile."),
        sourceName: "Gmail"
    ) {}
        .padding(20)
        .background(Theme.bgPrimary)
}

#Preview("Resyncing") {
    SourceFilterFieldStateView(
        state: .resyncing(processed: 212, total: 900, text: "Resyncing Google Drive: 212 of about 900."),
        sourceName: "Google Drive"
    ) {}
        .padding(20)
        .background(Theme.bgPrimary)
}

#Preview("List on its way") {
    SourceFilterFieldStateView(
        state: .listPending(text: "Waiting for Gmail to send its list of labels."),
        sourceName: "Gmail"
    ) {}
        .padding(20)
        .background(Theme.bgPrimary)
}
#endif
#endif

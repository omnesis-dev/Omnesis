// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What the picker shows in place of a field's items while the field cannot be used, on one tinted block: the
/// gateway's sentence, a button to resync the account when that is the remedy, progress while it resyncs, and a
/// spinner during its first read or while the account's list is on its way. The editor asks the gateway again by
/// itself, so nothing here needs refreshing.
struct SourceFilterFieldStateView: View {
    let state: FilterFieldState
    /// The source's name, as the resync button says it: "Gmail".
    let sourceName: String
    /// The owner asked for the resync and the gateway has not reported it running yet.
    var starting = false
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
            case .resyncing(let processed, .some(let total), let text):
                sentence(text)
                ProgressView(value: Double(min(processed, max(total, 1))), total: Double(max(total, 1)))
                    .tint(Theme.accent)
                    .accessibilityLabel(text)
            case .resyncing(_, .none, let text):
                // A first read has no total to measure against: its count is in the sentence.
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    AccessCountingSpinner()
                    sentence(text)
                }
                .accessibilityElement(children: .combine)
            case .needsResync where starting:
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    AccessCountingSpinner()
                    sentence(sourceFilterResyncStartingText(sourceName))
                }
                .accessibilityElement(children: .combine)
            case .needsResync(_, let text):
                sentence(text)
                Button(sourceFilterResyncTitle(sourceName), action: resync).buttonStyle(AccessSecondaryButtonStyle())
                AccessProblemText(text: problem, top: 0)
            default:
                state.text.map(sentence)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(AccessUI.cardPadding)
        .background(AccessUI.surface, in: .rect(cornerRadius: AccessUI.cardRadius))
    }

    private func sentence(_ text: String) -> some View {
        Text(text).accessText(.subtitle).fixedSize(horizontal: false, vertical: true)
    }
}

/// The gateway's sentences for records a filter keeps hidden whatever it says — too old to carry what it needs, or
/// whose detail is unknown. The filter editor's result and a review's Before and After lines both show them under the
/// counts; nothing is drawn when there are none.
struct AccessUndecidedLines: View {
    let lines: [String]
    var top: CGFloat = 0
    var leading: CGFloat = 0

    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(lines, id: \.self) { Text($0).accessText(.rowSecondary, color: AccessUI.secondary) }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, top)
            .padding(.leading, leading)
        }
    }
}

/// The button that resyncs an account in place so its records carry what a filter needs: "Resync Gmail".
func sourceFilterResyncTitle(_ sourceName: String) -> String {
    "Resync " + sourceName
}

/// What shows once the resync is asked for, until the gateway reports it running: "Resyncing Gmail…".
func sourceFilterResyncStartingText(_ sourceName: String) -> String {
    "Resyncing \(sourceName)…"
}

/// A spinner and "Loading…", or what is being waited for, while the account's fields, a page of its items or
/// another page's answer are on their way.
struct SourceFilterLoadingLine: View {
    var text = "Loading…"

    var body: some View {
        HStack(spacing: 10) {
            AccessCountingSpinner()
            Text(text).accessText(.rowSecondary, color: AccessUI.secondary)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// Why something could not be loaded, and "Try again".
struct SourceFilterRetryLine: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(message).accessText(.rowSecondary, color: AccessUI.secondary).fixedSize(horizontal: false, vertical: true)
            Button(action: retry) { Text("Try again").accessText(.rowTitle, color: Theme.accent).frame(minHeight: 44) }
                .buttonStyle(.plain)
        }
    }
}

#if DEBUG
#Preview("Needs a resync") {
    SourceFilterFieldStateView(
        state: .needsResync(cost: nil, text: "Label filters need Gmail to be resynced. Search keeps working meanwhile."),
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

#Preview("First read") {
    SourceFilterFieldStateView(
        state: .resyncing(processed: 602, total: nil, text: "Reading Gmail for the first time: 602 emails so far."),
        sourceName: "Gmail"
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

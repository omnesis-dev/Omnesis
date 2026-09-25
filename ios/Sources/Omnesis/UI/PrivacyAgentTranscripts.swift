// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// MARK: - Agent transcripts

/// The stored local-generation attempts behind an exchange: one collapsible
/// section per attempt, the first open, each rendering its tool calls through
/// the same shared card the Direct transcript uses. Mirrors the portal's
/// `PrivacyAgentTranscripts`: text/thinking parts are shown elsewhere (the
/// draft card above), and citation calls with results render nothing. Old
/// gateways omit traces, and then this renders nothing at all.
@available(iOS 17.0, *)
struct PrivacyAgentTranscriptsView: View {
    let traces: [PrivacyAgentTrace]
    let omittedAttempts: Int

    var body: some View {
        if !traces.isEmpty || omittedAttempts > 0 {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text(traces.count == 1 ? "Agent transcript" : "Agent transcripts")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text("Local generation activity. Only the final draft, when one exists, enters the privacy check.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if omittedAttempts > 0 {
                    Text(agentTraceOmittedAttemptsNote(omittedAttempts))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(Array(traces.enumerated()), id: \.offset) { index, trace in
                    PrivacyAgentTranscriptView(trace: trace, open: index == 0)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@available(iOS 17.0, *)
private struct PrivacyAgentTranscriptView: View {
    let trace: PrivacyAgentTrace
    let open: Bool
    @State private var isOpen: Bool

    init(trace: PrivacyAgentTrace, open: Bool) {
        self.trace = trace
        self.open = open
        self._isOpen = State(initialValue: open)
    }

    var body: some View {
        let calls = agentTraceToolCalls(trace)
        DisclosureGroup(isExpanded: $isOpen) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if calls.isEmpty {
                    Text("No tool calls were recorded.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                } else {
                    ForEach(Array(calls.enumerated()), id: \.offset) { _, call in
                        // Batch calls project one card per child, as in the
                        // Direct transcript and the portal.
                        ForEach(Array(directTranscriptCards(tool: call.tool, record: call.record).enumerated()), id: \.offset) { _, card in
                            DirectToolCardView(
                                tool: card.tool,
                                content: card.content,
                                rawPayload: call.rawPart
                            )
                        }
                    }
                }
                if let note = agentTraceTruncatedNote(trace) {
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, Theme.Spacing.xs)
        } label: {
            Text(agentTraceAttemptTitle(trace))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
        }
    }
}

#endif

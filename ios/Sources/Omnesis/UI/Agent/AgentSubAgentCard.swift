// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import SwiftUI

/// One stable, live researcher row. The detailed document working set belongs
/// to `ResearchWorkspaceView`; this transcript location only answers who is
/// working, what sources they have reached, and their reported usage.
@available(iOS 17.0, *)
struct AgentSubAgentCard: View {
    @Environment(AppStore.self) private var store
    @ScaledMetric(relativeTo: .caption2) private var sourceIconSize: CGFloat = 16
    @ScaledMetric(relativeTo: .caption2) private var badgeFontSize: CGFloat = 8
    let card: AgentSubagentCard

    private var running: Bool {
        card.status == nil
    }

    private var renderedSourceIconSize: CGFloat {
        min(sourceIconSize, 24)
    }

    private var renderedBadgeFontSize: CGFloat {
        min(badgeFontSize, 12)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Theme.accent)
                    .fixedSize()
                    .accessibilityHidden(true)
                Text(card.title.isEmpty ? card.specialist : card.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 4)
                if running {
                    AgentSubagentDots()
                        .accessibilityHidden(true)
                }
                Text(statusLabel)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(statusColor)
                    .fixedSize()
                Text("\(formatTokenCount(card.tokens)) tok")
                    .font(Theme.monospace(size: 10))
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize()
            }

            if let failureDetail {
                Text(failureDetail)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Theme.danger)
                    .lineLimit(2)
            }

            if let failureCause {
                Text(failureCause)
                    .font(Theme.monospace(size: 9))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }

            if !sourceCounts.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(sourceCounts, id: \.sourceId) { source in
                        ZStack(alignment: .topTrailing) {
                            SourceIconView(sourceId: source.sourceId, store: store, size: renderedSourceIconSize)
                            Text(formatSourceCount(source.count))
                                .font(.system(size: renderedBadgeFontSize, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .padding(.horizontal, 3)
                                .padding(.vertical, 1)
                                .background(.black)
                                .clipShape(Capsule())
                                .offset(x: 6, y: -5)
                        }
                        .padding(.top, 5)
                        .padding(.trailing, 6)
                        .fixedSize()
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(source.count) documents from \(sourceLabel(source.sourceId))")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .background(Theme.bgTertiary.opacity(0.5))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                .stroke(running ? Theme.accent.opacity(0.5) : Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
        .accessibilityElement(children: .contain)
    }

    private var sourceCounts: [(sourceId: String, count: Int)] {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for doc in card.docs where !doc.sourceId.isEmpty {
            if counts[doc.sourceId] == nil { order.append(doc.sourceId) }
            counts[doc.sourceId, default: 0] += 1
        }
        return order.compactMap { id in counts[id].map { (id, $0) } }
    }

    private var statusLabel: String {
        switch card.status {
        case "complete": "Done"
        case "failed": card.hasPartialResult ? "Partial result" : "Couldn't finish"
        case "budget_exhausted": "Stopped"
        default: "Searching"
        }
    }

    private var statusColor: Color {
        switch card.status {
        case "complete": Theme.success
        case "failed", "budget_exhausted": Theme.danger
        default: Theme.textMuted
        }
    }

    private var failureDetail: String? {
        guard !running, card.status != "complete", !card.hasPartialResult,
              let summary = card.summary, !summary.isEmpty else {
            return nil
        }
        return summary
    }

    /// The machine-readable half of a failed card: the terminal code and, when
    /// the provider reported one, its disposition. Shown on any terminal state
    /// other than a clean completion — including a partial result, where the
    /// summary explains what survived but not what killed the worker.
    private var failureCause: String? {
        guard !running, card.status != "complete" else { return nil }
        return card.failureDetailLine
    }

    private func formatTokenCount(_ n: Int) -> String {
        guard n >= 1000 else { return String(n) }
        return String(format: "%.1fk", Double(n) / 1000)
    }

    private func formatSourceCount(_ count: Int) -> String {
        count > 99 ? "99+" : String(count)
    }

    private func sourceLabel(_ sourceId: String) -> String {
        store.sourceLabel(forSourceId: sourceId) ?? sourceTypeFromId(sourceId)
    }
}

@available(iOS 17.0, *)
private struct AgentSubagentDots: View {
    @State private var animating = false

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0 ..< 3, id: \.self) { index in
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 3, height: 3)
                    .opacity(animating ? 1 : 0.25)
                    .offset(y: animating ? -2 : 0)
                    .animation(
                        .easeInOut(duration: 0.65)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.18),
                        value: animating
                    )
            }
        }
        .onAppear { animating = true }
        .accessibilityLabel("Working")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("AgentSubAgentCard — terminal states") {
    let store = AppStore.preview(agentPreview: .init())
    return ScrollView {
        VStack(spacing: 12) {
            AgentSubAgentCard(card: PreviewMocks.agentSubagentCardRunning)
            AgentSubAgentCard(card: PreviewMocks.agentSubagentCardComplete)
            AgentSubAgentCard(card: PreviewMocks.agentSubagentCardPartial)
            AgentSubAgentCard(card: PreviewMocks.agentSubagentCardProviderFailure)
        }
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentSubAgentCard — provider failure (light)") {
    let store = AppStore.preview(agentPreview: .init())
    return ScrollView {
        AgentSubAgentCard(card: PreviewMocks.agentSubagentCardProviderFailure)
            .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.light)
}
#endif
#endif

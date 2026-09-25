// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import SwiftUI

// ─── Research working-set surface (#748) ─────────────────────────────────
//
// The bespoke multi-panel research working-set surface — the iOS twin of the
// portal `ResearchWorkspace` (`portal/js/components/agent/parts.js`). During a
// Deep Research run the agent screen shows "N researchers side by side": one
// panel per reader sub-agent, each accumulating its source-tinted documents
// LIVE as the run proceeds (reduced from the real `agent.subagent.*` stream by
// `AgentCoordinator.reduceChildEvent` → `researchPanels`).
//
// Rendered only while `AgentCoordinator.isResearchWorkspaceActive` holds (a
// live run with ≥1 researcher); the host unmounts it when the run ends, so the
// surface "collapses into the report" (the written-back assistant turn).
//
// This is deliberately NOT the citation drawer re-skinned: it is a dedicated
// horizontal workspace with its own visual language — a framed accent band with
// a live pulse header, a horizontally-scrolling rail of researcher panels, each
// with a status rail and a flowing grid of source-tinted document chips.
//
// Source encapsulation: every document is tinted by its source registry entry
// (`SourceIconView(sourceId:)` + the registry accent) keyed off the ref's
// `sourceId` — NEVER by branching on a source name. A source the registry
// doesn't know falls back to a neutral accent + the generic doc glyph, so the
// surface degrades gracefully for any source.

/// The multi-panel research working-set surface. `panels` is
/// `AgentCoordinator.researchPanels` — one descriptor per sub-agent, in spawn
/// order. Renders nothing when empty (the host gates on
/// `isResearchWorkspaceActive`, but the guard keeps the view self-contained).
@available(iOS 17.0, *)
struct ResearchWorkspaceView: View {
    let panels: [AgentResearchPanel]

    var body: some View {
        if panels.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                header
                rail
            }
            .frame(minHeight: 72, alignment: .top)
            .padding(.vertical, 10)
            .background(
                // A faint accent wash + top hairline marks the band as a
                // distinct workspace region, not a transcript bubble.
                Theme.accent.opacity(0.06)
            )
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Theme.accent.opacity(0.35))
                    .frame(height: 1)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Deep Research: \(headerSub)")
        }
    }

    // MARK: - Header band

    private var header: some View {
        HStack(spacing: 7) {
            LivePulse()
            Text("Deep Research")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Theme.accent)
            Text(headerSub)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.lg)
    }

    private var headerSub: String {
        let complete = panels.filter { $0.status == "complete" }.count
        return "\(complete) of \(panels.count) complete"
    }

    // MARK: - Horizontal researcher rail

    private var rail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .center, spacing: 8) {
                ForEach(panels) { panel in
                    Text(panel.title.isEmpty ? panel.specialist : panel.title)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(panel.status == "complete" ? Theme.success : Theme.textSecondary)
                        .lineLimit(1)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(Theme.bgSecondary)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
        }
        .frame(height: 28)
        .fixedSize(horizontal: false, vertical: true)
        .menuRevealExcluded()
    }
}

/// One researcher's panel: specialist + task header, a status rail, a live
/// meta line, and a flowing column of source-tinted document chips.
@available(iOS 17.0, *)
private struct ResearchPanelView: View {
    let panel: AgentResearchPanel
    let store: AppStore

    private var running: Bool {
        panel.status == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            head
            meta
            docs
            if let summary = panel.summary, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(width: 232, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(running ? Theme.accent.opacity(0.5) : Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: "person.fill.viewfinder")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.accent)
                Text(panel.specialist)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .lineLimit(1)
                Spacer(minLength: 6)
                statusPill
            }
            Text(panel.task)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var statusPill: some View {
        HStack(spacing: 4) {
            if running {
                ProgressView().scaleEffect(0.5).tint(Theme.accent)
            }
            Text(statusLabel)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(statusColor)
        }
        .fixedSize()
    }

    private var statusLabel: String {
        switch panel.status {
        case nil: "searching…"
        case "complete": "done"
        case "failed": "failed"
        case "budget_exhausted": "budget"
        case .some(let s): s
        }
    }

    private var statusColor: Color {
        switch panel.status {
        case "complete": Theme.success
        case "failed", "budget_exhausted": Theme.danger
        default: Theme.textMuted
        }
    }

    private var meta: some View {
        let docNoun = panel.docs.count == 1 ? "document" : "documents"
        let stepNoun = panel.stepCount == 1 ? "step" : "steps"
        var line = "\(panel.docs.count) \(docNoun) · \(panel.stepCount) \(stepNoun)"
        if panel.tokens > 0 { line += " · \(formatTokenCount(panel.tokens)) tok" }
        return Text(line)
            .font(Theme.monospace(size: 9))
            .foregroundStyle(Theme.textMuted)
    }

    @ViewBuilder
    private var docs: some View {
        if panel.docs.isEmpty {
            Text(running ? "Gathering sources…" : "No documents.")
                .font(.system(size: 11))
                .italic()
                .foregroundStyle(Theme.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
        } else {
            // Cap the per-panel doc list and let it scroll WITHIN the panel, so
            // a researcher that reaches dozens of docs can't grow the panel
            // taller than the screen and bury the conversation (#890). The outer
            // rail scrolls horizontally; this inner scroll is the orthogonal
            // vertical axis.
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(panel.docs) { doc in
                        ResearchDocChipView(doc: doc, store: store)
                    }
                }
            }
            .frame(maxHeight: 150)
        }
    }

    /// Compact token count: 1234 → "1.2k", below 1000 stays exact. Matches
    /// `AgentSubAgentCard.formatTokenCount`.
    private func formatTokenCount(_ n: Int) -> String {
        guard n >= 1000 else { return String(n) }
        return String(format: "%.1fk", Double(n) / 1000)
    }
}

/// One flat document row in a researcher's working set. Tappable — pushes the
/// in-app document page through the shared `DocumentLink`, the same single
/// source-exit the rest of the agent surface uses (iOS deep-links never use
/// `NavigationLink` directly). The source icon + title sit flat on the panel,
/// the icon resolved from the source registry by `sourceId`; an unknown source
/// falls back to the generic doc glyph.
@available(iOS 17.0, *)
private struct ResearchDocChipView: View {
    let doc: AgentResearchDoc
    let store: AppStore

    var body: some View {
        DocumentLink(ref: ref) {
            HStack(spacing: 6) {
                SourceIconView(sourceId: doc.sourceId, store: store, size: 13)
                Text(doc.title ?? "Untitled")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("\(doc.title ?? "Untitled"), \(sourceLabel)")
    }

    /// Build the minimal `AgentDocRef` the shared `DocumentLink` needs. Only
    /// the `documentId` is load-bearing (the link opens by id); the rest is
    /// best-effort metadata.
    private var ref: AgentDocRef {
        AgentDocRef(
            documentId: doc.documentId,
            sourceType: sourceTypeFromId(doc.sourceId),
            sourceId: doc.sourceId,
            title: doc.title
        )
    }

    private var sourceLabel: String {
        let type = sourceTypeFromId(doc.sourceId)
        return store.sourceLabelById[doc.sourceId] ?? store.sourceLabelByType[type] ?? type
    }
}

/// A small pulsing dot signalling a live run. Follows the same
/// `onAppear`-driven `repeatForever` pattern as the agent thinking pulse — the
/// snapshot harness captures whatever frame it lands on rather than hanging.
@available(iOS 17.0, *)
private struct LivePulse: View {
    @State private var on = false

    var body: some View {
        Circle()
            .fill(Theme.accent)
            .frame(width: 7, height: 7)
            .opacity(on ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Research workspace — live (3 researchers)") {
    VStack {
        Spacer()
        ResearchWorkspaceView(panels: PreviewMocks.researchPanelsLive)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Research workspace — live (light)") {
    VStack {
        Spacer()
        ResearchWorkspaceView(panels: PreviewMocks.researchPanelsLive)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("Research workspace — finishing (collapse)") {
    VStack {
        Spacer()
        ResearchWorkspaceView(panels: PreviewMocks.researchPanelsFinishing)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}
#endif
#endif

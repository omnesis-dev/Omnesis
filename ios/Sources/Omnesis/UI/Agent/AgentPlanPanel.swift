// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Pinned TODO panel rendered above the composer while the agent is
/// working through a multi-step plan. Each `AgentPlanItem` lands as
/// one row; rows slide in from below, flip to a "done" style with a
/// strikethrough when their status changes, then auto-remove ~1s
/// later so the panel naturally collapses once the agent's plan is
/// fully executed.
///
/// Visual language matches `AgentEphemeralCards.swift`: a 2pt accent
/// rail down the left edge, 8pt gap to the content, 11pt label
/// font, no border, no background fill. Reads as inline progress
/// chrome, not as a bordered card.
///
/// Order is preserved end-to-end. The server hands the client a full
/// plan snapshot on every `plan.updated`; this view diffs the
/// incoming list against a local mirror so a row that becomes `done`
/// can stay in place visually for the one-second hold before
/// removing — independent of when the next server update arrives.
@available(iOS 17.0, *)
struct AgentPlanPanel: View {
    let items: [AgentPlanItem]

    /// Local mirror of `items` so we can keep a row on screen for
    /// the "done → 1s hold → slide out" transition even after the
    /// server-side state would have evicted it. Diffed against
    /// `items` on every update.
    @State private var displayed: [AgentPlanItem] = []
    /// One per displayed item — fires the slide-out roughly 1s
    /// after the row flipped to `done`. Stored by id so we don't
    /// schedule duplicates if the same row receives multiple
    /// `done` snapshots.
    @State private var removalTasks: [String: Task<Void, Never>] = [:]

    var body: some View {
        Group {
            if displayed.isEmpty {
                Color.clear.frame(height: 0)
            } else {
                panelBody
            }
        }
        .onAppear { syncDisplayed(with: items) }
        .onChange(of: items) { _, next in
            syncDisplayed(with: next)
        }
        .onDisappear {
            for (_, task) in removalTasks {
                task.cancel()
            }
            removalTasks = [:]
        }
    }

    private var panelBody: some View {
        HStack(alignment: .top, spacing: 8) {
            Rectangle()
                .fill(Theme.accent.opacity(0.5))
                .frame(width: 2)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(displayed) { item in
                    AgentPlanRow(item: item)
                        .frame(height: 22)
                        .transition(.asymmetric(
                            insertion: .move(edge: .bottom).combined(with: .opacity),
                            removal: .move(edge: .top).combined(with: .opacity)
                        ))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
        }
        // Without this the leading rail's `Rectangle` claims any
        // surplus vertical space the layout offers — when this panel
        // sits inside a flexible container (e.g. above the composer
        // in a bottom-anchored overlay), the rail visually stretches
        // all the way up the screen. `fixedSize` hugs the panel to
        // its row stack's intrinsic height so the rail tracks the
        // content.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, 6)
        .animation(.easeOut(duration: 0.25), value: displayed)
    }

    // MARK: - Local-mirror diff

    /// Reconcile `displayed` with the latest server-supplied list.
    /// Drives three independent transitions:
    ///
    ///   - **new id** → inserted at the matching position so the row
    ///     slides in from the bottom of the rail.
    ///   - **status flip** → row's existing slot is mutated in
    ///     place; the row view's own `animation(...)` handles the
    ///     cross-fade to the done style.
    ///   - **flipped to `done`** → schedule a 1s-later slide-out so
    ///     the checkmark lands and reads as a discrete moment before
    ///     the row leaves.
    ///
    /// Items that disappear from the server list without going
    /// through `done` (e.g. the coordinator's grace-period clear
    /// after `agent.message.end`) are removed immediately — the
    /// done-then-remove ladder only applies to items the agent
    /// itself marked complete.
    private func syncDisplayed(with next: [AgentPlanItem]) {
        var nextDisplayed = displayed
        let oldById = Dictionary(uniqueKeysWithValues: displayed.map { ($0.id, $0) })
        let nextById = Dictionary(uniqueKeysWithValues: next.map { ($0.id, $0) })

        // Apply additions and status flips in the order the server
        // sent them, so a row's slot in `nextDisplayed` matches its
        // index in `next` whenever both lists agree about the row.
        for (idx, item) in next.enumerated() {
            if let existing = oldById[item.id] {
                guard existing.status != item.status else { continue }
                if let dispIdx = nextDisplayed.firstIndex(where: { $0.id == item.id }) {
                    nextDisplayed[dispIdx] = item
                }
                if item.status == .done {
                    scheduleRemoval(id: item.id)
                }
            } else {
                let insertAt = min(idx, nextDisplayed.count)
                nextDisplayed.insert(item, at: insertAt)
                if item.status == .done {
                    scheduleRemoval(id: item.id)
                }
            }
        }

        // Drop rows the server forgot about that ARE NOT already in
        // the "done, scheduled for removal" window. The window items
        // stay until their per-row timer fires.
        nextDisplayed.removeAll { row in
            if nextById[row.id] != nil { return false }
            if removalTasks[row.id] != nil { return false }
            return true
        }

        displayed = nextDisplayed
    }

    private func scheduleRemoval(id: String) {
        removalTasks[id]?.cancel()
        let task = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                displayed.removeAll { $0.id == id }
            }
            removalTasks[id] = nil
        }
        removalTasks[id] = task
    }
}

// MARK: - Row

@available(iOS 17.0, *)
private struct AgentPlanRow: View {
    let item: AgentPlanItem

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            statusGlyph
                .frame(width: 14, alignment: .center)
            Text(item.label)
                .font(.system(size: 11))
                .foregroundStyle(labelColor)
                .strikethrough(item.status == .done, color: Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            if item.status == .inProgress {
                ProgressView()
                    .scaleEffect(0.55)
                    .tint(Theme.accent)
                    .frame(width: 14, height: 14)
            }
        }
        .animation(.easeOut(duration: 0.25), value: item.status)
    }

    @ViewBuilder
    private var statusGlyph: some View {
        switch item.status {
        case .pending:
            Image(systemName: "circle")
                .font(.system(size: 11, weight: .regular))
                .foregroundStyle(Theme.textMuted)
        case .inProgress:
            Image(systemName: "circle.fill")
                .font(.system(size: 9, weight: .regular))
                .foregroundStyle(Theme.accent)
        case .done:
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.success)
        }
    }

    private var labelColor: Color {
        switch item.status {
        case .pending: Theme.textMuted
        case .inProgress: Theme.textPrimary
        case .done: Theme.textMuted
        }
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Plan — empty (no panel)") {
    ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        AgentPlanPanel(items: [])
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Plan — one in-progress item") {
    ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        AgentPlanPanel(items: PreviewMocks.agentPlanItemsSingleInProgress)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Plan — mid-progress (1 done, 1 in-progress, 1 pending)") {
    ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        AgentPlanPanel(items: PreviewMocks.agentPlanItemsMixed)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Plan — all done (about to collapse)") {
    ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        AgentPlanPanel(items: PreviewMocks.agentPlanItemsAllDone)
    }
    .preferredColorScheme(.dark)
}
#endif
#endif

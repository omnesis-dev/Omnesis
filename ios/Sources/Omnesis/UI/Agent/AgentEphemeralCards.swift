// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Display verbs for ephemeral actions, with a readable fallback for unknown tools.
enum AgentEphemeralActionLabel {
    static func label(for tool: String) -> String {
        labels[tool] ?? tool
    }

    private static let labels = [
        "open_loop_search": "Search loops",
        "open_loop_fetch": "Open loop",
        "open_loop_create": "Create loop",
        "open_loop_update": "Update loop",
        "open_loop_delete": "Delete loop",
        "open_loop_ledger_append": "Note on loop",
        "brief_list": "List briefs",
        "brief_fetch": "Open brief",
        "brief_create": "Create brief",
        "brief_update": "Update brief",
        "brief_delete": "Withdraw brief",
        "temporal_query": "Check dates",
        "time_index_query": "Check dates",
        "temporal_annotation_add": "Add date note",
        "time_index_add": "Add date note",
        "temporal_annotation_update": "Update date note",
        "time_index_update": "Update date note",
        "temporal_annotation_delete": "Remove date note",
        "time_index_delete": "Remove date note",
        "notes_append": "Append notes",
        "notes_rewrite": "Rewrite notes",
        "conversation_memory_evidence": "Prepare memory",
        "annotation_search": "Search memory",
        "annotate_durable": "Remember document",
        "annotation_revise": "Update document memory",
        "annotation_retract": "Forget document memory",
        "annotation_supersede": "Replace document memory",
        "annotate_person": "Remember person",
        "person_annotation_revise": "Update person memory",
        "person_annotation_retract": "Forget person memory",
        "person_annotation_supersede": "Replace person memory",
        "schedule_agent_run": "Schedule follow-up",
        "list_loops": "List loops",
        "entity_context": "Gather context",
    ]
}

/// SQL cards have two independently arriving inputs: arguments start the
/// query reveal, while the result starts the row reveal and dismissal. Keep
/// both in the task identity so a result that lands after the query phase
/// always restarts the lifecycle task.
struct AgentEphemeralSqlLifecycleKey: Hashable {
    let argsKnown: Bool
    let hasResult: Bool
    let expedited: Bool
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// Ephemeral tool-call cards. Search / Open Document / Run SQL each
// render as a small fixed-height card with one rotating slot — the
// items (result docs, document lines, SQL lines, SQL rows) cycle
// through that one slot at ~300ms per item, sliding bottom-to-top
// like a roller, then the whole card fades out of the transcript.
//
// The card never grows in height as items arrive; visual density
// stays bounded. The underlying `AgentToolCall` payload — args,
// result, durationMs — is unchanged; the cards just present less
// of it for a shorter time. No protocol change.

// MARK: - Pacing

/// Per-item cadence — also the slot's slide animation duration so
/// items flow through continuously without pausing between steps.
/// 350ms is short enough to feel snappy, long enough that each item
/// is readable as it crosses the slot.
private let agentEphemeralRevealIntervalSeconds: Double = 0.35 * AppBuild.ephemeralRecordingPacingMultiplier // PARITY:ephemeral-reveal-ms
private let agentEphemeralRevealIntervalNs = UInt64(agentEphemeralRevealIntervalSeconds * 1_000_000_000)
/// Quiet pause after the last item before the card collapses, so
/// the final item doesn't vanish the moment it lands.
private let agentEphemeralHoldNs: UInt64 = 450_000_000 // PARITY:ephemeral-hold-ms

/// Continuous linear scroll. Matched to the cadence interval so the
/// next step kicks in the instant the previous one finishes — no
/// dead time between items, motion reads as one steady marquee.
private let agentEphemeralScrollAnimation: Animation = .linear(duration: agentEphemeralRevealIntervalSeconds)

/// Minimum time the card stays visible before its fade-out kicks in,
/// even when the coordinator has buffered tail content that wants it
/// gone. A card that pops in and out faster than this would read as a
/// flash rather than a step in the agent's narration. Mirror this on
/// the portal (`EPHEMERAL_MIN_VISIBLE_MS`).
let agentEphemeralMinVisibleSeconds: Double = 0.5 * AppBuild.ephemeralRecordingPacingMultiplier // PARITY:ephemeral-min-visible-ms
private let agentEphemeralFadeSeconds: Double = 0.3 // PARITY:ephemeral-fade-ms
private let agentEphemeralFadeNs = UInt64(agentEphemeralFadeSeconds * 1_000_000_000)

/// Composite re-run key for an ephemeral card's lifecycle task.
/// `task(id:)` cancels the prior run when this changes, so the new
/// branch (e.g. expedite) replaces the natural-flow rotation cleanly.
@available(iOS 17.0, *)
struct AgentEphemeralLifecycleKey: Hashable {
    let ready: Bool
    let expedited: Bool
}

// MARK: - Rolling slot primitive

/// Fixed-height slot that scrolls a vertical stack of items
/// upward at the cadence interval. `currentIndex == nil` parks the
/// stack just below the slot (nothing visible); 0…N-1 brings each
/// item up into view in turn.
@available(iOS 17.0, *)
private struct AgentRollingSlot<Item, ItemView: View>: View {
    let items: [Item]
    let currentIndex: Int?
    let slotHeight: CGFloat
    @ViewBuilder let itemView: (Item) -> ItemView

    var body: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    itemView(item)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(height: slotHeight, alignment: .center)
                }
            }
            .offset(y: offset)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: slotHeight, alignment: .topLeading)
        .clipped()
    }

    /// `currentIndex == nil` → parked one slot below; items are off-
    /// screen. Each step shifts the stack up by `slotHeight` so the
    /// next item rolls into view from the bottom edge.
    private var offset: CGFloat {
        guard let i = currentIndex else { return slotHeight }
        return -CGFloat(i) * slotHeight
    }
}

// MARK: - Leading-rail container

/// Inline activity chrome — a thin accent rail down the left edge,
/// 8pt gap to the content, no border, no bg fill. Reads as "the
/// agent is currently doing something here" without the visual
/// weight of a bordered card.
@available(iOS 17.0, *)
private struct AgentInlineActivity<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Rectangle()
                .fill(Theme.accent.opacity(0.5))
                .frame(width: 2)
            VStack(alignment: .leading, spacing: 4) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
        }
    }
}

/// Tool-name + arg header common to all three cards. `label` is
/// rendered in textSecondary semibold (no accent on the word
/// itself); the small glyph carries the accent.
@available(iOS 17.0, *)
private struct AgentInlineHeader<Trailing: View>: View {
    let glyph: String
    let label: String
    let monospaceArg: String?
    let showSpinner: Bool
    @ViewBuilder let trailing: () -> Trailing

    init(
        glyph: String,
        label: String,
        monospaceArg: String? = nil,
        showSpinner: Bool = false,
        @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }
    ) {
        self.glyph = glyph
        self.label = label
        self.monospaceArg = monospaceArg
        self.showSpinner = showSpinner
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: glyph)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.accent)
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            if let arg = monospaceArg, !arg.isEmpty {
                Text(arg)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
            trailing()
            Spacer(minLength: 0)
            if showSpinner {
                ProgressView().scaleEffect(0.55).tint(Theme.accent)
            }
        }
    }
}

// MARK: - Search

/// Search card. Header is "Search <query>". Below the header, a
/// single-line slot rotates through one result at a time (source
/// icon + title), then the whole card disappears.
@available(iOS 17.0, *)
struct AgentEphemeralSearchCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    /// Slot index visible on first render. `nil` keeps the slot empty
    /// (used for pending / freeze previews). Snapshot tests pass a
    /// concrete value to capture a mid-rotation frame.
    var initialIndex: Int?
    /// Freezes the card on the initial state — used by snapshot
    /// tests so `Read`ing the PNG actually shows something.
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards start showing their first result
        // immediately — without this a frozen card parks the slot off-screen
        // and renders header-only (#890).
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    private var query: String {
        // A batch child card (search_many) carries no structured args — its
        // query rides on `argsSummary` instead (see AgentBatchToolCards, which
        // builds each child with `args: NSNull()`). Fall back to it so the child
        // card shows its query, matching portal (`call.args?.query ||
        // call.argsSummary`) and Android (`?: call.argsSummary`).
        if let q = (call.args.value as? [String: Any])?["query"] as? String, !q.isEmpty {
            return q
        }
        return call.argsSummary
    }

    /// Cap the rotation length. The slot is a glance ("agent is
    /// searching"), not an exhaustive replay — most searches return
    /// ≤8 results anyway, but a very generous limit could otherwise
    /// keep the card on screen for tens of seconds.
    private static let maxResultsToReveal: Int = 12

    private var results: [AgentDocRef] {
        if case .searchResults(_, _, _, let r) = call.result {
            return Array(r.prefix(Self.maxResultsToReveal))
        }
        return []
    }

    private var hasResult: Bool {
        call.result != nil
    }

    /// Composite re-run key: re-evaluate the lifecycle task whenever the
    /// result lands or the coordinator parks tail content on us. SwiftUI
    /// cancels the prior task instance when the key flips, so the new
    /// run sees up-to-date state.
    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = results.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        // Resume rather than restart on re-runs (e.g. the task body re-
        // fires because expedite flipped from non-empty → empty, which
        // can't happen pre-dismiss but keeps the loop idempotent).
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "magnifyingglass",
                label: "Search",
                monospaceArg: query.isEmpty ? nil : query,
                showSpinner: !hasResult
            )
            if hasResult, !results.isEmpty {
                AgentRollingSlot(
                    items: results,
                    currentIndex: currentIndex,
                    slotHeight: 18
                ) { ref in
                    resultRow(ref)
                }
            }
        }
    }

    private func resultRow(_ ref: AgentDocRef) -> some View {
        HStack(spacing: 6) {
            SourceIconView(sourceId: ref.sourceId, store: store, size: 11)
            Text(ref.title ?? "Untitled")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            AgentLoopChip(loops: ref.openLoops)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Trace connections

/// `trace_connections` card. Header is "Trace connections" — seeds and
/// depth are deliberately omitted (they're low-level args the user doesn't
/// need to see). Below the header, a single-line slot rotates through
/// the docs the walk reached (source icon + title), then the card
/// dismisses itself like Search / Open Document / Run SQL.
@available(iOS 17.0, *)
struct AgentEphemeralTrailCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialIndex: Int?
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards start showing their first result
        // immediately — without this a frozen card parks the slot off-screen
        // and renders header-only (#890).
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    /// Cap the rotation length. A graph walk can touch dozens of docs;
    /// the card is a glance, not an exhaustive replay. The full trail
    /// surfaces in the side-panel Timeline.
    private static let maxDocsToReveal: Int = 12

    /// Flatten the trail's `events[]` (each with nested `attachments[]`)
    /// into a single chronological list of `AgentTrailEventDoc` rows
    /// for the rolling slot. Dedup by documentId so a doc surfacing as
    /// both an event and an attachment doesn't roll twice. Record-only
    /// events (#757, no `doc`) carry no document to reveal here, so they
    /// are skipped. Capped at `maxDocsToReveal`.
    private var docs: [AgentTrailEventDoc] {
        guard case .eventTrailBuilt(_, let events, _, _) = call.result else { return [] }
        var seen: Set<String> = []
        var out: [AgentTrailEventDoc] = []
        for event in events {
            if let doc = event.doc, seen.insert(doc.documentId).inserted {
                out.append(doc)
                if out.count >= Self.maxDocsToReveal { return out }
            }
            for attachment in event.attachments {
                if let attDoc = attachment.doc, seen.insert(attDoc.documentId).inserted {
                    out.append(attDoc)
                    if out.count >= Self.maxDocsToReveal { return out }
                }
            }
        }
        return out
    }

    private var hasResult: Bool {
        call.result != nil
    }

    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = docs.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "point.3.connected.trianglepath.dotted",
                label: "Trace connections",
                showSpinner: !hasResult
            )
            if hasResult, !docs.isEmpty {
                AgentRollingSlot(
                    items: docs,
                    currentIndex: currentIndex,
                    slotHeight: 18
                ) { doc in
                    docRow(doc)
                }
            }
        }
    }

    private func docRow(_ doc: AgentTrailEventDoc) -> some View {
        HStack(spacing: 6) {
            SourceIconView(sourceId: doc.sourceId, store: store, size: 11)
            Text(doc.title.isEmpty ? "Untitled" : doc.title)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Open Document

/// Open-document card. Header carries the doc identity (source icon
/// + title). Below it, a single-line slot rotates through the
/// document body one line at a time, then dismisses.
@available(iOS 17.0, *)
struct AgentEphemeralDocumentCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialIndex: Int?
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards start showing their first result
        // immediately — without this a frozen card parks the slot off-screen
        // and renders header-only (#890).
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    private var docRef: AgentDocRef? {
        if case .document(let ref, _, _) = call.result { return ref }
        return nil
    }

    /// Cap the rotation length. A long PDF or email body can carry
    /// 100+ lines — without a cap, the card would stay on screen
    /// rotating for tens of seconds, which is the opposite of
    /// "ephemeral".
    private static let maxLinesToReveal: Int = 10

    /// Non-blank lines from the document body. Blank lines would
    /// flash empty slots and break the cadence — skip them so the
    /// rotation reads continuously. Capped at `maxLinesToReveal`.
    private var contentLines: [String] {
        if case .document(_, let content, _) = call.result, let content {
            return Array(
                content
                    .split(separator: "\n", omittingEmptySubsequences: false)
                    .map(String.init)
                    .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                    .prefix(Self.maxLinesToReveal)
            )
        }
        return []
    }

    private var hasResult: Bool {
        call.result != nil
    }

    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = contentLines.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "doc.text",
                label: "Open document",
                showSpinner: !hasResult
            ) {
                if let ref = docRef {
                    HStack(spacing: 4) {
                        SourceIconView(sourceId: ref.sourceId, store: store, size: 11)
                        Text(ref.title ?? "Untitled")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        AgentLoopChip(loops: ref.openLoops)
                    }
                }
            }
            if hasResult, !contentLines.isEmpty {
                AgentRollingSlot(
                    items: contentLines,
                    currentIndex: currentIndex,
                    slotHeight: 16
                ) { line in
                    Text(line)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

// MARK: - Run SQL

/// Run-SQL card. Two rotating slots driven sequentially:
///   1. SQL query lines (one slot under the header) — kicks off as
///      soon as args land.
///   2. Result table rows (one slot under a static column header) —
///      kicks off when the result arrives, after the query has
///      finished rotating through.
/// Both slots clip to their natural single-line/row height; the card
/// never grows. Up to 10 result rows are shown; beyond that gets
/// dropped — the user doesn't need an exhaustive table here.
@available(iOS 17.0, *)
struct AgentEphemeralSqlCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialSqlIndex: Int?
    var initialRowIndex: Int?
    var freeze: Bool = false

    @State private var sqlIndex: Int?
    @State private var rowIndex: Int?
    @State private var sqlDone: Bool = false
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    private let maxRowsToReveal: Int = 10

    init(
        call: AgentToolCall,
        initialSqlIndex: Int? = nil,
        initialRowIndex: Int? = nil,
        freeze: Bool = false
    ) {
        self.call = call
        self.initialSqlIndex = initialSqlIndex
        self.initialRowIndex = initialRowIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards render their first SQL line + row
        // statically rather than parking both slots off-screen (#890).
        self._sqlIndex = State(initialValue: initialSqlIndex ?? (freeze ? 0 : nil))
        self._rowIndex = State(initialValue: initialRowIndex ?? (freeze ? 0 : nil))
        self._sqlDone = State(initialValue: initialSqlIndex != nil)
    }

    /// Composite re-run key: stage 1 starts on argsKnown, stage 2 on
    /// hasResult, and expedite branches if pendingTail becomes non-empty.
    private var lifecycleKey: AgentEphemeralSqlLifecycleKey {
        .init(
            argsKnown: call.argsKnown,
            hasResult: hasResult,
            expedited: !call.pendingTail.isEmpty
        )
    }

    private var sql: String {
        (call.args.value as? [String: Any])?["sql"] as? String ?? ""
    }

    /// Collapse the query to a single line so the SQL phase ticks once
    /// (~one reveal interval) instead of one tick per source line.
    /// Truncation handles overflow visually; the full query lives on in
    /// the persisted history.
    private var sqlLines: [String] {
        let oneLine = sql
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        return oneLine.isEmpty ? [] : [oneLine]
    }

    private var columns: [String] {
        if case .sqlRows(_, let c, _, _, _, _, _, _) = call.result { return c }
        return []
    }

    private var allRows: [[JSONAny]] {
        if case .sqlRows(_, _, let r, _, _, _, _, _) = call.result {
            return Array(r.prefix(maxRowsToReveal))
        }
        return []
    }

    private var hasResult: Bool {
        call.result != nil
    }

    /// Source attribution + friendly table names — populated server-side
    /// by the analytics catalog (and baked into replay fixtures for
    /// synthetic conversations), so the renderer stays source-agnostic.
    private var sources: [AgentSqlSource] {
        if case .sqlRows(_, _, _, _, _, _, let s, _) = call.result { return s }
        return []
    }

    private var subjects: [String] {
        if case .sqlRows(_, _, _, _, _, _, _, let s) = call.result { return s }
        return []
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runLifecycle() }
    }

    /// Single async lifecycle covering both phases AND expedite. Stage 1
    /// (SQL query) runs first if args are known; stage 2 (rows) waits
    /// for the result and runs after stage 1 sets `sqlDone`. The
    /// expedite branch short-circuits whichever phase is currently
    /// active so the card can fade away in time for the trailing text.
    private func runLifecycle() async {
        guard !freeze, !dismissed else { return }
        guard call.argsKnown || hasResult else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }

        // Stage 1: SQL query rotation. Resume from where we left off so
        // a re-run (when hasResult flips true mid-stage-1) doesn't reset
        // the visible position.
        if !sqlDone {
            let total = sqlLines.count
            if total == 0 {
                sqlDone = true
            } else {
                let startFrom = (sqlIndex ?? -1) + 1
                for i in startFrom ..< total {
                    withAnimation(agentEphemeralScrollAnimation) { sqlIndex = i }
                    do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
                }
                sqlDone = true
            }
        }

        // Stage 2: row rotation. If the result hasn't landed yet, the
        // task simply exits; it'll be re-fired by `lifecycleKey` once
        // `hasResult` flips.
        guard hasResult else { return }
        let count = allRows.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFromRow = (rowIndex ?? -1) + 1
        for i in startFromRow ..< count {
            withAnimation(agentEphemeralScrollAnimation) { rowIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "tablecells",
                label: "Run SQL",
                showSpinner: !hasResult
            ) {
                if !sources.isEmpty || !subjects.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(sources, id: \.sourceId) { s in
                            SourceIconView(sourceId: s.sourceId, store: store, size: 11)
                        }
                        if !subjects.isEmpty {
                            Text(subjects.joined(separator: " + "))
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                }
            }
            if !sqlLines.isEmpty {
                sqlSlot
            }
            if hasResult, !allRows.isEmpty, !columns.isEmpty {
                rowSlot
            }
        }
    }

    private var sqlSlot: some View {
        AgentRollingSlot(
            items: sqlLines,
            currentIndex: sqlIndex,
            slotHeight: 16
        ) { line in
            Text(line.isEmpty ? " " : line)
                .font(Theme.monospace(size: 11))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Fixed per-column width. Each cell renders at exactly this width so
    /// the header and rolling value row stay aligned, and the table's
    /// total width is deterministic (`columnWidth * columns.count`).
    private let columnWidth: CGFloat = 80

    private var tableWidth: CGFloat {
        columnWidth * CGFloat(columns.count)
    }

    /// Two plain text rows — column header (monospace, slightly
    /// brighter) and the rolling value row (monospace, muted). No
    /// surrounding box; the rail handles the "this is an action"
    /// signal.
    ///
    /// The whole table sits in a horizontal `ScrollView` so a wide result
    /// (many columns) clips to the available width instead of forcing the
    /// transcript — composer and bubbles included — wider than the
    /// viewport. A ScrollView only ever takes the width its parent offers,
    /// so the column count can't push the surrounding layout around.
    private var rowSlot: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, col in
                        Text(col)
                            .font(Theme.monospace(size: 11).weight(.semibold))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(width: columnWidth, alignment: .leading)
                    }
                }
                AgentRollingSlot(
                    items: allRows,
                    currentIndex: rowIndex,
                    slotHeight: 18
                ) { row in
                    valueRow(row)
                }
                .frame(width: tableWidth, alignment: .leading)
            }
        }
        .menuRevealExcluded()
    }

    private func valueRow(_ row: [JSONAny]) -> some View {
        HStack(spacing: 0) {
            let cells = normalised(row: row)
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(formatCell(cell))
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(width: columnWidth, alignment: .leading)
            }
        }
    }

    private func normalised(row: [JSONAny]) -> [JSONAny] {
        if row.count == columns.count { return row }
        if row.count > columns.count { return Array(row.prefix(columns.count)) }
        return row + Array(repeating: JSONAny.null, count: columns.count - row.count)
    }

    private func formatCell(_ cell: JSONAny) -> String {
        switch cell.value {
        case is NSNull:
            return "null"
        case let b as Bool:
            return b ? "true" : "false"
        case let i as Int:
            return String(i)
        case let d as Double:
            return d.rounded() == d ? String(Int(d)) : String(d)
        case let s as String:
            return s
        case let dict as [String: Any]:
            if let days = dict["days"] as? Int, dict.count == 1 {
                let date = Date(timeIntervalSince1970: TimeInterval(days) * 86400)
                return Self.dateFormatter.string(from: date)
            }
            if let micros = dict["micros"] as? Int, dict.count == 1 {
                let date = Date(timeIntervalSince1970: TimeInterval(micros) / 1_000_000)
                return Self.timestampFormatter.string(from: date)
            }
            return cell.jsonString
        default:
            return cell.jsonString
        }
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static let timestampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
}

// MARK: - Lookup people

/// People-lookup card. Header is "Find people <query>". Below it, a
/// single-line slot rotates through one candidate at a time (display
/// name + primary alias), then the whole card disappears. Mirrors
/// `AgentEphemeralSearchCard` end-to-end so the disambiguation surface
/// reads visually the same as the search surface.
@available(iOS 17.0, *)
struct AgentEphemeralPeopleCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialIndex: Int?
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards start showing their first result
        // immediately — without this a frozen card parks the slot off-screen
        // and renders header-only (#890).
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    private var query: String {
        (call.args.value as? [String: Any])?["query"] as? String ?? ""
    }

    /// Same cap as search — `lookup_people` is a disambiguation surface,
    /// not an exhaustive directory listing. The tool itself clamps at
    /// 20 candidates server-side; this is the visual cap.
    private static let maxResultsToReveal: Int = 12

    private var results: [AgentPersonSummary] {
        if case .personResults(_, _, let r) = call.result {
            return Array(r.prefix(Self.maxResultsToReveal))
        }
        return []
    }

    private var hasResult: Bool {
        call.result != nil
    }

    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = results.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "person.2",
                label: "Find people",
                monospaceArg: query.isEmpty ? nil : query,
                showSpinner: !hasResult
            )
            if hasResult, !results.isEmpty {
                AgentRollingSlot(
                    items: results,
                    currentIndex: currentIndex,
                    slotHeight: 18
                ) { person in
                    personRow(person)
                }
            }
        }
    }

    private func personRow(_ person: AgentPersonSummary) -> some View {
        HStack(spacing: 6) {
            Text(person.displayName)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if let alias = Self.primaryAlias(for: person), !alias.isEmpty {
                Text(alias)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
    }

    /// Pick the most agent-useful alias to show alongside the display
    /// name. The aliases array comes from the gateway already ordered
    /// email → phone → handle → name (see
    /// `listMergedAliasesForPerson` in `PersonRepository.ts`), so the
    /// first entry is always the most useful follow-up filter.
    /// Returns nil when the person has no aliases at all.
    private static func primaryAlias(for person: AgentPersonSummary) -> String? {
        person.aliases.first
    }
}

// MARK: - URL lookup

/// URL-lookup card. Header is "Lookup URL <url>". Below it, a single-
/// line slot reveals one row — the matched document (source icon +
/// title) or a "no match" placeholder — then the card disappears.
/// Mirrors the search/people cards in chrome and pacing.
@available(iOS 17.0, *)
struct AgentEphemeralUrlLookupCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialIndex: Int?
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards start showing their first result
        // immediately — without this a frozen card parks the slot off-screen
        // and renders header-only (#890).
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    private var url: String {
        (call.args.value as? [String: Any])?["url"] as? String ?? ""
    }

    private var ref: AgentDocRef? {
        if case .documentByUrl(_, _, let r) = call.result { return r }
        return nil
    }

    private var hasResult: Bool {
        call.result != nil
    }

    /// One-row slot: the matched ref (when found) OR a "no match"
    /// sentinel string (when the URL points outside the corpus). The
    /// slot still rolls once for parity with the other cards, so the
    /// motion reads the same regardless of which outcome fired.
    private enum SlotItem: Hashable { case ref(AgentDocRef)
        case noMatch
    }

    private var items: [SlotItem] {
        guard hasResult else { return [] }
        return [ref.map(SlotItem.ref) ?? .noMatch]
    }

    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = items.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "link",
                label: "Lookup URL",
                monospaceArg: url.isEmpty ? nil : url,
                showSpinner: !hasResult
            )
            if hasResult, !items.isEmpty {
                AgentRollingSlot(
                    items: items,
                    currentIndex: currentIndex,
                    slotHeight: 18
                ) { item in
                    slotRow(item)
                }
            }
        }
    }

    @ViewBuilder
    private func slotRow(_ item: SlotItem) -> some View {
        switch item {
        case .ref(let r):
            HStack(spacing: 6) {
                SourceIconView(sourceId: r.sourceId, store: store, size: 11)
                Text(r.title ?? "Untitled")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
        case .noMatch:
            HStack(spacing: 6) {
                Text("No match in your corpus")
                    .font(.system(size: 11).italic())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Loop chrome (shared)

/// A subtle "in N loop(s)" pill for a document row when the Cognition Steward
/// tracks open loops that document is a source for (experimental). A tiny
/// chain-link glyph + count in accent, sized to read as a soft annotation
/// on the row — not another action card. Renders nothing when the ref has
/// no tracked loops, so call sites can drop it in unconditionally. Mirrors
/// the portal's `loopChip`.
@available(iOS 17.0, *)
struct AgentLoopChip: View {
    let loops: [AgentDocLoopRef]?

    private var count: Int {
        loops?.count ?? 0
    }

    var body: some View {
        if count > 0 {
            HStack(spacing: 3) {
                Image(systemName: "link")
                    .font(.system(size: 8, weight: .semibold))
                Text("\(count)")
                    .font(.system(size: 10, weight: .medium))
                    .monospacedDigit()
            }
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Theme.accent.opacity(0.12))
            .clipShape(Capsule())
            .fixedSize()
            .accessibilityLabel("in \(count) loop\(count == 1 ? "" : "s")")
        }
    }
}

/// Small uppercase state chip for an open loop — accent for `open`, amber
/// for `snoozed`, neutral otherwise. Mirrors the portal's
/// `.agent-loop-state` classes.
@available(iOS 17.0, *)
private struct AgentLoopStatePill: View {
    let state: String

    private var colors: (fg: Color, bg: Color) {
        switch state.lowercased() {
        case "open": (Theme.accentHover, Theme.accent.opacity(0.14))
        case "snoozed": (Theme.warning, Theme.warning.opacity(0.14))
        default: (Theme.textSecondary, Theme.bgTertiary)
        }
    }

    var body: some View {
        Text(state.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(colors.fg)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(colors.bg)
            .clipShape(Capsule())
            .fixedSize()
    }
}

/// Three-segment importance meter (0–1) — one, two, or three filled bars.
/// A compact non-numeric priority cue on the fetch-loop card's meta row.
@available(iOS 17.0, *)
private struct AgentLoopImportanceMeter: View {
    let value: Double

    private var filled: Int {
        // At least one bar whenever an importance is present, so the meter
        // never reads as "empty" for a real (low-but-nonzero) priority.
        if value >= 0.66 { return 3 }
        if value >= 0.33 { return 2 }
        return 1
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0 ..< 3, id: \.self) { i in
                Capsule()
                    .fill(i < filled ? Theme.accent : Theme.border)
                    .frame(width: 6, height: 3)
            }
        }
        .accessibilityLabel("importance \(Int((value * 100).rounded())) percent")
    }
}

// MARK: - Search loops

/// `search_loops` card. Header is "Search loops <query>". Below it, a
/// single-line slot rotates through one tracked loop at a time (state
/// chip + title), then the whole card disappears — the read-only twin of
/// `AgentEphemeralSearchCard`, so the chat agent reading the background
/// Cognition Steward's obligations reads visually the same as a document search.
@available(iOS 17.0, *)
struct AgentEphemeralLoopSearchCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialIndex: Int?
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards start showing their first result
        // immediately — without this a frozen card parks the slot off-screen
        // and renders header-only (#890).
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    private var query: String {
        (call.args.value as? [String: Any])?["query"] as? String ?? ""
    }

    /// Cap the rotation length — the slot is a glance ("agent is reading
    /// its tracked loops"), not an exhaustive replay.
    private static let maxResultsToReveal: Int = 12

    private var loops: [AgentLoopSummary] {
        if case .loopsSearched(_, _, let l) = call.result {
            return Array(l.prefix(Self.maxResultsToReveal))
        }
        return []
    }

    private var hasResult: Bool {
        call.result != nil
    }

    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = loops.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "arrow.triangle.2.circlepath",
                label: "Search loops",
                monospaceArg: query.isEmpty ? nil : query,
                showSpinner: !hasResult
            )
            if hasResult, !loops.isEmpty {
                AgentRollingSlot(
                    items: loops,
                    currentIndex: currentIndex,
                    slotHeight: 18
                ) { loop in
                    loopRow(loop)
                }
            }
        }
    }

    private func loopRow(_ loop: AgentLoopSummary) -> some View {
        HStack(spacing: 6) {
            AgentLoopStatePill(state: loop.state)
            Text(loop.title.isEmpty ? "Untitled loop" : loop.title)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Open loop

/// `fetch_loop` card. Header carries the loop's identity (state chip),
/// with the title, a compact meta row (importance / deadline / people),
/// and a rolling slot cycling through the loop's recent ledger notes
/// below it, then the card dismisses itself like the other ephemeral
/// cards. `loop == nil` is a clean "no such loop" no-match, not an error.
@available(iOS 17.0, *)
struct AgentEphemeralLoopFetchCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialIndex: Int?
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        // Frozen (after-the-fact) cards start showing their first ledger
        // line immediately rather than parking the slot off-screen (#890).
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    private var loop: AgentLoopDetail? {
        if case .loopFetched(let l) = call.result { return l }
        return nil
    }

    private var hasResult: Bool {
        call.result != nil
    }

    /// Cap the ledger rotation — recent notes are a glance, not the full
    /// audit log. Oldest → newest on the wire; the tail (most recent) is
    /// the useful slice, so keep the last `maxLedgerToReveal`.
    private static let maxLedgerToReveal: Int = 6

    /// The people the loop concerns — actors first (they must act), then
    /// anyone else with a stake, deduped preserving order.
    private var people: [String] {
        var seen: Set<String> = []
        var out: [String] = []
        for name in (loop?.actors ?? []) + (loop?.involved ?? []) where seen.insert(name).inserted {
            out.append(name)
        }
        return out
    }

    /// Recent ledger lines formatted "short-date · note", newest slice.
    private var ledgerLines: [String] {
        guard let entries = loop?.ledger, !entries.isEmpty else { return [] }
        return entries.suffix(Self.maxLedgerToReveal).map { entry in
            let date = Date(timeIntervalSince1970: entry.at / 1000)
            return "\(Self.ledgerDateFormatter.string(from: date)) · \(entry.note)"
        }
    }

    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = ledgerLines.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: "arrow.triangle.2.circlepath",
                label: "Open loop",
                showSpinner: !hasResult
            ) {
                if let loop {
                    AgentLoopStatePill(state: loop.state)
                }
            }
            if hasResult {
                if let loop {
                    loopDetail(loop)
                } else {
                    Text("No such loop")
                        .font(.system(size: 11).italic())
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder
    private func loopDetail(_ loop: AgentLoopDetail) -> some View {
        Text(loop.title.isEmpty ? "Untitled loop" : loop.title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.textPrimary)
            .lineLimit(2)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
        metaRow(loop)
        if !ledgerLines.isEmpty {
            AgentRollingSlot(
                items: ledgerLines,
                currentIndex: currentIndex,
                slotHeight: 16
            ) { line in
                Text(line)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private func metaRow(_ loop: AgentLoopDetail) -> some View {
        let hasMeta = loop.importance != nil || loop.deadline != nil || !people.isEmpty
        if hasMeta {
            HStack(spacing: 10) {
                if let importance = loop.importance {
                    AgentLoopImportanceMeter(value: importance)
                }
                if let deadline = loop.deadline, !deadline.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: "calendar")
                            .font(.system(size: 9))
                        Text("Due \(deadline)")
                            .font(.system(size: 10))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .foregroundStyle(Theme.textMuted)
                }
                if !people.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: "person.2")
                            .font(.system(size: 9))
                        Text(peopleSummary)
                            .font(.system(size: 10))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .foregroundStyle(Theme.textMuted)
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// Up to two names joined with "·", plus a "+N" overflow marker.
    private var peopleSummary: String {
        let shown = people.prefix(2).joined(separator: " · ")
        let extra = people.count - min(people.count, 2)
        return extra > 0 ? "\(shown) +\(extra)" : shown
    }

    private static let ledgerDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()
}

// MARK: - Background action card (generic)

/// Generic ephemeral card for background actions without a bespoke card.
/// It names the action, rolls one outcome, then dismisses; resumed history
/// never rebuilds it.
/// The action may come from stable interactive memory or an experimental
/// steward surface; presentation follows the tool name rather than the
/// gateway's feature mode.
@available(iOS 17.0, *)
struct AgentEphemeralActionCard: View {
    @Environment(AppStore.self) private var store
    let call: AgentToolCall
    var initialIndex: Int?
    var freeze: Bool = false

    @State private var currentIndex: Int?
    @State private var dismissed: Bool = false
    @State private var startedAt: Date?
    @State private var flushed: Bool = false

    init(call: AgentToolCall, initialIndex: Int? = nil, freeze: Bool = false) {
        self.call = call
        self.initialIndex = initialIndex
        self.freeze = freeze
        self._currentIndex = State(initialValue: initialIndex ?? (freeze ? 0 : nil))
    }

    private var hasResult: Bool {
        call.result != nil
    }

    private enum SlotItem: Hashable {
        case outcome(String, isError: Bool)
    }

    /// One row: the error on failure, otherwise the humanized structured
    /// result type ("brief.updated" → "Brief updated").
    private var items: [SlotItem] {
        guard let result = call.result else { return [] }
        switch result {
        case .error(_, let message):
            return [.outcome(String(message.prefix(120)), isError: true)]
        case .unknown(_, let raw):
            let resultType = (raw.value as? [String: Any])?["resultType"] as? String
            return [.outcome(resultType.map(agentHumanizeResultType) ?? "Done", isError: false)]
        default:
            return [.outcome("Done", isError: false)]
        }
    }

    private var lifecycleKey: AgentEphemeralLifecycleKey {
        .init(ready: hasResult, expedited: !call.pendingTail.isEmpty)
    }

    var body: some View {
        Group {
            if !dismissed {
                cardContent
                    .transition(.opacity)
            }
        }
        .task(id: lifecycleKey) { await runRotation() }
    }

    private func runRotation() async {
        guard hasResult, !freeze, !dismissed else { return }
        if startedAt == nil { startedAt = Date() }
        if !call.pendingTail.isEmpty {
            await expediteDismiss()
            return
        }
        let count = items.count
        if count == 0 {
            do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs + agentEphemeralRevealIntervalNs) } catch { return }
            await dismissAndFlush()
            return
        }
        let startFrom = (currentIndex ?? -1) + 1
        for i in startFrom ..< count {
            withAnimation(agentEphemeralScrollAnimation) { currentIndex = i }
            do { try await Task.sleep(nanoseconds: agentEphemeralRevealIntervalNs) } catch { return }
        }
        do { try await Task.sleep(nanoseconds: agentEphemeralHoldNs) } catch { return }
        await dismissAndFlush()
    }

    private func expediteDismiss() async {
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let remaining = max(0, agentEphemeralMinVisibleSeconds - elapsed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        await dismissAndFlush()
    }

    private func dismissAndFlush() async {
        if dismissed { return }
        withAnimation(.easeOut(duration: agentEphemeralFadeSeconds)) { dismissed = true }
        guard !flushed else { return }
        flushed = true
        // try? — if SwiftUI cancels our task mid-fade (lifecycleKey
        // changed because pendingTail grew), we must still open the
        // causality gate. Without this, queued text tokens stay parked
        // on pendingTail forever and the conversation appears to stop.
        try? await Task.sleep(nanoseconds: agentEphemeralFadeNs)
        await store.agent.flushEphemeralTail(toolCallId: call.toolCallId)
    }

    private var cardContent: some View {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph: Self.glyph(for: call.tool),
                label: Self.label(for: call.tool),
                monospaceArg: call.argsSummary.isEmpty ? nil : call.argsSummary,
                showSpinner: !hasResult
            )
            if hasResult, !items.isEmpty {
                AgentRollingSlot(
                    items: items,
                    currentIndex: currentIndex,
                    slotHeight: 18
                ) { item in
                    slotRow(item)
                }
            }
        }
    }

    @ViewBuilder
    private func slotRow(_ item: SlotItem) -> some View {
        switch item {
        case .outcome(let line, let isError):
            HStack(spacing: 6) {
                Image(systemName: isError ? "exclamationmark.triangle" : "checkmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(isError ? Theme.warning : Theme.textMuted)
                Text(line)
                    .font(.system(size: 11))
                    .foregroundStyle(isError ? Theme.warning : Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
        }
    }

    /// Human verb for each background action; the raw name for anything
    /// unrecognized, so a future tool still reads sanely.
    static func label(for tool: String) -> String {
        AgentEphemeralActionLabel.label(for: tool)
    }

    static func glyph(for tool: String) -> String {
        switch tool {
        case "open_loop_search", "open_loop_fetch", "open_loop_create",
             "open_loop_update", "open_loop_delete", "open_loop_ledger_append":
            "arrow.triangle.2.circlepath"
        case "brief_list", "brief_fetch", "brief_create", "brief_update", "brief_delete":
            "rectangle.stack"
        case "temporal_query", "temporal_annotation_add", "temporal_annotation_update",
             "temporal_annotation_delete", "time_index_query", "time_index_add",
             "time_index_update", "time_index_delete":
            "calendar"
        case "notes_append", "notes_rewrite":
            "note.text"
        case "conversation_memory_evidence", "annotation_search",
             "annotate_durable", "annotation_revise", "annotation_retract",
             "annotation_supersede", "annotate_person", "person_annotation_revise",
             "person_annotation_retract", "person_annotation_supersede":
            "brain.head.profile"
        case "schedule_agent_run":
            "clock.arrow.circlepath"
        case "list_loops":
            "arrow.triangle.2.circlepath"
        case "entity_context":
            "point.3.connected.trianglepath.dotted"
        default:
            "wrench.and.screwdriver"
        }
    }
}

// MARK: - Routing helpers

/// Routes every ephemeral result through a dismissing card, including
/// errors and unknown results, so its lifecycle unblocks the causality gate.
@available(iOS 17.0, *)
func agentEphemeralCardHandles(_ call: AgentToolCall) -> Bool {
    // The persistent fallback never flushes the causality gate, so routing
    // cannot depend on the result's success or decoded kind.
    agentEphemeralTools.contains(call.tool)
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Memory action — replace done (frozen)") {
    ScrollView {
        AgentEphemeralActionCard(
            call: PreviewMocks.agentToolCallMemoryReplaceComplete,
            freeze: true
        )
        .padding()
        .environment(AppStore.preview())
    }
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Loop-agent action — running") {
    ScrollView {
        AgentEphemeralActionCard(
            call: PreviewMocks.agentToolCallLoopSearchRunning,
            freeze: true
        )
        .padding()
        .environment(AppStore.preview())
    }
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Loop-agent action — error (frozen)") {
    ScrollView {
        AgentEphemeralActionCard(
            call: PreviewMocks.agentToolCallTimeIndexError,
            freeze: true
        )
        .padding()
        .environment(AppStore.preview())
    }
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Search — slot on result #2 (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralSearchCard(
                call: PreviewMocks.agentToolCallSearchComplete,
                initialIndex: 1,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search — pending (no result)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralSearchCard(
                call: PreviewMocks.agentToolCallSearchPending,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search — error result (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralSearchCard(
                call: PreviewMocks.agentToolCallSearchError,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Open document — slot on line #4 (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralDocumentCard(
                call: PreviewMocks.agentToolCallDocumentComplete,
                initialIndex: 3,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("SQL — value-row #1 visible (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralSqlCard(
                call: PreviewMocks.agentToolCallSqlComplete,
                initialSqlIndex: 11,
                initialRowIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("SQL — wide table (8 columns, frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralSqlCard(
                call: PreviewMocks.agentToolCallSqlWide,
                initialSqlIndex: 11,
                initialRowIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("SQL — query rotating, no result yet (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralSqlCard(
                call: PreviewMocks.agentToolCallSqlQueryOnly,
                initialSqlIndex: 5,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Find people — slot on candidate #2 (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralPeopleCard(
                call: PreviewMocks.agentToolCallPeopleComplete,
                initialIndex: 1,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Find people — pending (no result)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralPeopleCard(
                call: PreviewMocks.agentToolCallPeoplePending,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Find people — zero results (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralPeopleCard(
                call: PreviewMocks.agentToolCallPeopleEmpty,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Find people — one candidate (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralPeopleCard(
                call: PreviewMocks.agentToolCallPeopleSingle,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Find people — name only, no aliases (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralPeopleCard(
                call: PreviewMocks.agentToolCallPeopleNameOnly,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Lookup URL — match (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralUrlLookupCard(
                call: PreviewMocks.agentToolCallUrlLookupHit,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Lookup URL — no match (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralUrlLookupCard(
                call: PreviewMocks.agentToolCallUrlLookupMiss,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Lookup URL — pending (no result)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralUrlLookupCard(
                call: PreviewMocks.agentToolCallUrlLookupPending,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Lookup URL — Notion source (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralUrlLookupCard(
                call: PreviewMocks.agentToolCallUrlLookupNotion,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Lookup URL — long URL + nil title (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralUrlLookupCard(
                call: PreviewMocks.agentToolCallUrlLookupLong,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search — doc row with loop chips (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralSearchCard(
                call: PreviewMocks.agentToolCallSearchWithLoops,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Open document — with loop chip (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralDocumentCard(
                call: PreviewMocks.agentToolCallDocumentWithLoops,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search loops — slot on loop #1 (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralLoopSearchCard(
                call: PreviewMocks.agentToolCallLoopSearch,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search loops — pending (no result)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralLoopSearchCard(
                call: PreviewMocks.agentToolCallLoopSearchPending,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search loops — zero results (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralLoopSearchCard(
                call: PreviewMocks.agentToolCallLoopSearchEmpty,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Open loop — populated (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralLoopFetchCard(
                call: PreviewMocks.agentToolCallLoopFetch,
                initialIndex: 0,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Open loop — no match (frozen)") {
    NavigationStack {
        ScrollView {
            AgentEphemeralLoopFetchCard(
                call: PreviewMocks.agentToolCallLoopFetchEmpty,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}
#endif
#endif

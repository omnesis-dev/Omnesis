// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Where the Morning brief conversation reads its brief items from, and
/// what "now" is for its day labels. The app derives it from the paired
/// agent client; the demo surface and previews supply their own.
@available(iOS 17.0, *)
struct DailyBriefContext {
    var loader: (any DailyBriefItemsLoading)?
    var now: () -> Date = Date.init
    /// Items already in hand, so a preview renders without a fetch.
    var preloaded: [DailyBriefItems] = []
}

@available(iOS 17.0, *)
private struct DailyBriefContextKey: EnvironmentKey {
    static let defaultValue: DailyBriefContext? = nil
}

@available(iOS 17.0, *)
extension EnvironmentValues {
    /// Overrides the Morning brief conversation's item source and clock.
    var dailyBriefContext: DailyBriefContext? {
        get { self[DailyBriefContextKey.self] }
        set { self[DailyBriefContextKey.self] = newValue }
    }
}

@available(iOS 17.0, *)
extension View {
    /// A point at the top of a turn's row, which the transcript scrolls to when
    /// a load opens at that turn. A `scrollTo` anchor aligns the same fraction
    /// of the target and the viewport, so only a target with no height puts the
    /// turn's top at that fraction of the screen whatever the turn's length.
    func readingAnchorMarker(_ turnId: String) -> some View {
        background(alignment: .top) {
            Color.clear.frame(height: 1).id(readingAnchorMarkerId(turnId))
        }
    }
}

/// The scroll id of a turn's `readingAnchorMarker`.
func readingAnchorMarkerId(_ turnId: String) -> String {
    "reading-anchor-\(turnId)"
}

/// The transcript's turns. Every conversation shows them as bubbles; the
/// Morning brief conversation groups them by day under each brief, with
/// earlier days folded.
@available(iOS 17.0, *)
struct AgentTranscriptTurns: View {
    let agent: AgentCoordinator
    let scrollSpace: String
    var onEdit: ((String) -> Void)?
    @Environment(\.dailyBriefContext) private var injected

    var body: some View {
        if let origin = agent.conversationOrigin, origin.isDailyBrief, let sessionId = agent.sessionId {
            let context = injected ?? DailyBriefContext(
                loader: agent.client.map { DailyBriefClient(baseURL: $0.baseURL, token: $0.token) }
            )
            DailyBriefTranscriptView(
                conversationId: sessionId,
                origin: origin,
                turns: agent.turns,
                context: context,
                scrollSpace: scrollSpace,
                onEdit: onEdit,
                editingDisabled: !agent.canComposeMessage || agent.submitting
            )
            // A fresh model per conversation, and once a client appears.
            .id("\(sessionId)|\(context.loader != nil)")
        } else {
            ForEach(agent.turns) { turn in
                editableBubble(turn)
                    .id(turn.id)
                    .pagingRowFrame(id: turn.id, in: scrollSpace)
                    .readingAnchorMarker(turn.id)
            }
        }
    }

    private func editableBubble(_ turn: AgentTurn) -> some View {
        ConversationEditableTurn(
            turn: turn,
            disabled: !agent.canComposeMessage || agent.submitting,
            onEdit: onEdit
        )
    }
}

@available(iOS 17.0, *)
private struct ConversationEditableTurn: View {
    let turn: AgentTurn
    let disabled: Bool
    var onEdit: ((String) -> Void)?

    var body: some View {
        AgentTurnBubble(turn: turn)
            .contextMenu {
                switch turn {
                case .user(_, let text):
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                    if let onEdit {
                        Button("Edit and resend", systemImage: "square.and.pencil") { onEdit(text) }
                            .disabled(disabled)
                    }
                case .assistant(let assistant):
                    Button("Copy", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = assistant.parts.compactMap { part in
                            if case .text(let text) = part { return text }
                            return nil
                        }
                        .joined(separator: "\n\n")
                    }
                }
            }
    }
}

/// The Morning brief conversation, one day per brief: a separator naming
/// the day, the brief under its header, what it was based on, then the
/// replies. The latest day is open with its "Based on" list showing; every
/// earlier day folds to one line until tapped.
@available(iOS 17.0, *)
struct DailyBriefTranscriptView: View {
    let origin: ConversationOrigin
    let turns: [AgentTurn]
    let context: DailyBriefContext
    let scrollSpace: String
    var onEdit: ((String) -> Void)?
    var editingDisabled: Bool
    @State private var model: DailyBriefModel
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale

    init(
        conversationId: String,
        origin: ConversationOrigin,
        turns: [AgentTurn],
        context: DailyBriefContext,
        scrollSpace: String,
        model preset: DailyBriefModel? = nil,
        onEdit: ((String) -> Void)? = nil,
        editingDisabled: Bool = false
    ) {
        self.origin = origin
        self.turns = turns
        self.context = context
        self.scrollSpace = scrollSpace
        self.onEdit = onEdit
        self.editingDisabled = editingDisabled
        // A preview hands in a model already in the state it shows.
        let model = preset ?? DailyBriefModel(
            conversationId: conversationId,
            loader: context.loader,
            preloaded: context.preloaded
        )
        model.observeLatest(origin.latestDailyBrief)
        self._model = State(initialValue: model)
    }

    var body: some View {
        let transcript = DailyBriefTranscript(turns: turns, briefs: origin.briefs)
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 14) {
                ForEach(transcript.leading) { turn in
                    bubble(turn)
                }
                ForEach(transcript.days) { day in
                    dayView(day, proxy: proxy)
                }
            }
        }
        .onChange(of: origin.latestDailyBrief) { _, latest in model.observeLatest(latest) }
    }

    @ViewBuilder
    private func dayView(_ day: DailyBriefDay, proxy: ScrollViewProxy) -> some View {
        let brief = day.brief
        let isLatest = brief.messageId == model.latestId
        let open = model.isOpen(brief)
        let now = context.now()
        VStack(alignment: .leading, spacing: 14) {
            DailyBriefDaySeparator(
                day: brief.day,
                label: DailyBriefCopy.dayLabel(brief.day, now: now, calendar: calendar, locale: locale) ?? brief.day,
                spokenLabel: DailyBriefCopy.spokenDayLabel(brief.day, now: now, calendar: calendar, locale: locale)
                    ?? brief.day,
                isOpen: isLatest ? nil : open,
                onToggle: { toggle(brief, proxy: proxy) }
            )
            .id(separatorId(brief))
            if open {
                openDay(day)
            } else if let first = day.turns.first {
                DailyBriefFoldedRow(
                    day: brief.day,
                    summary: DailyBriefCopy.foldedSummary(
                        itemCount: model.itemCount(day: brief.day),
                        replyCount: day.replyCount
                    ),
                    onOpen: { toggle(brief, proxy: proxy) }
                )
                // The day's first turn is folded into this row, so the
                // row stands in for it when an earlier page is prepended.
                .id(first.id)
                .pagingRowFrame(id: first.id, in: scrollSpace)
            }
        }
    }

    @ViewBuilder
    private func openDay(_ day: DailyBriefDay) -> some View {
        let brief = day.brief
        if let briefTurn = day.turns.first {
            VStack(alignment: .leading, spacing: 8) {
                DailyBriefHeader(time: DailyBriefCopy.sentTime(
                    brief.sentAt ?? model.sentAt(day: brief.day),
                    calendar: calendar,
                    locale: locale
                ))
                ConversationEditableTurn(turn: briefTurn, disabled: editingDisabled, onEdit: onEdit)
            }
            .id(briefTurn.id)
            .pagingRowFrame(id: briefTurn.id, in: scrollSpace)
            .readingAnchorMarker(briefTurn.id)
        }
        DailyBriefFooter(
            day: brief.day,
            state: model.items[brief.day],
            isOpen: model.isFooterOpen(brief),
            // Not animated: the transcript follows its bottom by the content's size, and an
            // animated change in size is reported before the scroll view can reach the new end.
            onToggle: { model.toggleFooter(brief) },
            onRetry: { Task { await model.retry(day: brief.day) } },
            onReact: { observationId, reaction, note in
                await model.react(day: brief.day, observationId: observationId, reaction: reaction, note: note)
            },
            reactionFailure: { model.reactionFailure(observationId: $0) }
        )
        .task(id: brief.day) { await model.load(day: brief.day) }
        ForEach(day.turns.dropFirst()) { turn in
            bubble(turn)
        }
    }

    private func bubble(_ turn: AgentTurn) -> some View {
        ConversationEditableTurn(turn: turn, disabled: editingDisabled, onEdit: onEdit)
            .id(turn.id)
            .pagingRowFrame(id: turn.id, in: scrollSpace)
            .readingAnchorMarker(turn.id)
    }

    private func separatorId(_ brief: DailyBriefMessageRef) -> String {
        "daily-brief-separator-\(brief.messageId)"
    }

    /// Open or fold an earlier day, then bring its separator to the top. The
    /// transcript follows its bottom while the reader is there, so without
    /// this an opened day could push the line they tapped out of sight.
    private func toggle(_ brief: DailyBriefMessageRef, proxy: ScrollViewProxy) {
        let opening = !model.isOpen(brief)
        model.toggleDay(brief)
        guard opening else { return }
        let target = separatorId(brief)
        Task { @MainActor in
            // After the opened day has been laid out and any follow-the-bottom
            // scroll has run.
            try? await Task.sleep(for: .milliseconds(120))
            withAnimation(.easeInOut(duration: 0.25)) {
                // Below the floating top buttons, which the transcript scrolls under.
                proxy.scrollTo(target, anchor: UnitPoint(x: 0.5, y: 0.16))
            }
        }
    }
}
#endif

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
/// The Morning brief conversation's transcript on its own, from a fixture
/// model, for previews and snapshots: every state renders on the first pass.
@available(iOS 17.0, *)
struct DailyBriefTranscriptPreview: View {
    let model: DailyBriefModel

    var body: some View {
        NavigationStack {
            ScrollView {
                DailyBriefTranscriptView(
                    conversationId: PreviewMocks.dailyBriefSeed.sessionId ?? "",
                    origin: PreviewMocks.dailyBriefOrigin,
                    turns: PreviewMocks.dailyBriefSeed.turns,
                    context: PreviewMocks.dailyBriefContext,
                    scrollSpace: "daily-brief-preview",
                    model: model
                )
                .padding(Theme.Spacing.lg)
            }
            .coordinateSpace(name: "daily-brief-preview")
            .background(Theme.bgPrimary.ignoresSafeArea())
        }
        .environment(AppStore.preview())
    }

    /// A model holding `pages`, with the latest brief noted, then `configure`d.
    static func model(
        pages: [DailyBriefItems] = [PreviewMocks.dailyBriefToday],
        configure: (DailyBriefModel) -> Void = { _ in }
    )
        -> DailyBriefModel {
        let model = DailyBriefModel(conversationId: "s_morning_brief", loader: nil, preloaded: pages)
        model.observeLatest(PreviewMocks.dailyBriefOrigin.latestDailyBrief)
        configure(model)
        return model
    }
}

@available(iOS 17.0, *)
#Preview("Morning brief — today open, earlier days folded") {
    DailyBriefTranscriptPreview(model: DailyBriefTranscriptPreview.model())
}

@available(iOS 17.0, *)
#Preview("Morning brief — today's list folded") {
    DailyBriefTranscriptPreview(model: DailyBriefTranscriptPreview.model { model in
        model.toggleFooter(PreviewMocks.dailyBriefOrigin.briefs[2])
    })
}

@available(iOS 17.0, *)
#Preview("Morning brief — yesterday opened") {
    DailyBriefTranscriptPreview(model: DailyBriefTranscriptPreview.model(pages: PreviewMocks.dailyBriefPages) { model in
        model.toggleDay(PreviewMocks.dailyBriefOrigin.briefs[1])
    })
}

@available(iOS 17.0, *)
#Preview("Morning brief — items failed to load") {
    DailyBriefTranscriptPreview(model: DailyBriefTranscriptPreview.model(pages: []) { model in
        model.showForPreview(.failed, day: "2026-10-14")
    })
}

@available(iOS 17.0, *)
#Preview("Morning brief — full conversation") {
    AgentView(menuOpen: .constant(false))
        .environment(AppStore.preview(agentPreview: PreviewMocks.dailyBriefSeed))
        .environment(\.dailyBriefContext, PreviewMocks.dailyBriefContext)
}
#endif

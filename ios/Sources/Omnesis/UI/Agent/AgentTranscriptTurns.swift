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

/// The transcript's turns. Every conversation shows them as bubbles; the
/// Morning brief conversation groups them by day under each brief, with
/// earlier days folded.
@available(iOS 17.0, *)
struct AgentTranscriptTurns: View {
    let agent: AgentCoordinator
    let scrollSpace: String
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
                scrollSpace: scrollSpace
            )
            // A fresh model per conversation, and once a client appears.
            .id("\(sessionId)|\(context.loader != nil)")
        } else {
            ForEach(agent.turns) { turn in
                AgentTurnBubble(turn: turn)
                    .id(turn.id)
                    .pagingRowFrame(id: turn.id, in: scrollSpace)
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
    @State private var model: DailyBriefModel
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale

    init(
        conversationId: String,
        origin: ConversationOrigin,
        turns: [AgentTurn],
        context: DailyBriefContext,
        scrollSpace: String,
        model preset: DailyBriefModel? = nil
    ) {
        self.origin = origin
        self.turns = turns
        self.context = context
        self.scrollSpace = scrollSpace
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
                AgentTurnBubble(turn: briefTurn)
            }
            .id(briefTurn.id)
            .pagingRowFrame(id: briefTurn.id, in: scrollSpace)
        }
        DailyBriefFooter(
            day: brief.day,
            state: model.items[brief.day],
            isOpen: model.isFooterOpen(brief),
            // Not animated: the transcript follows its bottom by the content's size, and an
            // animated change in size is reported before the scroll view can reach the new end.
            onToggle: { model.toggleFooter(brief) },
            onRetry: { Task { await model.retry(day: brief.day) } }
        )
        .task(id: brief.day) { await model.load(day: brief.day) }
        ForEach(day.turns.dropFirst()) { turn in
            bubble(turn)
        }
    }

    private func bubble(_ turn: AgentTurn) -> some View {
        AgentTurnBubble(turn: turn)
            .id(turn.id)
            .pagingRowFrame(id: turn.id, in: scrollSpace)
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

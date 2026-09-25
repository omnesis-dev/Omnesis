// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import Observation
import SwiftUI
import WatchKit

/// The Apple Watch companion app. It carries the "Ask Omnesis" and
/// "Omnesis note" App Shortcuts so watch Siri recognises those phrases,
/// and — because Siri hands over as soon as the intent opens the app — it
/// presents the result itself. Its two complications open it at a link that
/// starts dictation for their flow. Activating the WatchConnectivity session
/// at launch means the relay is ready by the time the question or note
/// arrives.
@main
struct OmnesisWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase

    init() {
        WatchLink.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { WatchDictation.appDidEnterBackground() }
                }
                .onOpenURL { url in
                    guard let complication = WatchComplication(url: url) else { return }
                    Task { await WatchDictation.start(complication) }
                }
            #if DEBUG
                .watchDemoAutoPilot()
            #endif
        }
    }
}

/// Chooses which flow the watch is showing. A Siri ask or note, a
/// complication and a dictate button all set the screen before submitting,
/// so the right surface is up by the time its relay begins. Defaults to the ask flow (the app's
/// standing hint) when nothing has been invoked.
@MainActor
@Observable
final class WatchPresenter {
    static let shared = WatchPresenter()

    enum Screen {
        case ask
        case note
    }

    var screen: Screen = .ask
}

/// Top-level switch between the ask and note capture flows.
struct WatchRootView: View {
    private var presenter = WatchPresenter.shared

    var body: some View {
        switch presenter.screen {
        case .ask:
            WatchAskView()
        case .note:
            WatchNoteView()
        }
    }
}

/// Renders the current ask: a standing hint before anything is asked, a live
/// progress state while the phone works, then the answer — read aloud and
/// highlighted word by word as it is spoken.
struct WatchAskView: View {
    private var router = WatchAskRouter.shared
    private var speaker = WatchSpeaker.shared

    /// The dictate button and Siri hint are suppressed for a beat after
    /// launch. A Siri ask or a complication tap opens this app and moves on
    /// within moments, and flashing an invitation to ask at someone who just
    /// did exactly that reads as a glitch.
    @State private var hintVisible = false

    /// How long the hint waits before appearing. Long enough for a Siri ask to
    /// land, short enough that someone opening the app by hand is not left
    /// staring at a bare icon.
    private static let hintDelay = Duration.milliseconds(500)

    var body: some View {
        // The ask state manages its own scrolling: its status line is anchored
        // to the foot of the screen, and a scroll view wrapped around the whole
        // thing would size to its content and drag that anchor up under the
        // question. The other two states are a single scrolling column.
        switch router.state {
        case .idle:
            ScrollView { idle }
        case .asking(let question, _):
            asking(question: question)
        case .answered(let text, let kind, let statusTitle):
            ScrollView { answered(text: text, kind: kind, statusTitle: statusTitle) }
        }
    }

    // MARK: - States

    private var idle: some View {
        VStack(spacing: 10) {
            Image(systemName: "questionmark.bubble")
                .font(.system(size: 34))
                .foregroundStyle(.tint)
            Text("Ask Omnesis")
                .font(.headline)
            if hintVisible {
                dictateButton("Ask")
                    .transition(.opacity)
                Text("Or say \u{201C}Ask Omnesis\u{201D} to Siri.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
        }
        .padding()
        .task {
            try? await Task.sleep(for: Self.hintDelay)
            withAnimation { hintVisible = true }
        }
    }

    /// The question, and one line saying what is happening to it. Nothing
    /// else: a wrist glanced at mid-turn needs to know the ask is alive and
    /// what step it is on, and every further row of detail competes with the
    /// question for a screen that fits one thought.
    private func asking(question: String) -> some View {
        VStack(spacing: 12) {
            questionArea(question)
            // The status line is inset less than the question: it is one
            // unbroken line, and every point of width it gives up is a point
            // closer to dropping its count.
            statusLine(router.activity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical)
        .padding(.horizontal, 2)
    }

    /// The question, centred on the screen — or scrolling, when it is too long
    /// to be. Dictation has no length limit, and a question that overran the
    /// screen would otherwise be clipped with no way to read the rest of it
    /// for the whole wait.
    private func questionArea(_ text: String) -> some View {
        ViewThatFits(in: .vertical) {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                questionText(text)
                Spacer(minLength: 0)
            }
            ScrollView { questionText(text) }
        }
    }

    private func questionText(_ text: String) -> some View {
        Text(text)
            .font(.body)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 8)
    }

    /// The status line. It never wraps and never truncates, in that order of
    /// preference: the full line if it fits, otherwise the step on its own
    /// (the count is the part you can lose and still know what is happening),
    /// and only then a slight shrink. A half-word is worse than a small word,
    /// and both are worse than one honest clause.
    private func statusLine(_ activity: SiriAskActivitySnapshot?) -> some View {
        let activity = activity ?? SiriAskActivitySnapshot(label: SiriAskActivity.fallbackLabel)
        // The whole row is what has to fit, dots included — fitting the text
        // alone would measure it against a width the dots have already taken
        // a bite out of.
        return ViewThatFits(in: .horizontal) {
            statusRow(activity.line)
            statusRow(activity.label)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(activity.line)
    }

    private func statusRow(_ text: String) -> some View {
        HStack(spacing: 6) {
            WatchThinkingDots()
            Text(text)
                .font(.caption2)
                .foregroundStyle(.tint)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .contentTransition(.opacity)
        }
    }

    /// The settled ask: the answer alone. The question has served its purpose
    /// by the time its answer is on screen and being read aloud — repeating
    /// it costs the answer room it needs more.
    private func answered(text: String, kind: SiriAskOutcome.Kind, statusTitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            outcomeHeader(kind, statusTitle: statusTitle)
            Text(readAlong(text))
                .font(.body)
                .multilineTextAlignment(.leading)
            HStack {
                speechControls
                Spacer()
                // A settled answer is where the app stays until it is next
                // used, so the next question must be one tap from it.
                dictateButton("Ask again")
                    .labelStyle(.iconOnly)
                    .font(.caption2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }

    /// Opens dictation for a new question — the in-app twin of the Ask
    /// complication.
    private func dictateButton(_ title: LocalizedStringKey) -> some View {
        Button {
            Task { await WatchDictation.start(.ask) }
        } label: {
            Label(title, systemImage: "mic.fill")
        }
        .buttonStyle(.bordered)
    }

    /// What the screen is showing, when it is not simply the answer. An answer
    /// needs no label — it is the thing that was asked for. The other two
    /// outcomes do: a problem must not read like an answer, and neither must
    /// a turn that is still running somewhere else.
    @ViewBuilder
    private func outcomeHeader(_ kind: SiriAskOutcome.Kind, statusTitle: String) -> some View {
        switch kind {
        case .answer:
            EmptyView()
        case .status:
            Label(statusTitle, systemImage: "clock")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .failure:
            Label("Couldn't answer", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(.orange)
        }
    }

    private var speechControls: some View {
        Group {
            if speaker.isSpeaking {
                Button {
                    speaker.stop()
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
            } else {
                Button {
                    speaker.replay()
                } label: {
                    Label("Replay", systemImage: "speaker.wave.2.fill")
                }
            }
        }
        .font(.caption2)
        .buttonStyle(.bordered)
        .labelStyle(.iconOnly)
    }

    // MARK: - Read-along

    /// The answer with everything spoken so far at full strength and the rest
    /// dimmed, so the text tracks the voice instead of sitting there as a
    /// block while audio plays independently.
    private func readAlong(_ text: String) -> AttributedString {
        guard speaker.text == text, speaker.spokenUpTo > 0,
              let split = SiriAskReadAlong.split(of: text, spokenUTF16: speaker.spokenUpTo)
        else {
            // Not the utterance being spoken, or nothing spoken yet — show it
            // plainly rather than dimming the whole answer.
            var plain = AttributedString(text)
            plain.foregroundColor = .primary
            return plain
        }
        var spoken = AttributedString(String(text[..<split]))
        spoken.foregroundColor = .primary
        var pending = AttributedString(String(text[split...]))
        pending.foregroundColor = .secondary
        return spoken + pending
    }
}

/// Three accent dots that bounce in a staggered wave — the "still working"
/// signal beside the status phrase. Deliberately the same motion as the
/// iPhone's `AgentThinkingDots` and the portal's `.agent-thinking-dots`, so
/// waiting on Omnesis looks the same on every surface. It carries its own
/// copy because the phone's lives behind UIKit, which watchOS has no part of.
private struct WatchThinkingDots: View {
    @State private var animating = false

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0 ..< 3, id: \.self) { index in
                Circle()
                    .fill(.tint)
                    .frame(width: 3, height: 3)
                    .opacity(animating ? 1.0 : 0.25)
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
        .accessibilityHidden(true)
    }
}

// The preview harness stages state through `WatchAskRouter`'s debug-only
// entry points, so it compiles only where those exist. `#Preview` itself is
// built in every configuration — without this gate a release archive fails.
#if DEBUG
#Preview("Idle") {
    WatchAskPreview()
}

#Preview("Asking") {
    WatchAskPreview(
        question: "Did I book the ferry for the coast trip?",
        activity: SiriAskActivitySnapshot(label: "Searching…", detail: "12 found")
    )
}

#Preview("Asking — longest line") {
    WatchAskPreview(
        question: "What did the studio quote for the kitchen refit?",
        activity: SiriAskActivitySnapshot(label: "Checking reminders…", detail: "148 found")
    )
}

#Preview("Asking — long question") {
    WatchAskPreview(
        question: "What did the studio quote for the kitchen refit, including the appliances "
            + "and the delivery dates they promised for each of them?",
        activity: SiriAskActivitySnapshot(label: "Reading…", detail: "3 read")
    )
}

#Preview("Answered") {
    WatchAskPreview(
        answered: .answered(
            text: "Yes — the ferry is booked for Friday at 09:40, and the confirmation is in your inbox."
        )
    )
}

#Preview("Still working") {
    WatchAskPreview(answered: .stillWorking)
}

#Preview("Waking iPhone") {
    WatchAskPreview(
        question: "When is the ferry on Friday?",
        activity: SiriAskActivitySnapshot(label: SiriAskActivity.wakingPhoneLabel)
    )
}

#Preview("Queued for iPhone") {
    WatchAskPreview(answered: .queuedForPhone)
}

#Preview("Failed") {
    WatchAskPreview(answered: .phoneUnreachable)
}

/// Drives `WatchAskView` into one state for a preview. The view reads the
/// shared router, so a state is staged on that router rather than injected —
/// which means a preview shows exactly what a real ask puts on screen. Every
/// preview resets first: one router serves them all, and a stale state from
/// the last one would otherwise show through.
private struct WatchAskPreview: View {
    let question: String?
    let activity: SiriAskActivitySnapshot?
    let answered: SiriAskOutcome?

    init() {
        question = nil
        activity = nil
        answered = nil
    }

    init(question: String, activity: SiriAskActivitySnapshot?) {
        self.question = question
        self.activity = activity
        answered = nil
    }

    init(answered: SiriAskOutcome) {
        question = nil
        activity = nil
        self.answered = answered
    }

    var body: some View {
        WatchAskView()
            .onAppear {
                WatchAskRouter.shared.reset()
                if let question {
                    WatchAskRouter.shared.stage(question: question, activity: activity)
                }
                if let answered {
                    WatchAskRouter.shared.answered(outcome: answered)
                }
            }
    }
}
#endif
#endif

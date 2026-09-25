// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import Observation
import SwiftUI
import WatchKit

/// Carries one watch note from dictated text to a saved confirmation.
/// Mirrors `WatchAskRouter`: the intent hands the note here and returns
/// at once (relaying in the intent would hold Siri open past the point it
/// hands over), and the router owns the wait — never a view, which the ask
/// flow can replace mid-relay — then shows and speaks the outcome on the
/// wrist. A relay is cancelled only when a newer note replaces it.
@MainActor
@Observable
final class WatchNoteRouter {
    static let shared = WatchNoteRouter()

    enum State: Equatable {
        case idle
        /// `startedAt` drives the elapsed counter so a slow relay reads as
        /// working, not hung.
        case relaying(text: String, captureTime: NoteCaptureTime, startedAt: Date)
        case done(text: String, outcome: WatchNoteOutcome)
    }

    private(set) var state: State = .idle

    /// True once the first send found the iPhone app unreachable and the
    /// watch is retrying while iOS launches it.
    private(set) var isWakingPhone = false

    /// The relay in flight, cancelled when a newer note replaces it.
    private var relay: Task<Void, Never>?

    func submit(text: String) {
        let now = Date()
        let captureTime = NoteCaptureTime.now(date: now)
        state = .relaying(text: text, captureTime: captureTime, startedAt: now)
        isWakingPhone = false
        relay?.cancel()
        relay = Task {
            let outcome = await WatchLink.shared.relayNote(text: text, captureTime: captureTime)
            // A newer note owns the screen now; committing this one would
            // overwrite it and buzz for a note already gone.
            guard !Task.isCancelled else { return }
            done(text: text, outcome: outcome)
            WKInterfaceDevice.current().play(Self.haptic(for: outcome.kind))
            // Everything is spoken, failures included — the point is not
            // having to look at the wrist.
            WatchSpeaker.shared.speak(WatchNoteDialog.text(for: outcome))
        }
    }

    func wakingPhone() {
        guard case .relaying = state else { return }
        isWakingPhone = true
    }

    #if DEBUG
    /// Put the screen into a relaying or settled state for a preview without
    /// starting a relay — only `submit` relays.
    func stage(text: String, wakingPhone: Bool = false, outcome: WatchNoteOutcome? = nil) {
        relay?.cancel()
        relay = nil
        if let outcome {
            state = .done(text: text, outcome: outcome)
        } else {
            state = .relaying(text: text, captureTime: .now(), startedAt: Date())
        }
        isWakingPhone = wakingPhone
    }

    /// Return to the standing hint. Previews and the screenshot lane share
    /// one router, so each must start from a known state.
    func reset() {
        relay?.cancel()
        relay = nil
        state = .idle
        isWakingPhone = false
    }
    #endif

    func done(text: String, outcome: WatchNoteOutcome) {
        state = .done(text: text, outcome: outcome)
    }

    private static func haptic(for kind: WatchNoteOutcome.Kind) -> WKHapticType {
        switch kind {
        case .success: .success
        case .status: .notification
        case .failure: .failure
        }
    }
}

/// Renders the current note capture: a standing hint before anything is
/// captured, a live relay state while the phone saves, then the outcome —
/// spoken aloud, because the wrist is often down through the wait.
struct WatchNoteView: View {
    private var router = WatchNoteRouter.shared

    var body: some View {
        ScrollView {
            switch router.state {
            case .idle:
                idle
            case .relaying(let text, _, let startedAt):
                relaying(text: text, startedAt: startedAt)
            case .done(let text, let outcome):
                done(text: text, outcome: outcome)
            }
        }
    }

    // MARK: - States

    private var idle: some View {
        VStack(spacing: 10) {
            Image(systemName: "mic.badge.plus")
                .font(.system(size: 34))
                .foregroundStyle(.tint)
            Text("Omnesis note")
                .font(.headline)
            dictateButton("Dictate")
            Text("Or say \u{201C}Omnesis note\u{201D} to Siri.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
    }

    private func relaying(text: String, startedAt: Date) -> some View {
        VStack(spacing: 10) {
            ProgressView()
            Text(router.isWakingPhone ? SiriAskActivity.wakingPhoneLabel : "Saving note…")
                .font(.caption)
                .foregroundStyle(.tint)
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                Text(elapsed(from: startedAt, to: context.date))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Text(text)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
    }

    private func done(text: String, outcome: WatchNoteOutcome) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            header(for: outcome)
            Text(text)
                .font(.body)
                .multilineTextAlignment(.leading)
            // A finished note is where the app stays until it is next used,
            // so the next note must be one tap from it.
            dictateButton("New note")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }

    /// Opens dictation for a new note — the in-app twin of the note
    /// complication.
    private func dictateButton(_ title: LocalizedStringKey) -> some View {
        Button {
            Task { await WatchDictation.start(.note) }
        } label: {
            Label(title, systemImage: "mic.fill")
        }
        .buttonStyle(.bordered)
    }

    @ViewBuilder
    private func header(for outcome: WatchNoteOutcome) -> some View {
        switch outcome.kind {
        case .success:
            Label("Noted", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        case .status where outcome == .queuedForPhone:
            // Held on the watch for the iPhone, not yet saved anywhere.
            Label("Queued for iPhone", systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .status:
            Label("Saved on iPhone", systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .failure:
            Label("Couldn't save", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        }
    }

    private func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return "\(seconds)s"
    }
}

#Preview("Idle") {
    WatchNoteView()
}

#if DEBUG
#Preview("Waking iPhone") {
    WatchNoteView()
        .onAppear { WatchNoteRouter.shared.stage(text: "Pick up the bike on Saturday", wakingPhone: true) }
}

#Preview("Saved") {
    WatchNoteView()
        .onAppear { WatchNoteRouter.shared.stage(text: "Pick up the bike on Saturday", outcome: .saved) }
}

#Preview("Queued for iPhone") {
    WatchNoteView()
        .onAppear { WatchNoteRouter.shared.stage(text: "Pick up the bike on Saturday", outcome: .queuedForPhone) }
}
#endif
#endif

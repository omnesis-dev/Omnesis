// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import WatchKit

/// Opens dictation for an ask or a note. While the iPhone reports gateway
/// dictation on, the watch records the words itself and hands the recording
/// to the phone (`WatchVoiceCapture`); otherwise — and whenever recording
/// cannot start — it opens the system dictation screen and hands what was
/// said to the flow's router, the same hand-off the Siri intents make.
///
/// WatchKit's text input controller goes straight to dictation, listening
/// at once, only when it is given no suggestions and plain input mode: a
/// suggestion list (even an empty one) or emoji mode shows the keyboard and
/// Scribble picker first. That screen is the system's own and needs no
/// permission from this app; recording for the gateway needs microphone
/// access, and falls back to the system screen without it.
@MainActor
enum WatchDictation {
    /// True while a dictation screen is up or about to be, so a second tap
    /// on a complication does not stack another one behind it. Cleared when
    /// the screen reports back, and when the app leaves the foreground —
    /// the system dismisses the screen then, and a report that never comes
    /// must not leave every later tap ignored.
    private static var presenting = false

    /// Tells a report from an earlier screen apart from the current one, so
    /// a late report cannot clear the flag a newer screen set.
    private static var generation = 0

    /// How long to wait for the app to have a visible interface to present
    /// from. A complication tap can cold-launch the app, and the link
    /// arrives before its first screen is up.
    private static let readyPolls = 50
    private static let readyInterval = Duration.milliseconds(100)

    static func start(_ complication: WatchComplication) async {
        guard !presenting else { return }
        presenting = true
        generation += 1
        let current = generation
        // The screen switches before dictation opens, so the flow the
        // words are for is what shows behind it and after it.
        switch complication {
        case .ask: WatchPresenter.shared.screen = .ask
        case .note: WatchPresenter.shared.screen = .note
        }
        // An answer still being read aloud would talk over the dictation.
        WatchSpeaker.shared.stop()

        if let limit = await WatchLink.shared.dictationGate()?.recordingLimit(now: Date()),
           await WatchVoiceCapture.shared.start(voiceKind(complication), limit: limit) {
            presenting = false
            return
        }

        guard let controller = await visibleController() else {
            presenting = false
            // Say so on the wrist rather than doing nothing: silence reads
            // as a tap that never registered.
            WKInterfaceDevice.current().play(.failure)
            return
        }
        controller.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) { results in
            let text = results?.compactMap(Self.string(from:)).first?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            Task { @MainActor in
                if current == generation { presenting = false }
                // Cancelling dictation leaves the flow's screen as it was.
                guard let text, !text.isEmpty else { return }
                submit(text, to: complication)
            }
        }
    }

    static func appDidEnterBackground() {
        presenting = false
        WatchVoiceCapture.shared.appDidEnterBackground()
    }

    private static func voiceKind(_ complication: WatchComplication) -> WatchVoiceKind {
        switch complication {
        case .ask: .ask
        case .note: .note
        }
    }

    private static func submit(_ text: String, to complication: WatchComplication) {
        switch complication {
        case .ask: WatchAskRouter.shared.submit(question: text)
        case .note: WatchNoteRouter.shared.submit(text: text)
        }
    }

    /// The interface controller hosting the app's SwiftUI scene, once the
    /// app is active and that scene is on screen.
    private static func visibleController() async -> WKInterfaceController? {
        for _ in 0 ..< readyPolls {
            let app = WKApplication.shared()
            if app.applicationState == .active, let controller = app.visibleInterfaceController {
                return controller
            }
            try? await Task.sleep(for: readyInterval)
        }
        return nil
    }

    /// Dictation results arrive as strings, or attributed strings on some
    /// systems.
    private nonisolated static func string(from result: Any) -> String? {
        if let string = result as? String { return string }
        if let attributed = result as? NSAttributedString { return attributed.string }
        return nil
    }
}
#endif

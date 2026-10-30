// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import WatchKit

/// Opens dictation for an ask or a note, and hands what was said to the
/// flow's router — the same hand-off the Siri intents make. A note is the
/// exception while the iPhone reports gateway dictation on: the watch records
/// it and hands the recording to the phone (`WatchVoiceCapture`), falling
/// back to dictation when recording cannot start.
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
        WatchComplicationCapture.shared.cancel()
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

        if complication == .note {
            let gate = await WatchLink.shared.dictationGate()
            guard current == generation else { return }
            if let limit = gate?.recordingLimit(now: Date()) {
                let started = await WatchVoiceCapture.shared.start(limit: limit)
                guard current == generation else { return }
                if started {
                    presenting = false
                    return
                }
            }
        }

        let controller = await visibleController()
        guard current == generation else { return }
        guard let controller else {
            presenting = false
            WKInterfaceDevice.current().play(.failure)
            return
        }
        controller.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) { results in
            let text = results?.compactMap(Self.string(from:)).first?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            Task { @MainActor in
                guard current == generation else { return }
                presenting = false
                // Cancelling dictation leaves the flow's screen as it was.
                guard let text, !text.isEmpty else { return }
                submit(text, to: complication)
            }
        }
    }

    /// A different entry point owns the microphone. Pending permission,
    /// activation and text-input callbacks cannot resurrect the old flow.
    static func cancelPending() {
        generation += 1
        if presenting { WKApplication.shared().visibleInterfaceController?.dismissTextInputController() }
        presenting = false
    }

    static func appDidEnterBackground() {
        generation += 1
        presenting = false
        WatchVoiceCapture.shared.appDidEnterBackground()
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

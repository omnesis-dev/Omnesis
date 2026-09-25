// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import AppIntents
import Foundation

/// "Ask Omnesis <question>" on the Apple Watch. App Shortcut phrases are
/// registered per-device from the apps installed on that device, so a
/// watchOS app is required for Siri on the watch to recognise the phrase
/// at all — an iPhone-only App Shortcut never reaches watch Siri.
///
/// The watch carries no gateway pairing: this intent dictates the question and
/// hands it to `WatchAskRouter`, which relays it to the paired iPhone and
/// presents the reply. All the real work — session creation, the agent turn,
/// continuity, the slow-answer push — happens on the phone through the shared
/// `SiriAskRunner`, so the two surfaces answer identically.
///
/// The answer is delivered by the app, not by Siri: reaching the phone requires
/// foregrounding this app, and doing so ends Siri's session well before an
/// agent turn settles.
struct AskOmnesisIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Omnesis"
    /// Apple rejects (ITMS-90626) any App Intent description containing a
    /// device marketing name like "iPhone", so this stays device-name-free.
    static let description = IntentDescription(
        "Ask your Omnesis brain a question and hear the answer, spoken back to you."
    )
    /// Unlike the iPhone intent, this one foregrounds its app. WatchConnectivity
    /// interactive messaging (`sendMessage`, the only mode that can carry a
    /// reply back for Siri to speak) requires `WCSession.isReachable`, and on
    /// watchOS that is only true while the watch app is in the foreground. Run
    /// in the background and every relay fails with an unreachable phone that is
    /// sitting right there. The app opening briefly is the cost of hearing the
    /// answer on the wrist.
    static var openAppWhenRun: Bool {
        true
    }

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask?")
    var question: String

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $question.needsValueError("What would you like to ask?")
        }
        // Hand the question to the app and return at once. Relaying here would
        // hold Siri open for the whole agent turn, which it will not wait for:
        // opening the app already ended Siri's session. `WatchAskRouter` runs
        // the relay and the app shows and speaks the answer when it lands.
        // Select the ask screen (symmetric to the note intent) so the root
        // view renders `WatchAskView` — the only view whose `.task` performs
        // the relay — even after a prior note left the presenter on `.note`.
        await MainActor.run {
            WatchPresenter.shared.screen = .ask
            WatchAskRouter.shared.submit(question: trimmed)
        }
        return .result(dialog: "On it.")
    }
}

/// System-registered Siri phrases for the watch app. Mirrors the iPhone's
/// "Ask Omnesis" phrase set (see `OmnesisAppShortcuts`) so the same
/// utterance works on either device. The phrase can only run the intent
/// and let Siri ask the question as an immediate follow-up — App Shortcut
/// phrases can't interpolate a free-form `String` parameter from the
/// initial utterance (an OS limitation, not ours).
struct OmnesisWatchAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskOmnesisIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "\(.applicationName) question",
                "Question for \(.applicationName)",
            ],
            shortTitle: "Ask Omnesis",
            systemImageName: "questionmark.bubble"
        )
        AppShortcut(
            intent: CaptureNoteIntent(),
            phrases: [
                "\(.applicationName) note",
                "\(.applicationName) capture",
                "New note in \(.applicationName)",
                "Capture a note in \(.applicationName)",
            ],
            shortTitle: "Omnesis note",
            systemImageName: "mic.badge.plus"
        )
    }
}
#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import AppIntents
import Foundation

/// "Tell Omnesis <something>" — capture a note by voice or from a
/// Shortcut, entirely in the background: no app open, no UI. Runs
/// in-process (app-target intents launch the app in the background when
/// it isn't running), posts to the gateway, and falls back to the
/// durable pending queue when the gateway is unreachable — so a note
/// spoken to Siri on the subway still lands once the phone finds the
/// gateway again.
public struct CaptureNoteIntent: AppIntent {
    public static let title: LocalizedStringResource = "Tell Omnesis"
    public static let description = IntentDescription(
        "Save a quick note into your Omnesis brain. Notes are kept on-device until your gateway is reachable."
    )
    // Background by default: openAppWhenRun stays false.

    @Parameter(title: "Note", requestValueDialog: "What should I remember?")
    public var text: String

    public init() {}

    public init(text: String) {
        self.text = text
    }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $text.needsValueError("What should I remember?")
        }
        // Best-effort location, resolved here (an iOS-only concern) so the
        // pure capture service stays free of CoreLocation. This runs in the
        // background with no UI, so it never prompts — an undetermined
        // permission just yields a note with no location.
        let captureTime = NoteCaptureTime.now()
        let location = await NoteLocationProvider.shared.current(promptIfNeeded: false)
        let outcome = await NoteCaptureService.captureStandalone(
            text: trimmed,
            surface: .siri,
            captureTime: captureTime,
            location: location
        )
        switch outcome {
        case .saved:
            return .result(dialog: "Noted.")
        case .queued(.unreachable):
            return .result(dialog: "Noted — it will sync when your gateway is reachable.")
        case .queued(.featureOff):
            return .result(dialog: "Noted — saved on this device. Update your gateway to sync.")
        case .queued(.unauthorized):
            return .result(dialog: "Noted — saved on this device. Re-pair with your gateway to sync.")
        case .rejected(let reason):
            return .result(dialog: "Sorry, I couldn't save that note. \(reason)")
        case .failed:
            return .result(dialog: "Sorry, I couldn't save that note.")
        }
    }
}

/// System-registered Siri phrases. Installed automatically (no app
/// launch required — App Shortcuts are extracted at install time).
///
/// Phrases lead with the app name (or "Ask", which Siri treats as an
/// app-directed question) so Siri routes to this app rather than a
/// system intent. Phrases must not start with a hijacking system verb:
/// "Tell …" / "Text …" / "Message …" are Siri's send-a-message
/// commands and hijack "Tell Omnesis" into messaging a contact/group
/// named "Omnesis"; a leading bare "Note …" is grabbed by Apple Notes.
///
/// Siri phrase limitation, stated honestly: App Shortcut phrases can
/// only interpolate parameters with a *fixed* value set (AppEnum /
/// AppEntity), never a free-form `String` — so "Hey Siri, Omnesis note
/// buy milk" cannot capture "buy milk" from the initial utterance, and
/// "Hey Siri, ask Omnesis what's on today" cannot capture the question.
/// The phrase runs the intent, and Siri asks the parameter's
/// `requestValueDialog` ("What should I remember?" / "What would you
/// like to ask?") as an immediate follow-up, keeping the flow
/// hands-free end to end.
public struct OmnesisAppShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
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
    }
}
#endif

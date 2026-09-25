// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import AppIntents
import Foundation

/// "Omnesis note <text>" on the Apple Watch. App Shortcut phrases are
/// registered per-device from the apps installed on that device, so a
/// watchOS app is required for Siri on the watch to recognise the phrase
/// at all — an iPhone-only App Shortcut never reaches watch Siri.
///
/// The watch carries no gateway pairing: this intent dictates the note and
/// hands it to `WatchNoteRouter`, which relays it to the paired iPhone.
/// The iPhone saves it (attaching the phone's location) through the shared
/// `NoteCaptureService`, so a watch note is identical to one captured on
/// the phone.
struct CaptureNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "Omnesis note"
    /// Apple rejects (ITMS-90626) any App Intent description containing a
    /// device marketing name like "iPhone", so this stays device-name-free.
    static let description = IntentDescription(
        "Save a quick note into your Omnesis brain, dictated from your wrist."
    )
    /// Foregrounds its app, exactly like the watch ask intent: relaying a
    /// note over WatchConnectivity needs `WCSession.isReachable`, which on
    /// watchOS holds only while the watch app is foreground.
    static var openAppWhenRun: Bool {
        true
    }

    @Parameter(title: "Note", requestValueDialog: "What should I remember?")
    var text: String

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $text.needsValueError("What should I remember?")
        }
        // Hand the note to the app and return at once. Relaying here would
        // hold Siri open, which it will not wait for — opening the app
        // already ended Siri's session. The view runs the relay and speaks
        // the outcome when it lands.
        await MainActor.run {
            WatchPresenter.shared.screen = .note
            WatchNoteRouter.shared.submit(text: trimmed)
        }
        return .result(dialog: "On it.")
    }
}
#endif

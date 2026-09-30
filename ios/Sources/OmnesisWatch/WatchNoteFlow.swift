// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import Observation
import SwiftUI
import WatchKit

/// Carries one note dictated as text — on the system's dictation screen, or
/// through the "Omnesis note" Siri intent — to the watch's durable outbox,
/// fire and forget. The note counts as sent the moment it is safely there,
/// whatever the link to the iPhone is doing: the outbox hands it over, and
/// again until the phone confirms it (`WatchLink.flushOutbox`). So the note
/// ends like a recorded one: "Sent to your iPhone.", then back to the watch
/// face. The intent hands the note here and returns at once, since relaying
/// in the intent would hold Siri open past the point it hands over.
@MainActor
@Observable
final class WatchNoteRouter {
    static let shared = WatchNoteRouter()

    enum State: Equatable {
        case idle
        /// The note is in the outbox, on its way to the iPhone.
        case sent(text: String)
        /// The note could not be kept on the watch; its text stays on screen.
        case failed(text: String)
    }

    private(set) var state: State = .idle

    func submit(text: String) {
        let message = WatchNoteWire.request(text: text, captureTime: .now(), ref: UUID().uuidString)
        do {
            try WatchVoiceOutbox.shared.add(textNote: message)
        } catch {
            state = .failed(text: text)
            WKInterfaceDevice.current().play(.failure)
            return
        }
        state = .sent(text: text)
        let ref = WatchNoteWire.ref(from: message) ?? ""
        let carried = WatchLink.shared.flushOutbox(.linkMayHaveChanged).contains(ref)
        WatchVoiceCapture.shared.textNoteSent(carried: carried)
    }

    #if DEBUG
    /// Put the screen into a sent state for a preview without writing a note.
    func stage(sent text: String) {
        state = .sent(text: text)
    }

    /// Return to the standing hint. Previews and the screenshot lane share
    /// one router, so each must start from a known state.
    func reset() {
        state = .idle
    }
    #endif
}

/// The note screen: a standing hint before anything is captured, then the
/// last note and whether it is on its way.
struct WatchNoteView: View {
    private var router = WatchNoteRouter.shared

    var body: some View {
        ScrollView {
            switch router.state {
            case .idle:
                idle
            case .sent(let text):
                settled(text: text, sent: true)
            case .failed(let text):
                settled(text: text, sent: false)
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

    private func settled(text: String, sent: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if sent {
                Label("Sent to your iPhone", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Label("Couldn't save", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
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
}

#Preview("Idle") {
    WatchNoteView()
}

#if DEBUG
#Preview("Sent") {
    WatchNoteView()
        .onAppear { WatchNoteRouter.shared.stage(sent: "Pick up the bike on Saturday") }
}
#endif
#endif

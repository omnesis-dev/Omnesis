// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A recording that rides a note to the gateway for transcription
/// (experimental gateway dictation). The note is saved at once with the
/// phone's transcript and replaced by the gateway's when it is ready.
public struct NoteAudio: Equatable, Sendable {
    /// The recording. Whoever takes the note owns it: it is deleted once
    /// delivered or refused, or moved into the pending-note queue.
    public let file: URL
    /// The locale it was dictated in, such as `en_GB`.
    public let locale: String?

    public init(file: URL, locale: String?) {
        self.file = file
        self.locale = locale
    }
}

/// A Tell Omnesis capture while gateway transcription is on: a voice note.
///
/// The screen shows the recording — whether it is running, and how long it
/// is — never the phone's own transcript. A poor on-device transcript on
/// screen is what makes people give up on a note the gateway would have
/// transcribed well. That transcript is still kept, out of sight, as the
/// text the note carries until the gateway's replaces it, and the text the
/// note falls back to if the gateway cannot transcribe it.
///
/// A capture is either a voice note or a typed note. Discarding the
/// recording turns it back into an empty typed note. Pure, so the logic lane
/// covers every transition.
struct VoiceNoteCaptureState: Equatable {
    /// The phone's transcript of every run so far, never shown.
    private(set) var hiddenTranscript = ""
    /// `hiddenTranscript` when the current run started: a run's partials
    /// replace one another on top of it.
    private var runBase = ""
    /// Length of the runs already stopped.
    private(set) var recordedDuration: TimeInterval = 0
    /// When the running run started; nil between runs.
    private(set) var runStartedAt: Date?

    var isRecording: Bool {
        runStartedAt != nil
    }

    /// There is a recording to save or discard — running or stopped.
    var hasRecording: Bool {
        isRecording || recordedDuration > 0
    }

    /// Length of the recording so far, the running run included.
    func duration(at now: Date) -> TimeInterval {
        recordedDuration + (runStartedAt.map { max(0, now.timeIntervalSince($0)) } ?? 0)
    }

    /// A run started: record more, adding to the note.
    mutating func startRun(at now: Date) {
        guard !isRecording else { return }
        runBase = hiddenTranscript
        runStartedAt = now
    }

    /// The phone's recognizer heard `partial` in the current run — or its
    /// final result once the run has stopped.
    mutating func heard(_ partial: String) {
        hiddenTranscript = DictationTranscript.compose(base: runBase, partial: partial)
    }

    mutating func stopRun(at now: Date) {
        guard let runStartedAt else { return }
        recordedDuration += max(0, now.timeIntervalSince(runStartedAt))
        self.runStartedAt = nil
    }

    /// Throw the recording away; what follows is typed.
    mutating func discard() {
        self = VoiceNoteCaptureState()
    }

    /// `0:12`, `1:05` — the recording's length on screen.
    static func clock(_ duration: TimeInterval) -> String {
        let seconds = max(0, Int(duration))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// The recording's length for VoiceOver: "12 seconds", "1 minute 5 seconds".
    static func spokenDuration(_ duration: TimeInterval) -> String {
        let seconds = max(0, Int(duration))
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.allowedUnits = seconds >= 60 ? [.minute, .second] : [.second]
        return formatter.string(from: TimeInterval(seconds)) ?? "\(seconds) seconds"
    }
}

/// Delivers one note, with its recording when it has one.
///
/// A voice note goes to `POST /notes/voice`. A gateway that does not take
/// voice notes — older or not experimental (404), gateway dictation switched
/// off (409), no transcriber (503) or a recording over its limit (413) — gets
/// the note as plain text instead, and the recording is dropped. A voice note
/// with no text of its own cannot fall back: that is a refusal.
enum VoiceNoteDelivery {
    enum Delivered: Equatable {
        case voice
        case text
    }

    /// The gateway refused a voice note that has no text to fall back on.
    struct TextlessVoiceNoteRefused: Error, Equatable {}

    static let refusedMessage = "Couldn't save your voice note."

    /// Whether a `POST /notes/voice` failure means "send it as text".
    static func fallsBackToText(_ error: Error) -> Bool {
        switch error {
        case GatewayClient.Error.notFound:
            true
        case GatewayClient.Error.serverError(let status, _):
            status == 409 || status == 413 || status == 503
        default:
            false
        }
    }

    @discardableResult
    static func deliver(
        _ note: VoiceNoteUpload,
        audio: URL?,
        client: NotesClient,
        location: NoteLocation?
    ) async throws
        -> Delivered {
        if let audio, let data = try? Data(contentsOf: audio), !data.isEmpty {
            do {
                try await client.createVoiceNote(note, audio: data)
                return .voice
            } catch where fallsBackToText(error) {
                // Sent as text below.
            }
        }
        guard !note.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TextlessVoiceNoteRefused()
        }
        try await client.createNote(
            id: note.id,
            text: note.text,
            capturedAt: NotesTime.date(fromISO: note.capturedAt),
            capturedTimeZoneId: note.capturedTimeZoneId,
            capturedUtcOffsetSeconds: note.capturedUtcOffsetSeconds,
            surface: note.surface,
            deviceId: note.deviceId,
            location: location
        )
        return .text
    }
}

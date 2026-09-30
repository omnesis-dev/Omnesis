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

/// When a Tell Omnesis capture carries its recording. The recording covers
/// only what was dictated, and the gateway's transcript replaces the note's
/// whole text — so the audio goes only when the text being saved is exactly
/// what was dictated into it. A capture the person edited after dictating,
/// or typed into before a dictation run, is saved as the text they see.
enum VoiceNoteCapture {
    /// `dictatedText` is the text as dictation last left it;
    /// `recordingIncomplete` says some of it was never recorded.
    static func attachesAudio(savedText: String, dictatedText: String?, recordingIncomplete: Bool) -> Bool {
        guard !recordingIncomplete, let dictatedText else { return false }
        let saved = savedText.trimmingCharacters(in: .whitespacesAndNewlines)
        return !saved.isEmpty && saved == dictatedText.trimmingCharacters(in: .whitespacesAndNewlines)
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

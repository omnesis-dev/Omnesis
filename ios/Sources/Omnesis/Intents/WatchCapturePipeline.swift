// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

enum WatchCaptureNotice: Sendable {
    case delayed, expired, interruptedAsk
}

/// Processes only unified complication recordings. Retryable failures keep
/// the original audio on disk; successful note delivery transfers ownership
/// to the phone's durable note queue. No transcript goes back to the watch.
actor WatchCapturePipeline {
    struct Dependencies: Sendable {
        let gatewayDictation: @Sendable () async throws -> Bool
        let transcribeGateway: @Sendable (URL, String?) async throws -> String?
        let transcribeLocal: @Sendable (URL, String?) async -> String?
        let classify: @Sendable (String) async throws -> WatchCaptureRoute
        let saveNote: @Sendable (String, WatchVoiceRecording, NoteAudio?) async -> Bool
        let ask: @Sendable (String) async -> Void
        let notify: @Sendable (WatchCaptureNotice) async -> Void
        var resolved: @Sendable (WatchCaptureRoute) async -> Void = { _ in }
    }

    private var active: Set<String> = []

    func handle(_ original: WatchVoiceInbox.Item, inbox: WatchVoiceInbox, deps: Dependencies) async {
        var item = original
        guard let recording = WatchVoiceRecording(metadata: item.state.metadata),
              let requested = recording.route, UUID(uuidString: recording.ref) != nil
        else { inbox.discard(item)
            return
        }
        guard !active.contains(recording.ref) else { inbox.release(item)
            return
        }
        active.insert(recording.ref)
        defer { active.remove(recording.ref) }
        if inbox.wasCompleted(recording.ref) { inbox.discard(item)
            return
        }
        if Date().timeIntervalSince(recording.captureTime.capturedAt) > WatchOutboxPolicy.retention {
            await deps.notify(.expired)
            inbox.discard(item)
            return
        }
        do {
            // A crash during Ask's network hand-off has an ambiguous outcome.
            // Do not replay it and risk performing the same action twice.
            if item.state.askStarted == true {
                await deps.notify(.interruptedAsk)
                try inbox.complete(recording.ref)
                inbox.discard(item)
                return
            }
            let audio = inbox.audioURL(item.id)
            let gateway = try await deps.gatewayDictation()
            if requested == .note, gateway {
                await deps.resolved(.note)
                guard await deps.saveNote("", recording, NoteAudio(file: audio, locale: recording.locale)) else {
                    throw CocoaError(.fileWriteUnknown)
                }
            } else {
                let text = try await prepareTranscript(
                    &item,
                    recording: recording,
                    gateway: gateway,
                    inbox: inbox,
                    deps: deps
                )
                if item.state.captureRoute == nil {
                    item.state.captureRoute = requested == .automatic ? try await deps.classify(text) : requested
                    try inbox.save(item)
                }
                await deps.resolved(item.state.captureRoute ?? .ask)
                if item.state.captureRoute == .note {
                    guard await deps.saveNote(text, recording, nil) else { throw CocoaError(.fileWriteUnknown) }
                } else {
                    item.state.askStarted = true
                    try inbox.save(item)
                    await deps.ask(text)
                }
            }
            try inbox.complete(recording.ref)
            inbox.discard(item)
        } catch {
            // One delayed notice, while keeping the audio for a future retry.
            if item.state.failureNotified != true {
                item.state.failureNotified = true
                try? inbox.save(item)
                await deps.notify(.delayed)
            }
            inbox.release(item)
        }
    }

    private func prepareTranscript(
        _ item: inout WatchVoiceInbox.Item,
        recording: WatchVoiceRecording,
        gateway: Bool,
        inbox: WatchVoiceInbox,
        deps: Dependencies
    ) async throws
        -> String {
        if item.state.transcript == nil {
            let audio = inbox.audioURL(item.id)
            let transcript = gateway
                ? try await deps.transcribeGateway(audio, recording.locale)
                : await deps.transcribeLocal(audio, recording.locale)
            guard let text = transcript?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                throw CocoaError(.fileReadUnknown)
            }
            item.state.transcript = text
            try inbox.save(item)
        }
        return item.state.transcript ?? ""
    }
}

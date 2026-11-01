// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// External entry points share capture's microphone, editor and animation;
/// only their submit actions use the gateway's Ask/Tell classifier.
@available(iOS 17.0, *)
extension CaptureView {
    var micAccessibilityLabel: String {
        guard isVoiceNote else { return speech.isListening ? "Stop listening" : "Start listening" }
        if speech.isListening { return "Stop recording" }
        return voiceNote.hasRecording ? "Record more" : "Start recording"
    }

    /// Pause an underlying in-app draft while a system capture uses the mic.
    func suspendCapture() {
        keyboardFocused = false
        if speech.isListening { stopDictation() }
        speech.cancel()
        voiceNote.stopRun(at: Date())
    }

    private var automaticRouting: Bool {
        !routingFailed && store.statusSnapshot?.capture?.supported == true
            && store.statusSnapshot?.capture?.enabled == true
            && store.statusSnapshot?.capture?.active == true
    }

    var unifiedButtons: some View {
        HStack(spacing: Theme.Spacing.md) {
            if automaticRouting {
                unifiedButton("Send", route: .automatic)
            } else {
                unifiedButton("Ask", route: .ask)
                unifiedButton("Tell", route: .note)
            }
        }
        .accessibilityIdentifier("unifiedCaptureActions")
    }

    private func unifiedButton(_ title: String, route: WatchCaptureRoute) -> some View {
        Button {
            guard submissionTask == nil else { return }
            submissionTask = Task {
                defer { submissionTask = nil }
                await sendUnified(route)
            }
        } label: {
            HStack(spacing: 8) {
                if phase == .saving { ProgressView().tint(.white) }
                Text(title).font(.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Capsule().fill(canSave ? Theme.accent : Theme.accent.opacity(0.35)))
        }
        .disabled(!canSave)
        .accessibilityIdentifier("capture" + title + "Button")
    }

    /// Resolve the transcript before classifying; a gate failure preserves the
    /// input and offers the two explicit actions, never guesses a destination.
    private func sendUnified(_ requested: WatchCaptureRoute) async {
        guard canSave, !Task.isCancelled else { return }
        if requested == .note, isVoiceNote, voiceNote.hasRecording || preparedAudio != nil {
            await sendRecordedNote()
            return
        }
        if speech.isListening { stopDictation() }
        keyboardFocused = false
        phase = .saving
        saveError = nil
        var captured = isVoiceNote && voiceNote.hasRecording ? voiceNote.hiddenTranscript : text
        if isVoiceNote, voiceNote.hasRecording, preparedAudio == nil {
            voiceNote.stopRun(at: Date())
            preparedAudio = recording?.finish()
            recording = nil
            speech.audioSink = nil
            if preparedAudio == nil { useTranscript(captured) }
        }
        do {
            let pairing = store.pairing
            let client = pairing.map {
                WatchCaptureClient(baseURL: $0.url, token: $0.token, phoneCapture: true)
            }
            if let audio = preparedAudio {
                guard let client,
                      let transcript = try await client.transcribe(
                          audio,
                          locale: Locale.current.identifier,
                          legacyGateway: store.statusSnapshot?.capture?.supported != true
                      ),
                      !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw GatewayClient.Error.invalidResponse
                }
                try Task.checkCancellation()
                captured = transcript
                useTranscript(transcript)
            }
            guard !captured.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                phase = .capturing
                saveError = "No speech was captured. Try speaking again or type your input."
                return
            }
            let route: WatchCaptureRoute
            if requested == .automatic {
                guard let client else { throw GatewayClient.Error.invalidResponse }
                route = try await client.route(captured)
            } else { route = requested }
            try Task.checkCancellation()
            guard store.pairing == pairing else { throw GatewayClient.Error.invalidResponse }
            switch route {
            case .ask:
                // The shell hands this text to the ordinary chat coordinator,
                // whose draft and retry UI retain it if submission fails.
                onAsk?(captured)
            case .note:
                let outcome = await store.notes.save(text: captured, surface: surface, captureTime: .now())
                await settle(outcome)
            case .automatic:
                throw GatewayClient.Error.invalidResponse
            }
        } catch {
            guard !Task.isCancelled else { return }
            phase = .capturing
            routingFailed = true
            saveError = preparedAudio == nil
                ? "Couldn’t choose Ask or Tell. Choose how to send, or try again later."
                : "Couldn’t process the recording. Try again when your gateway is reachable, or discard it and type."
        }
    }

    /// An unusable recording leaves the complete on-device transcript editable.
    private func useTranscript(_ transcript: String) {
        text = transcript
        discardRecording()
        voiceNoteLimit = nil
    }

    /// Explicit Tell hands the recording straight to durable note delivery.
    private func sendRecordedNote() async {
        guard let audio = preparedAudio else {
            await saveVoiceNote()
            return
        }
        preparedAudio = nil
        phase = .saving
        let outcome = await store.notes.save(
            text: voiceNote.hiddenTranscript,
            surface: surface,
            captureTime: .now(),
            audio: NoteAudio(file: audio, locale: Locale.current.identifier)
        )
        if case .rejected = outcome { voiceNote.discard() }
        if case .failed = outcome { voiceNote.discard() }
        await settle(outcome)
    }
}

#if DEBUG
extension VoiceNoteCaptureState {
    /// A voice note recording for `seconds` so far, for previews.
    static func previewRecording(seconds: TimeInterval) -> VoiceNoteCaptureState {
        var state = VoiceNoteCaptureState()
        state.startRun(at: Date().addingTimeInterval(-seconds))
        state.heard("Not shown on screen")
        return state
    }

    /// A stopped voice note `seconds` long, for previews.
    static func previewRecorded(seconds: TimeInterval) -> VoiceNoteCaptureState {
        var state = VoiceNoteCaptureState()
        let start = Date().addingTimeInterval(-seconds - 5)
        state.startRun(at: start)
        state.heard("Not shown on screen")
        state.stopRun(at: start.addingTimeInterval(seconds))
        return state
    }
}

@available(iOS 17.0, *)
#Preview("Voice entry — automatic") {
    CaptureView(unified: true, speech: .preview(state: .listening), previewText: PreviewMocks.voiceEntryText)
        .environment(AppStore.preview(statusSnapshot: PreviewMocks.voiceEntryAutomaticStatus))
}

@available(iOS 17.0, *)
#Preview("Voice entry — manual") {
    CaptureView(unified: true, speech: .preview(state: .listening))
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Voice entry — unavailable") {
    CaptureView(unified: true, speech: .preview(state: .unavailable))
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Voice entry — routing failure") {
    CaptureView(
        unified: true,
        speech: .preview(state: .idle),
        previewText: PreviewMocks.voiceEntryText,
        previewSaveError: "Couldn’t choose Ask or Tell. Choose how to send, or try again later.",
        previewRoutingFailed: true
    )
    .environment(AppStore.preview(statusSnapshot: PreviewMocks.voiceEntryAutomaticStatus))
}

#endif
#endif

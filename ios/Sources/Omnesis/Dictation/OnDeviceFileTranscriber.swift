// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(Speech) && os(iOS)
import Foundation
import Speech

/// Transcribes a recording file with the iPhone's own speech recognizer —
/// the fallback for a watch recording the gateway could not transcribe.
/// Only on-device recognition is used: a recording the gateway was meant to
/// transcribe never goes to Apple's service, so a language without an
/// on-device model yields nil. Never prompts: it runs in the background, so it
/// uses speech recognition only when already allowed.
enum OnDeviceFileTranscriber {
    /// Longest a transcription may take before it is abandoned. A watch
    /// recording is at most two minutes, which recognizes in far less.
    static let timeout: Duration = .seconds(45)

    /// `locale` is the recording's locale identifier, such as `en_GB`.
    static func transcribe(_ audio: URL, locale: String?) async -> String? {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              let recognizer = recognizer(for: locale), recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition
        else { return nil }
        let request = SFSpeechURLRecognitionRequest(url: audio)
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = true
        let recognition = Recognition()
        return await withCheckedContinuation { continuation in
            recognition.start(continuation)
            // The recognizer and its task are held by `recognition` until it
            // resolves, so neither is released mid-transcription.
            let task = recognizer.recognitionTask(with: request) { result, error in
                if error != nil {
                    recognition.resolve(nil)
                } else if let result, result.isFinal {
                    recognition.resolve(result.bestTranscription.formattedString)
                }
            }
            recognition.hold(task, of: recognizer)
            Task {
                try? await Task.sleep(for: timeout)
                recognition.resolve(nil)
            }
        }
    }

    /// The recognizer for the recording's locale, or the device's own when
    /// there is none for it.
    private static func recognizer(for locale: String?) -> SFSpeechRecognizer? {
        if let locale, let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) {
            return recognizer
        }
        return SFSpeechRecognizer(locale: Locale.current)
    }
}

/// One transcription in flight: resolves its continuation once — the
/// recognizer can report an error after a final result, and the timeout can
/// race both — and keeps the recognizer and its task alive until then.
private final class Recognition: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String?, Never>?
    private var recognizer: SFSpeechRecognizer?
    private var task: SFSpeechRecognitionTask?

    func start(_ continuation: CheckedContinuation<String?, Never>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    /// Keep the task and its recognizer until the transcription resolves,
    /// or cancel the task at once when it already has.
    func hold(_ task: SFSpeechRecognitionTask, of recognizer: SFSpeechRecognizer) {
        lock.lock()
        let resolved = continuation == nil
        if !resolved {
            self.task = task
            self.recognizer = recognizer
        }
        lock.unlock()
        if resolved { task.cancel() }
    }

    func resolve(_ value: String?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        let task = task
        self.task = nil
        recognizer = nil
        lock.unlock()
        guard let pending else { return }
        if value == nil { task?.cancel() }
        pending.resume(returning: value)
    }
}
#endif

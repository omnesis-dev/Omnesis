// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(Speech) && canImport(UIKit)
import AVFoundation
import Speech
import SwiftUI

/// Wraps iOS on-device speech recognition into an `@Observable` class
/// that the agent composer can drive. Manages the full lifecycle:
/// permission requests, audio session configuration, and streaming
/// transcription via `SFSpeechAudioBufferRecognitionRequest`.
@available(iOS 17.0, *)
@Observable
final class SpeechRecognizer {
    // MARK: - Public state

    enum State: Equatable {
        /// Idle — mic button shows the default microphone icon.
        case idle
        /// Actively listening — mic button pulses, waveform animates.
        case listening
        /// The recognizer is finishing up after the user stopped.
        case finishing
        /// Permission was denied or the device lacks speech support.
        case unavailable
    }

    private(set) var state: State = .idle
    /// Live transcript updated as the user speaks.
    private(set) var transcript: String = ""

    var isListening: Bool {
        state == .listening
    }

    // MARK: - Private

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale.current)
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    // MARK: - Lifecycle

    #if DEBUG
    /// Snapshot rendering must not request live microphone or speech access.
    /// The snapshot suite scopes this override and restores its previous value.
    static var permissionRequestsDisabledForSnapshots = false
    #endif

    /// Request microphone + speech-recognition permissions. Call once
    /// early (e.g. when the mic button first appears) so the system
    /// prompt fires before the user tries to speak.
    func requestPermissionsIfNeeded() {
        #if DEBUG
        if Self.permissionRequestsDisabledForSnapshots { return }
        // Demo automation: skip the mic + speech-recognition prompts so the
        // system TCC alert never appears over a screen recording. The agent
        // composer is on screen from the first frame of a recorded demo, and
        // the replayed conversation needs neither input. Push registration is
        // skipped under the same flag in `AppStore.requestPushAndRegister()`.
        if ProcessInfo.processInfo.environment["DEMO_AUTO_SEND"] != nil {
            state = .unavailable
            return
        }
        #endif
        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            DispatchQueue.main.async {
                if authStatus != .authorized {
                    self?.state = .unavailable
                }
            }
        }
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                if !granted {
                    self?.state = .unavailable
                }
            }
        }
    }

    /// Request permissions and start listening as soon as they resolve.
    /// Used by the quick-capture surface, which listens immediately on
    /// appear: calling `startListening()` before the system prompts
    /// resolve would see `.notDetermined` and latch the sticky
    /// `.unavailable` state, so the start is chained onto the grants
    /// instead. No-ops (grant path included) when the user denies.
    func requestPermissionsAndStart() {
        #if DEBUG
        if Self.permissionRequestsDisabledForSnapshots { return }
        // Demo automation: same TCC-prompt skip as
        // `requestPermissionsIfNeeded()`.
        if ProcessInfo.processInfo.environment["DEMO_AUTO_SEND"] != nil {
            state = .unavailable
            return
        }
        #endif
        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            DispatchQueue.main.async {
                guard let self else { return }
                guard authStatus == .authorized else {
                    self.state = .unavailable
                    return
                }
                AVAudioApplication.requestRecordPermission { granted in
                    DispatchQueue.main.async {
                        if granted {
                            self.startListening()
                        } else {
                            self.state = .unavailable
                        }
                    }
                }
            }
        }
    }

    /// Toggle: start listening if idle, stop if already listening.
    func toggle() {
        switch state {
        case .idle:
            startListening()
        case .listening:
            stopListening()
        case .finishing, .unavailable:
            break
        }
    }

    /// Begin streaming speech recognition.
    func startListening() {
        guard state == .idle else { return }
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            state = .unavailable
            return
        }

        // Check authorization status synchronously — the prompt should
        // have fired from `requestPermissionsIfNeeded` already.
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            state = .unavailable
            return
        }

        do {
            try startAudioSession()
        } catch {
            state = .unavailable
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Prefer on-device recognition for privacy + latency.
        if #available(iOS 18.0, *) {
            request.requiresOnDeviceRecognition = true
        } else {
            request.requiresOnDeviceRecognition = speechRecognizer.supportsOnDeviceRecognition
        }

        recognitionRequest = request
        transcript = ""
        state = .listening

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || (result?.isFinal ?? false) {
                    self.finishSession()
                }
            }
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            finishSession()
        }
    }

    /// Stop listening and finalize the transcript.
    func stopListening() {
        guard state == .listening else { return }
        state = .finishing
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        // The recognition task's completion handler will call
        // `finishSession` once `isFinal` arrives.

        // Safety timeout — if the task never fires isFinal (can happen
        // when the user stops after very short input), force-finish
        // after 1.5s.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.state == .finishing else { return }
            self.finishSession()
        }
    }

    /// Hard cancel — discard everything without committing.
    func cancel() {
        recognitionTask?.cancel()
        finishSession()
        transcript = ""
    }

    // MARK: - Preview support

    #if DEBUG
    /// Creates a recognizer pre-set to a given state for SwiftUI previews
    /// and snapshot tests. Not available in release builds.
    static func preview(state: State, transcript: String = "") -> SpeechRecognizer {
        let r = SpeechRecognizer()
        r.state = state
        r.transcript = transcript
        return r
    }
    #endif

    // MARK: - Private helpers

    private func startAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func finishSession() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest = nil
        recognitionTask = nil
        // `.unavailable` is sticky: permission denial or a missing
        // recognizer isn't cured by tearing down a session, and
        // resetting to .idle here would re-enable mic buttons that can
        // never record.
        if state != .unavailable { state = .idle }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// MARK: - Pulsing mic animation

/// A pulsating circle that radiates outward from the mic button while
/// speech recognition is active. Two concentric rings scale up and
/// fade out on a perpetual loop, staggered by half a period.
@available(iOS 17.0, *)
struct MicPulseRing: View {
    let color: Color
    @State private var animate = false

    var body: some View {
        ZStack {
            ring(delay: 0)
            ring(delay: 0.6)
        }
        .onAppear { animate = true }
        // Lazy containers (List rows) tear down the display subtree on
        // recycle but keep @State: without this reset, re-insertion
        // would see `animate` already true, fire no new animation
        // transaction, and freeze the rings at their invisible end
        // state.
        .onDisappear { animate = false }
    }

    private func ring(delay: Double) -> some View {
        Circle()
            .stroke(color, lineWidth: 2)
            .scaleEffect(animate ? 2.2 : 1.0)
            .opacity(animate ? 0 : 0.6)
            .animation(
                .easeOut(duration: 1.2)
                    .repeatForever(autoreverses: false)
                    .delay(delay),
                value: animate
            )
    }
}
#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(Speech) && canImport(UIKit)
import AVFoundation
import Speech
import SwiftUI

/// The microphone and on-device recognizer behind every in-app mic
/// touchpoint: permission requests, audio session configuration, and
/// streaming transcription via `SFSpeechAudioBufferRecognitionRequest`.
///
/// The session logic — its states, the gateway refinement and the fallback
/// to the on-device text — lives in `DictationSession`; this class feeds it
/// the audio hardware's events. When `gatewayRoute` yields a route at the
/// moment a session starts, the same tap that feeds the recognizer also
/// records the audio for the gateway's transcriber.
///
/// A gateway session needs only the microphone: when speech recognition is
/// denied, unsupported, or has no on-device model for the language, it
/// records without a live draft, and when the recognizer ends on its own it
/// keeps recording until the person stops. An audio-session interruption (a
/// call, Siri) stops the session as if the person had.
@available(iOS 17.0, *)
@MainActor
@Observable
final class SpeechRecognizer {
    // MARK: - Public state

    typealias State = DictationState

    var state: State {
        session.state
    }

    /// Live draft while listening; the final text once idle.
    var transcript: String {
        session.transcript
    }

    /// The last session's gateway transcription did not happen or failed,
    /// and the on-device text was kept.
    var usedOnDeviceFallback: Bool {
        session.usedOnDeviceFallback
    }

    /// The person kept the draft instead of waiting for the gateway.
    var skippedRefinement: Bool {
        session.skippedRefinement
    }

    /// The running session records for the gateway.
    var routesToGateway: Bool {
        session.routesToGateway
    }

    var isListening: Bool {
        state == .listening
    }

    /// The user stopped and the text is not final yet.
    var isWrappingUp: Bool {
        state.isWrappingUp
    }

    /// There is on-device text to fall back on.
    var hasDraft: Bool {
        !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Read when a session starts: the gateway to send its recording to, or
    /// nil to stay on-device. The owning view supplies it, so this class
    /// never reaches into the app's pairing or status itself.
    @ObservationIgnored var gatewayRoute: () -> GatewayDictationRoute? = { nil }

    // MARK: - Private

    private let session = DictationSession()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale.current)
    @ObservationIgnored private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var recorder: DictationAudioRecorder?
    @ObservationIgnored private var interruptionObserver: NSObjectProtocol?
    private let audioEngine = AVAudioEngine()

    // MARK: - Lifecycle

    #if DEBUG
    /// Snapshot rendering must not request live microphone or speech access.
    /// The snapshot suite scopes this override and restores its previous value.
    nonisolated(unsafe) static var permissionRequestsDisabledForSnapshots = false
    #endif

    /// Request microphone + speech-recognition permissions. Call once
    /// early (e.g. when the mic button first appears) so the system
    /// prompt fires before the user tries to speak. Denied speech
    /// recognition leaves the mic usable while a gateway can transcribe.
    func requestPermissionsIfNeeded() {
        #if DEBUG
        if Self.permissionRequestsDisabledForSnapshots { return }
        // Demo automation: skip the mic + speech-recognition prompts so the
        // system TCC alert never appears over a screen recording. The agent
        // composer is on screen from the first frame of a recorded demo, and
        // the replayed conversation needs neither input. Push registration is
        // skipped under the same flag in `AppStore.requestPushAndRegister()`.
        if ProcessInfo.processInfo.environment["DEMO_AUTO_SEND"] != nil {
            session.markUnavailable()
            return
        }
        #endif
        Self.requestSpeechAuthorization { authorized in
            guard !authorized else { return }
            Task { @MainActor in
                if self.gatewayRoute() == nil { self.session.markUnavailable() }
            }
        }
        Self.requestRecordPermission { granted in
            guard !granted else { return }
            Task { @MainActor in self.session.markUnavailable() }
        }
    }

    /// Request permissions and start listening as soon as they resolve.
    /// Used by the quick-capture surface, which listens immediately on
    /// appear: calling `startListening()` before the system prompts
    /// resolve would see `.notDetermined` and latch the sticky
    /// `.unavailable` state, so the start is chained onto the grants
    /// instead. `startListening()` then decides whether it can run.
    func requestPermissionsAndStart() {
        #if DEBUG
        if Self.permissionRequestsDisabledForSnapshots { return }
        // Demo automation: same TCC-prompt skip as
        // `requestPermissionsIfNeeded()`.
        if ProcessInfo.processInfo.environment["DEMO_AUTO_SEND"] != nil {
            session.markUnavailable()
            return
        }
        #endif
        Self.requestSpeechAuthorization { _ in
            Self.requestRecordPermission { granted in
                Task { @MainActor in
                    if granted {
                        self.startListening()
                    } else {
                        self.session.markUnavailable()
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
        case .finishing, .refining, .unavailable:
            break
        }
    }

    /// Begin a session: streaming speech recognition when it can run, and
    /// recording for the gateway when `gatewayRoute` yields a route. Needs
    /// microphone access, and at least one of the two.
    func startListening() {
        guard state == .idle else { return }
        guard AVAudioApplication.shared.recordPermission == .granted else {
            session.markUnavailable()
            return
        }
        let route = gatewayRoute()
        let recognizer = usableRecognizer()
        guard recognizer != nil || route != nil else {
            session.markUnavailable()
            return
        }

        do {
            try startAudioSession()
        } catch {
            session.markUnavailable()
            return
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        let recorder = route.flatMap { makeRecorder(format: recordingFormat, route: $0) }
        guard recognizer != nil || recorder != nil else {
            tearDownAudio()
            session.markUnavailable()
            return
        }
        self.recorder = recorder

        let request = recognizer.map { recognizer in
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            // Prefer on-device recognition for privacy + latency.
            if #available(iOS 18.0, *) {
                request.requiresOnDeviceRecognition = true
            } else {
                request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
            }
            return request
        }
        recognitionRequest = request
        // A route stays with the session even when its recorder could not be
        // set up: the session then ends on the on-device text and says so.
        session.begin(route: route, liveDraft: request != nil)
        if let recognizer, let request {
            recognitionTask = recognizer.recognitionTask(
                with: request,
                resultHandler: Self.resultHandler(owner: self, request: ObjectIdentifier(request))
            )
        }
        inputNode.installTap(
            onBus: 0,
            bufferSize: 1024,
            format: recordingFormat,
            block: Self.tapBlock(request: request, recorder: recorder)
        )
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main,
            using: Self.interruptionHandler(owner: self)
        )

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            cancel()
        }
    }

    /// Stop listening and finalize the transcript.
    func stopListening() {
        guard state == .listening else { return }
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        let recording = recorder?.finish()
        recorder = nil
        session.stop(recording: recording)
        guard state == .finishing else {
            // No recognizer to wait for: the session already moved on.
            tearDownAudio()
            return
        }
        recognitionRequest?.endAudio()
        // The recognition task's completion handler will call
        // `recognitionFinished` once `isFinal` arrives.

        // Safety timeout — if the task never fires isFinal (can happen
        // when the user stops after very short input), force-finish
        // after 1.5s.
        let request = recognitionRequest.map(ObjectIdentifier.init)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard let self, self.state == .finishing, self.isCurrent(request) else { return }
            self.recognitionFinished()
        }
    }

    /// Stop waiting for the gateway: keep the on-device draft when there is
    /// one, otherwise cancel the session.
    func skipRefinement() {
        guard state == .refining else { return }
        if hasDraft {
            session.useDraft()
        } else {
            cancel()
        }
    }

    /// Hard cancel — discard everything without committing, including an
    /// upload to the gateway still in flight.
    func cancel() {
        tearDownAudio()
        session.cancel()
    }

    // MARK: - Preview support

    #if DEBUG
    /// Creates a recognizer pre-set to a given state for SwiftUI previews
    /// and snapshot tests. Not available in release builds.
    static func preview(
        state: State,
        transcript: String = "",
        usedOnDeviceFallback: Bool = false
    )
        -> SpeechRecognizer {
        let r = SpeechRecognizer()
        r.session.seedForPreview(state: state, transcript: transcript, usedOnDeviceFallback: usedOnDeviceFallback)
        return r
    }
    #endif

    // MARK: - Private helpers

    /// The recognizer when it can stream a draft here: supported for the
    /// locale, available, and authorized.
    private func usableRecognizer() -> SFSpeechRecognizer? {
        guard let speechRecognizer, speechRecognizer.isAvailable,
              SFSpeechRecognizer.authorizationStatus() == .authorized
        else { return nil }
        return speechRecognizer
    }

    private func startAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    }

    /// A recorder for this session, or nil when the encoder cannot be set up
    /// for the microphone's format.
    private func makeRecorder(format: AVAudioFormat, route: GatewayDictationRoute) -> DictationAudioRecorder? {
        try? DictationAudioRecorder(format: format, maxAudioBytes: route.maxAudioBytes) { [weak self] in
            // The duration or byte budget is spent: stop as the user would,
            // so what was said so far is still transcribed.
            guard let self else { return }
            Task { @MainActor in self.stopListening() }
        }
    }

    /// Whether `request` identifies the recognition request still running.
    /// A callback from one this recognizer has since replaced (a cancel
    /// followed by an immediate restart) belongs to an abandoned session.
    private func isCurrent(_ request: ObjectIdentifier?) -> Bool {
        request != nil && recognitionRequest.map(ObjectIdentifier.init) == request
    }

    private func recognitionUpdate(request: ObjectIdentifier, text: String?, ended: Bool) {
        guard isCurrent(request) else { return }
        if let text { session.recognized(text) }
        if ended { recognitionFinished() }
    }

    /// The recognizer produced its final result, failed, or timed out. A
    /// gateway session still listening keeps its audio running.
    private func recognitionFinished() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        session.recognitionEnded()
        if state != .listening { tearDownAudio() }
    }

    private func tearDownAudio() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        recorder?.discard()
        recorder = nil
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // The callbacks below run on the speech, audio and notification threads.
    // They are built in nonisolated functions so they carry no main-actor
    // isolation, and hop to the main actor only with plain values.

    private nonisolated static func resultHandler(
        owner: SpeechRecognizer,
        request: ObjectIdentifier
    )
        -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak owner] result, error in
            guard let owner else { return }
            let text = result?.bestTranscription.formattedString
            let ended = error != nil || (result?.isFinal ?? false)
            Task { @MainActor in
                owner.recognitionUpdate(request: request, text: text, ended: ended)
            }
        }
    }

    private nonisolated static func tapBlock(
        request: SFSpeechAudioBufferRecognitionRequest?,
        recorder: DictationAudioRecorder?
    )
        -> AVAudioNodeTapBlock {
        { buffer, _ in
            request?.append(buffer)
            recorder?.append(buffer)
        }
    }

    private nonisolated static func interruptionHandler(owner: SpeechRecognizer) -> @Sendable (Notification) -> Void {
        { [weak owner] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began,
                  let owner
            else { return }
            Task { @MainActor in owner.stopListening() }
        }
    }

    private nonisolated static func requestSpeechAuthorization(_ done: @escaping @Sendable (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { done($0 == .authorized) }
    }

    private nonisolated static func requestRecordPermission(_ done: @escaping @Sendable (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { done($0) }
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

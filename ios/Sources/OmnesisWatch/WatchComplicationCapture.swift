// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import AVFoundation
import Observation
import SwiftUI
import WatchKit

/// Complication-only recorder. Explicit submission is required even after a
/// time limit, interruption, or background transition stops the microphone.
@MainActor @Observable
final class WatchComplicationCapture: NSObject, AVAudioRecorderDelegate {
    static let shared = WatchComplicationCapture()
    enum State: Equatable { case idle, preparing, recording, ready, saving, sent(WatchCaptureRoute), failed }
    private(set) var state: State = .idle
    private(set) var automatic = false
    private(set) var level: Float = 0
    private(set) var activity: SiriAskActivitySnapshot?
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var recording: WatchVoiceRecording?
    @ObservationIgnored private var selectedRoute: WatchCaptureRoute?
    @ObservationIgnored private var meter: Task<Void, Never>?
    @ObservationIgnored private var interruption: NSObjectProtocol?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var audioSessionActive = false
    @ObservationIgnored private var sentRef: String?
    @ObservationIgnored private var answeredRef: String?
    @ObservationIgnored private var carried = false

    func start() async {
        guard state == .idle || state == .failed || isSent else { return }
        WatchAskRouter.shared.cancelPending()
        WatchDictation.cancelPending()
        WatchVoiceCapture.shared.cancel()
        WatchVoiceCapture.shared.dismiss()
        discard()
        sentRef = nil
        answeredRef = nil
        activity = nil
        generation += 1
        let current = generation
        state = .preparing
        WatchSpeaker.shared.stop()
        let gate = await WatchLink.shared.dictationGate()
        guard current == generation, state == .preparing else { return }
        guard gate?.captureSupported == true else { state = .failed
            return
        }
        automatic = gate.map { $0.decisionGate && Date().timeIntervalSince($0.updatedAt) < WatchDictationGate.staleAfter } ?? false
        let allowed = await AVAudioApplication.requestRecordPermission()
        guard current == generation, state == .preparing else { return }
        guard allowed else { state = .failed
            return
        }
        do {
            let ref = UUID().uuidString
            let file = try WatchVoiceOutbox.shared.recordingURL(ref: ref)
            recording = WatchVoiceRecording(ref: ref, captureTime: .now(), locale: Locale.current.identifier)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            audioSessionActive = true
            let recorder = try AVAudioRecorder(url: file, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: WatchVoiceFormat.sampleRate,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: WatchVoiceFormat.bitRate,
            ])
            recorder.delegate = self
            recorder.isMeteringEnabled = true
            self.recorder = recorder
            guard recorder.record(forDuration: gate?.recordingLimit(now: Date()) ?? WatchVoiceFormat.maxDuration) else {
                throw CocoaError(.fileWriteUnknown)
            }
            state = .recording
            WKInterfaceDevice.current().play(.start)
            interruption = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: session,
                queue: .main
            ) { _ in
                Task { @MainActor in WatchComplicationCapture.shared.pause() }
            }
            meter = Task { [weak self] in
                while !Task.isCancelled {
                    self?.recorder?.updateMeters()
                    self?.level = max(0, min(1, ((self?.recorder?.averagePower(forChannel: 0) ?? -50) + 50) / 50))
                    try? await Task.sleep(for: .milliseconds(80))
                }
            }
        } catch {
            discard()
            state = .failed
        }
    }

    var isSent: Bool {
        if case .sent = state { return true }
        return false
    }

    func send(_ route: WatchCaptureRoute) {
        guard state == .recording || state == .ready else { return }
        selectedRoute = route
        if state == .ready { persist() } else { state = .saving
            recorder?.stop()
        }
    }

    func pause() {
        if state == .preparing { cancel()
            return
        }
        guard state == .recording else { return }
        recorder?.stop()
    }

    func cancel() {
        generation += 1
        sentRef = nil
        answeredRef = nil
        activity = nil
        discard()
        state = .idle
    }

    private func discard() {
        let file = recorder?.url
        recorder?.delegate = nil
        recorder?.stop()
        recorder = nil
        recording = nil
        selectedRoute = nil
        releaseMicrophone()
        if let file { try? FileManager.default.removeItem(at: file) }
    }

    private func releaseMicrophone() {
        meter?.cancel()
        meter = nil
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        interruption = nil
        if audioSessionActive {
            audioSessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let id = ObjectIdentifier(recorder)
        Task { @MainActor in
            guard self.recorder.map(ObjectIdentifier.init) == id else { return }
            self.releaseMicrophone()
            guard flag else { self.discard()
                self.state = .failed
                return
            }
            if self.selectedRoute != nil { self.persist() } else { self.state = .ready }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        audioRecorderDidFinishRecording(recorder, successfully: false)
    }

    private func persist() {
        guard let recording, let route = selectedRoute else { return }
        do {
            try WatchVoiceOutbox.shared.add(WatchVoiceRecording(
                ref: recording.ref,
                captureTime: recording.captureTime,
                locale: recording.locale,
                route: route
            ))
            // The outbox owns the file now. Never remove it on dismissal.
            recorder?.delegate = nil
            recorder = nil
            self.recording = nil
            selectedRoute = nil
            sentRef = recording.ref
            state = .sent(route)
            WKInterfaceDevice.current().play(.success)
            carried = WatchLink.shared.flushOutbox(.linkMayHaveChanged).contains(recording.ref)
            if route == .note { leaveAfterConfirmation() }
        } catch { discard()
            state = .failed
            WKInterfaceDevice.current().play(.failure)
        }
    }

    func resolved(_ route: WatchCaptureRoute, ref: String) {
        guard sentRef == ref, isSent else { return }
        state = .sent(route)
        if route == .note {
            // The phone resolving the route proves it owns the audio.
            carried = true
            leaveAfterConfirmation()
        }
    }

    func report(_ activity: SiriAskActivitySnapshot, ref: String?) {
        guard sentRef == ref, isSent else { return }
        self.activity = activity
    }

    @discardableResult
    func answered(_ outcome: SiriAskOutcome, ref: String) -> Bool {
        if answeredRef == ref { return WKExtension.shared().applicationState == .active }
        guard sentRef == ref, isSent else { return false }
        cancel()
        answeredRef = ref
        WatchPresenter.shared.screen = .ask
        WatchAskRouter.shared.answered(outcome: outcome)
        WKInterfaceDevice.current().play(.notification)
        WatchSpeaker.shared.speak(SiriAskDialog.text(for: outcome))
        return WKExtension.shared().applicationState == .active
    }

    private func leaveAfterConfirmation() {
        let current = generation
        Task {
            try? await Task.sleep(for: .seconds(WatchVoiceDismissal.confirmationDelay))
            let otherWork = WatchAskRouter.shared.isAsking || WatchSpeaker.shared.isSpeaking
                || WatchVoiceCapture.shared.state != .idle
            guard current == generation, state == .sent(.note),
                  WatchVoiceDismissal.shouldLeave(showingSent: isSent, carriedByTransfer: carried, otherWorkInFlight: otherWork)
            else { return }
            exit(0)
        }
    }

    #if DEBUG
    func stage(_ state: State, automatic: Bool = false) {
        discard()
        self.automatic = automatic
        self.state = state
        self.level = 0.6
    }
    #endif
}

struct WatchComplicationCaptureView: View {
    private var capture = WatchComplicationCapture.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let accent = Color(red: 88 / 255, green: 166 / 255, blue: 1)

    var body: some View {
        if capture.state == .failed {
            ScrollView {
                VStack(spacing: 8) {
                    Image("OmnesisMark").resizable().scaledToFit()
                        .frame(width: 28, height: 28).foregroundStyle(accent)
                    content
                }.padding(.horizontal, 10)
            }
        } else { layout }
    }

    private var layout: some View {
        VStack(spacing: 6) {
            Spacer(minLength: 0)
            ZStack {
                Circle().fill(accent.opacity(0.14 + Double(capture.level) * 0.22))
                    .frame(width: 88, height: 88)
                ForEach(0 ..< 3) { ring in
                    Circle().stroke(accent.opacity(0.75 - Double(ring) * 0.16), lineWidth: 3 - CGFloat(ring) * 0.5)
                        .frame(width: 54 + CGFloat(ring) * 14, height: 54 + CGFloat(ring) * 14)
                        .scaleEffect(reduceMotion ? 1 : 1 + CGFloat(capture.level) * (0.28 + CGFloat(ring) * 0.08))
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: capture.level)
                }
                Image("OmnesisMark").resizable().scaledToFit().frame(width: 36, height: 36)
                    .foregroundStyle(accent)
            }.frame(height: 96).accessibilityHidden(true)
            content
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .background(Color.black)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: capture.state)
    }

    @ViewBuilder private var content: some View {
        switch capture.state {
        case .idle: EmptyView()
        case .preparing:
            Text("Opening microphone…").font(.caption)
            Button("Cancel") { capture.cancel() }.buttonStyle(.plain)
        case .recording, .ready:
            Text(capture.state == .recording ? "Listening" : "Ready to send")
                .font(.headline).foregroundStyle(.white)
            if capture.automatic {
                sendButton("Send", route: .automatic)
            } else {
                HStack(spacing: 8) {
                    sendButton("Ask", route: .ask)
                    sendButton("Tell", route: .note)
                }
            }
            Button("Cancel") { capture.cancel() }
                .font(.caption2).foregroundStyle(.secondary).buttonStyle(.plain)
        case .saving:
            ProgressView().tint(accent)
        case .sent(let route):
            Text("Got it.").font(.headline)
            Text(route == .ask ? (capture.activity?.label ?? "Waiting for your answer…") : route == .automatic ?
                "Working out what you need…" : "I'll deal with it.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Done") { capture.cancel() }.buttonStyle(.plain).font(.caption2)
        case .failed:
            Text("Couldn't record").font(.headline)
            Text("Open the iPhone app. Check microphone access and updates.")
                .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again") { Task { await capture.start() } }
            Button("Cancel") { capture.cancel() }.buttonStyle(.plain).font(.caption2)
        }
    }

    private func sendButton(_ title: String, route: WatchCaptureRoute) -> some View {
        Button { capture.send(route) } label: {
            Text(title).font(.system(.body, design: .rounded, weight: .semibold))
                .frame(maxWidth: .infinity, minHeight: 32)
        }
        .buttonStyle(.borderedProminent).tint(accent).foregroundStyle(.black)
        .accessibilityIdentifier("watchCapture-\(route.rawValue)")
    }
}

#if DEBUG
#Preview("Capture Ask and Tell") {
    WatchComplicationCaptureView().onAppear { WatchComplicationCapture.shared.stage(.recording) }
}

#Preview("Capture Send") {
    WatchComplicationCaptureView().onAppear { WatchComplicationCapture.shared.stage(.recording, automatic: true) }
}

#Preview("Capture ready") {
    WatchComplicationCaptureView().onAppear { WatchComplicationCapture.shared.stage(.ready) }
}

#Preview("Capture accepted") {
    WatchComplicationCaptureView().onAppear { WatchComplicationCapture.shared.stage(.sent(.note)) }
}

#Preview("Capture permission error") {
    WatchComplicationCaptureView().onAppear { WatchComplicationCapture.shared.stage(.failed) }
}
#endif
#endif

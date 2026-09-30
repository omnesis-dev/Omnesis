// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import AVFoundation
import Observation
import SwiftUI
import WatchKit

/// Records a note for gateway dictation and hands it to the iPhone — fire
/// and forget. The watch shows no live words: it records, sends, says so,
/// and returns to the note screen. The phone saves the note at once with its
/// own transcript, and the gateway's transcription replaces it when ready.
///
/// Used only while the iPhone reports gateway dictation on
/// (`WatchDictationGate`); otherwise, and whenever recording cannot start,
/// the note is dictated on the system's own screen.
@MainActor
@Observable
final class WatchVoiceCapture: NSObject, AVAudioRecorderDelegate {
    static let shared = WatchVoiceCapture()

    enum State: Equatable {
        case idle
        case recording(startedAt: Date, limit: TimeInterval)
        /// The note is safely in the outbox, on its way to the iPhone.
        case sent
        /// The recording could not be kept.
        case failed
        /// Recorded notes that waited too long for the iPhone were removed.
        case dropped(count: Int)
    }

    private(set) var state: State = .idle

    var isRecording: Bool {
        if case .recording = state { return true }
        return false
    }

    /// The recorder in use, if any.
    @ObservationIgnored private var recorder: AVAudioRecorder?
    /// What each recorder's recording is for, until its finish callback
    /// arrives. A cancelled recording has no entry, so its callback throws
    /// the file away; a late callback from an earlier recorder finds its own
    /// entry, never the current one's.
    @ObservationIgnored private var pending: [ObjectIdentifier: WatchVoiceRecording] = [:]
    @ObservationIgnored private var dismissal: Task<Void, Never>?
    @ObservationIgnored private var interruptionObserver: NSObjectProtocol?
    /// Ends the background activity that keeps the app alive to hand over a
    /// recording stopped by leaving the screen.
    @ObservationIgnored private var endBackgroundHandOff: (() -> Void)?

    /// How long the sent or failed confirmation stays before the flow's own
    /// screen returns.
    private static let confirmationDuration = Duration.seconds(3)

    override private init() {
        super.init()
    }

    /// Start recording. False when the watch should use system dictation
    /// instead: microphone access was refused, or the recorder could not
    /// start. A second start while recording is absorbed.
    func start(limit: TimeInterval) async -> Bool {
        if isRecording { return true }
        guard await AVAudioApplication.requestRecordPermission() else { return false }
        let ref = UUID().uuidString
        guard let file = try? WatchVoiceOutbox.shared.recordingURL(ref: ref) else { return false }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: WatchVoiceFormat.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: WatchVoiceFormat.bitRate,
        ]
        let session = AVAudioSession.sharedInstance()
        let recorder: AVAudioRecorder
        do {
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            recorder = try AVAudioRecorder(url: file, settings: settings)
        } catch {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            try? FileManager.default.removeItem(at: file)
            return false
        }
        recorder.delegate = self
        // The limit stops the recording as Send would.
        guard recorder.record(forDuration: limit) else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            try? FileManager.default.removeItem(at: file)
            return false
        }
        self.recorder = recorder
        pending[ObjectIdentifier(recorder)] = WatchVoiceRecording(
            ref: ref,
            captureTime: .now(),
            locale: Locale.current.identifier
        )
        observeInterruptions()
        dismissal?.cancel()
        state = .recording(startedAt: Date(), limit: limit)
        WKInterfaceDevice.current().play(.start)
        return true
    }

    /// Stop and send what was recorded.
    func send() {
        guard isRecording else { return }
        recorder?.stop()
    }

    /// Stop and throw the recording away.
    func cancel() {
        guard isRecording, let recorder else { return }
        pending.removeValue(forKey: ObjectIdentifier(recorder))
        recorder.stop()
        state = .idle
    }

    /// The app is leaving the screen: send what was recorded rather than
    /// leave the microphone running behind the watch face, keeping the app
    /// alive long enough to hand the recording over.
    func appDidEnterBackground() {
        guard isRecording else { return }
        let handedOver = DispatchSemaphore(value: 0)
        endBackgroundHandOff = { handedOver.signal() }
        ProcessInfo.processInfo.performExpiringActivity(withReason: "Send the dictation recording") { expired in
            if expired {
                handedOver.signal()
            } else {
                _ = handedOver.wait(timeout: .now() + 10)
            }
        }
        send()
    }

    /// Tell the person about notes the outbox dropped, when nothing else is
    /// on this screen.
    func showDroppedIfNeeded() {
        let count = WatchVoiceOutbox.shared.droppedCount
        guard count > 0, state == .idle else { return }
        dismissal?.cancel()
        state = .dropped(count: count)
    }

    func dismiss() {
        dismissal?.cancel()
        if case .dropped = state { WatchVoiceOutbox.shared.acknowledgeDropped() }
        state = .idle
    }

    #if DEBUG
    /// Put the screen into a state for a preview without recording.
    func stage(_ state: State) {
        dismissal?.cancel()
        self.state = state
    }
    #endif

    // MARK: - AVAudioRecorderDelegate

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let id = ObjectIdentifier(recorder)
        let file = recorder.url
        Task { @MainActor in self.finished(id, file: file, successfully: flag) }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let id = ObjectIdentifier(recorder)
        let file = recorder.url
        Task { @MainActor in self.finished(id, file: file, successfully: false) }
    }

    private func finished(_ id: ObjectIdentifier, file: URL, successfully: Bool) {
        let recording = pending.removeValue(forKey: id)
        let current = recorder.map(ObjectIdentifier.init) == id
        if current {
            recorder = nil
            stopObservingInterruptions()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        defer {
            endBackgroundHandOff?()
            endBackgroundHandOff = nil
        }
        guard let recording else {
            // Cancelled: nothing to send.
            try? FileManager.default.removeItem(at: file)
            return
        }
        // Sent means safely in the outbox, whatever the link is doing: the
        // outbox hands it to the iPhone now or when the link comes back.
        let kept = successfully && (try? WatchVoiceOutbox.shared.add(recording)) != nil
        if !kept { try? FileManager.default.removeItem(at: file) }
        WKInterfaceDevice.current().play(kept ? .success : .failure)
        let carried = kept && WatchLink.shared.flushOutbox(.linkMayHaveChanged).contains(recording.ref)
        // Only the recording on screen changes the screen.
        guard current else { return }
        show(kept ? .sent : .failed)
        if kept { leaveAfterConfirmation(carried: carried) }
    }

    /// Return to the watch face once "Sent" has been seen, when that is safe
    /// (`WatchVoiceDismissal`). watchOS has no call for it, so the app ends
    /// its process; WatchConnectivity carries the transfer on.
    private func leaveAfterConfirmation(carried: Bool) {
        Task {
            try? await Task.sleep(for: .seconds(WatchVoiceDismissal.confirmationDelay))
            let otherWork = WatchAskRouter.shared.isAsking || WatchNoteRouter.shared.isRelaying
                || WatchSpeaker.shared.isSpeaking || self.isRecording
            guard WatchVoiceDismissal.shouldLeave(
                showingSent: self.state == .sent,
                carriedByTransfer: carried,
                otherWorkInFlight: otherWork
            ) else { return }
            exit(0)
        }
    }

    private func show(_ confirmation: State) {
        guard confirmation != .idle else { return }
        state = confirmation
        dismissal?.cancel()
        dismissal = Task {
            try? await Task.sleep(for: Self.confirmationDuration)
            guard !Task.isCancelled, self.state == confirmation else { return }
            self.state = .idle
        }
    }

    // MARK: - Interruptions

    /// A call or Siri taking the microphone ends the recording; what was
    /// recorded is sent.
    private func observeInterruptions() {
        stopObservingInterruptions()
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main,
            using: Self.interruptionHandler()
        )
    }

    private func stopObservingInterruptions() {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
    }

    private nonisolated static func interruptionHandler() -> @Sendable (Notification) -> Void {
        { notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began
            else { return }
            Task { @MainActor in WatchVoiceCapture.shared.send() }
        }
    }
}

struct WatchVoiceCaptureView: View {
    private var capture = WatchVoiceCapture.shared

    var body: some View {
        switch capture.state {
        case .idle:
            EmptyView()
        case .recording(let startedAt, let limit):
            recording(startedAt: startedAt, limit: limit)
        case .sent:
            sent
        case .failed:
            failed
        case .dropped(let count):
            dropped(count: count)
        }
    }

    private func recording(startedAt: Date, limit: TimeInterval) -> some View {
        VStack(spacing: 8) {
            Text("Omnesis note")
                .font(.headline)
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                Label(elapsed(from: startedAt, to: context.date, limit: limit), systemImage: "waveform")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.red)
            }
            Button {
                capture.send()
            } label: {
                Label("Send", systemImage: "arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("watchVoiceSend")
            Button("Cancel", role: .cancel) {
                capture.cancel()
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal)
    }

    private var sent: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 34))
                .foregroundStyle(.green)
            Text("Sent to your iPhone.")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Your gateway will transcribe it.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
        .onTapGesture { capture.dismiss() }
    }

    private var failed: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 30))
                .foregroundStyle(.orange)
            Text("Couldn't save")
                .font(.headline)
            Text("Your recording couldn't be saved. Try again.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
        .onTapGesture { capture.dismiss() }
    }

    private func dropped(count: Int) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 30))
                .foregroundStyle(.orange)
            Text(count == 1 ? "A note wasn't sent" : "\(count) notes weren't sent")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("They couldn't reach your iPhone for a week and were removed.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("OK") { capture.dismiss() }
                .buttonStyle(.bordered)
        }
        .padding()
    }

    private func elapsed(from start: Date, to now: Date, limit: TimeInterval) -> String {
        let seconds = min(Int(limit), max(0, Int(now.timeIntervalSince(start))))
        return "\(clock(seconds)) / \(clock(Int(limit)))"
    }

    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

#if DEBUG
#Preview("Recording") {
    WatchVoiceCaptureView()
        .onAppear {
            WatchVoiceCapture.shared.stage(.recording(startedAt: Date().addingTimeInterval(-12), limit: 120))
        }
}

#Preview("Sent") {
    WatchVoiceCaptureView()
        .onAppear { WatchVoiceCapture.shared.stage(.sent) }
}

#Preview("Couldn't save") {
    WatchVoiceCaptureView()
        .onAppear { WatchVoiceCapture.shared.stage(.failed) }
}

#Preview("Notes dropped") {
    WatchVoiceCaptureView()
        .onAppear { WatchVoiceCapture.shared.stage(.dropped(count: 2)) }
}
#endif
#endif

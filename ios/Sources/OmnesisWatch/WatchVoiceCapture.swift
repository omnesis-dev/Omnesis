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

    /// Where recordings wait for their transfer. Not backed up.
    nonisolated static let outboxDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("WatchVoiceOutbox", isDirectory: true)

    enum State: Equatable {
        case idle
        case recording(startedAt: Date, limit: TimeInterval)
        case sent
        /// The recording could not be handed to the iPhone.
        case failed
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
        let file = Self.outboxDirectory.appendingPathComponent("\(ref).\(WatchVoiceFormat.fileExtension)")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: WatchVoiceFormat.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: WatchVoiceFormat.bitRate,
        ]
        let session = AVAudioSession.sharedInstance()
        let recorder: AVAudioRecorder
        do {
            try Self.prepareOutbox()
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

    /// A transfer the iPhone never received.
    func transferFailed() {
        WKInterfaceDevice.current().play(.failure)
        if !isRecording { show(.failed) }
    }

    func dismiss() {
        dismissal?.cancel()
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
        let handedOver = successfully && WatchLink.shared.transferRecording(file, recording: recording)
        if !handedOver { try? FileManager.default.removeItem(at: file) }
        WKInterfaceDevice.current().play(handedOver ? .success : .failure)
        // Only the recording on screen changes the screen.
        guard current else { return }
        show(handedOver ? .sent : .failed)
    }

    private func show(_ confirmation: State) {
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

    private static func prepareOutbox() throws {
        guard !FileManager.default.fileExists(atPath: outboxDirectory.path) else { return }
        try FileManager.default.createDirectory(at: outboxDirectory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = outboxDirectory
        try? excluded.setResourceValues(values)
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
        }
        .padding()
        .onTapGesture { capture.dismiss() }
    }

    private var failed: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 30))
                .foregroundStyle(.orange)
            Text("Couldn't send")
                .font(.headline)
            Text("Your recording didn't reach your iPhone. Try again.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
        .onTapGesture { capture.dismiss() }
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

#Preview("Couldn't send") {
    WatchVoiceCaptureView()
        .onAppear { WatchVoiceCapture.shared.stage(.failed) }
}
#endif
#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation
import OSLog

/// Where a dictation session is in its life.
public enum DictationState: Equatable, Sendable {
    /// No session — mic buttons show the default microphone icon.
    case idle
    /// Recording. When the on-device recognizer runs, it streams partials
    /// into `transcript`; a gateway session can also record without it.
    case listening
    /// The user stopped; the on-device recognizer is producing its final text.
    case finishing
    /// The recording is with the gateway's transcriber, whose text replaces
    /// the on-device draft when it arrives.
    case refining
    /// Dictation cannot run: microphone permission was denied, or the
    /// on-device recognizer cannot run and there is no gateway to record for.
    case unavailable

    /// The user stopped and the text is not final yet. A surface that commits
    /// dictated text waits for this to end instead of committing a draft.
    public var isWrappingUp: Bool {
        self == .finishing || self == .refining
    }
}

/// The gateway's answer to one recording.
public struct DictationTranscription: Decodable, Equatable, Sendable {
    public let text: String
    public let language: String?
    public let durationSec: Double?

    public init(text: String, language: String? = nil, durationSec: Double? = nil) {
        self.text = text
        self.language = language
        self.durationSec = durationSec
    }
}

/// Turns a recording into text. `DictationClient` is the production
/// conformer; tests substitute a scripted one.
public protocol DictationTranscribing: Sendable {
    func transcribe(audio: Data, contentType: String, language: String?) async throws -> DictationTranscription
}

/// What a mic session needs to record for the gateway. Resolved when the
/// session starts, so a change to the gateway setting applies to the next
/// dictation rather than to one already under way.
public struct GatewayDictationRoute: Sendable {
    public let transcriber: any DictationTranscribing
    /// Largest recording the gateway accepts, in bytes.
    public let maxAudioBytes: Int

    public init(transcriber: any DictationTranscribing, maxAudioBytes: Int) {
        self.transcriber = transcriber
        self.maxAudioBytes = maxAudioBytes
    }
}

/// How a recording for the gateway is encoded: mono AAC in an MPEG-4
/// container at a fixed bit rate, which makes its size predictable enough to
/// stop before the gateway's byte limit.
public enum DictationRecordingFormat {
    public static let contentType = "audio/mp4"
    public static let fileExtension = "m4a"
    /// Ample for speech.
    static let preferredBitRate = 64000
    /// The longest recording sent to the gateway, whatever its byte limit
    /// allows: a longer one would keep the person waiting on the transcriber
    /// for too long.
    public static let maxRecordingDuration: TimeInterval = 5 * 60
    /// Share of the byte limit a recording may fill. The rest covers the
    /// container and the encoder's drift from its nominal rate.
    static let budgetShare = 0.9

    /// The bit rate for a mono recording, from the rates the AAC encoder
    /// offers at the input's sample rate: the preferred rate or the highest
    /// below it. Narrowband inputs, such as an 8 kHz Bluetooth headset, top
    /// out far lower. Nil when the encoder offers none.
    public static func bitRate(choosingFrom applicable: [Int]) -> Int? {
        applicable.filter { $0 <= preferredBitRate }.max() ?? applicable.min()
    }

    /// The longest recording that stays under `maxAudioBytes` at `bitRate`,
    /// and under `maxRecordingDuration`.
    public static func maxDuration(forMaxAudioBytes maxAudioBytes: Int, bitRate: Int) -> TimeInterval {
        guard maxAudioBytes > 0, bitRate > 0 else { return 0 }
        return min(maxRecordingDuration, Double(maxAudioBytes) * budgetShare / (Double(bitRate) / 8))
    }
}

/// How the gateway refinement of one session ended.
enum DictationRefinementOutcome: Equatable {
    /// The gateway's text replaces the on-device draft.
    case refined(String)
    /// The on-device draft stands. `reason` is for the log only.
    case keptDraft(reason: String)
}

/// The state machine behind every in-app mic touchpoint, free of any audio
/// or speech framework so the logic lane can drive it.
///
/// When the on-device recognizer runs, its partials are the live draft. When
/// the session was started with a `GatewayDictationRoute`, the mic adapter
/// also records the audio, and the recording goes to the gateway once the
/// user stops (after the on-device final, when there is a recognizer). The
/// session sits in `.refining` until the gateway's text replaces the draft.
///
/// A gateway session does not depend on the recognizer: it records without
/// a live draft when the recognizer cannot run, and keeps recording when the
/// recognizer ends on its own. Any gateway failure keeps the draft and raises
/// `usedOnDeviceFallback` when there is one. The recording file is deleted
/// whatever happens.
@MainActor
@Observable
public final class DictationSession {
    public private(set) var state: DictationState = .idle
    /// The live draft while listening; the final text once `.idle`.
    public private(set) var transcript = ""
    /// The last session's gateway transcription did not happen or failed and
    /// its on-device text was kept. Cleared when the next session starts.
    public private(set) var usedOnDeviceFallback = false
    /// The person stopped the last session's gateway wait and kept the
    /// draft. Cleared when the next session starts.
    public private(set) var skippedRefinement = false
    /// The running session was started to record for the gateway.
    public private(set) var routesToGateway = false
    /// The on-device recognizer is producing the draft. False when it could
    /// not start, or ended on its own during a gateway session.
    public private(set) var hasLiveDraft = true

    private let language: String?
    @ObservationIgnored private var route: GatewayDictationRoute?
    @ObservationIgnored private var recording: URL?
    @ObservationIgnored private var refinement: Task<Void, Never>?
    /// The recording the in-flight refinement is uploading.
    @ObservationIgnored private var refiningRecording: URL?
    /// Bumped by every start and cancel, so a refinement that finishes after
    /// its session was abandoned cannot write into a newer one.
    @ObservationIgnored private var generation = 0

    private nonisolated static let log = AppLog.make(category: "dictation")

    /// `language` is the ISO 639 hint sent with each recording.
    public init(language: String? = Locale.current.language.languageCode?.identifier) {
        self.language = language
    }

    /// A session started. Pass the route when the session records for the
    /// gateway, and `liveDraft: false` when the on-device recognizer is not
    /// running.
    func begin(route: GatewayDictationRoute?, liveDraft: Bool = true) {
        cancelRefinement()
        discardRecording()
        generation += 1
        self.route = route
        routesToGateway = route != nil
        hasLiveDraft = liveDraft
        transcript = ""
        usedOnDeviceFallback = false
        skippedRefinement = false
        state = .listening
    }

    /// A partial or final result from the on-device recognizer.
    func recognized(_ text: String) {
        guard state == .listening || state == .finishing else { return }
        transcript = text
    }

    /// The user stopped. `recording` is the finished file when the session
    /// recorded one; nil when recording failed, which leaves the on-device
    /// text as the result.
    func stop(recording: URL?) {
        guard state == .listening else {
            if let recording { Self.delete(recording) }
            return
        }
        if route != nil {
            self.recording = recording
        } else if let recording {
            Self.delete(recording)
        }
        if hasLiveDraft {
            state = .finishing
        } else {
            draftIsFinal()
        }
    }

    /// The on-device recognizer delivered its final result, failed, or timed
    /// out. After a user stop this moves on to the gateway refinement. While
    /// still listening it is the recognizer ending on its own: an on-device
    /// session ends with what it heard, and a gateway session keeps recording
    /// with the draft it has.
    func recognitionEnded() {
        switch state {
        case .listening:
            if route != nil {
                hasLiveDraft = false
            } else {
                finish()
            }
        case .finishing:
            draftIsFinal()
        case .idle, .refining, .unavailable:
            break
        }
    }

    /// Stop waiting for the gateway and keep the on-device draft, at the
    /// person's request. The upload is cancelled and the recording deleted.
    func useDraft() {
        guard state == .refining else { return }
        generation += 1
        cancelRefinement()
        skippedRefinement = true
        finish()
    }

    /// Hard cancel: stop any upload, delete the recording, drop the text.
    func cancel() {
        generation += 1
        cancelRefinement()
        discardRecording()
        transcript = ""
        routesToGateway = false
        if state != .unavailable { state = .idle }
    }

    /// Dictation cannot run here. Sticky: tearing down a session does not
    /// cure it.
    func markUnavailable() {
        generation += 1
        cancelRefinement()
        discardRecording()
        routesToGateway = false
        state = .unavailable
    }

    /// Resolves once the in-flight refinement has settled.
    func refinementSettled() async {
        await refinement?.value
    }

    #if DEBUG
    /// Seeds a state for previews and snapshots.
    func seedForPreview(state: DictationState, transcript: String, usedOnDeviceFallback: Bool) {
        self.state = state
        self.transcript = transcript
        self.usedOnDeviceFallback = usedOnDeviceFallback
        routesToGateway = state == .refining
    }
    #endif

    // MARK: - Refinement

    /// The draft will not change any more: send the recording, or settle.
    private func draftIsFinal() {
        if let route, let recording {
            startRefinement(route: route, recording: recording)
        } else if route != nil {
            settle(.keptDraft(reason: "no recording was made"))
        } else {
            finish()
        }
    }

    private func startRefinement(route: GatewayDictationRoute, recording: URL) {
        self.recording = nil
        self.route = nil
        refiningRecording = recording
        state = .refining
        let session = generation
        let language = language
        refinement = Task { [weak self] in
            let outcome = await Self.refine(recording: recording, route: route, language: language)
            guard let self, self.generation == session, self.state == .refining else { return }
            self.settle(outcome)
        }
    }

    private func settle(_ outcome: DictationRefinementOutcome) {
        switch outcome {
        case .refined(let text):
            transcript = text
        case .keptDraft(let reason):
            Self.log.notice("Gateway dictation kept the on-device text: \(reason, privacy: .public)")
            usedOnDeviceFallback = !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        finish()
    }

    /// Back to idle with the transcript as it stands.
    private func finish() {
        refinement = nil
        refiningRecording = nil
        discardRecording()
        routesToGateway = false
        state = .idle
    }

    /// Upload one recording and read back its text. Deletes the recording
    /// on every path, cancellation included.
    nonisolated static func refine(
        recording: URL,
        route: GatewayDictationRoute,
        language: String?
    ) async
        -> DictationRefinementOutcome {
        defer { delete(recording) }
        guard let audio = try? Data(contentsOf: recording), !audio.isEmpty else {
            return .keptDraft(reason: "the recording could not be read")
        }
        guard audio.count <= route.maxAudioBytes else {
            return .keptDraft(reason: "the recording exceeds the gateway's \(route.maxAudioBytes)-byte limit")
        }
        do {
            let result = try await route.transcriber.transcribe(
                audio: audio,
                contentType: DictationRecordingFormat.contentType,
                language: language
            )
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? .keptDraft(reason: "the gateway heard no speech") : .refined(text)
        } catch {
            // The error can name the gateway's host, so it stays private.
            log.error("Gateway transcription failed: \(String(describing: error), privacy: .private)")
            return .keptDraft(reason: "the gateway could not transcribe the recording")
        }
    }

    /// Also deletes the recording at once rather than when the upload
    /// notices the cancellation.
    private func cancelRefinement() {
        refinement?.cancel()
        refinement = nil
        if let refiningRecording { Self.delete(refiningRecording) }
        refiningRecording = nil
    }

    private func discardRecording() {
        if let recording { Self.delete(recording) }
        recording = nil
        route = nil
        routesToGateway = false
    }

    private nonisolated static func delete(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}

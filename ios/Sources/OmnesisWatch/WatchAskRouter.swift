// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import AVFoundation
import Foundation
import Observation
import WatchKit

/// Carries one watch ask from dictated question to presented answer.
///
/// Siri cannot deliver the answer on the watch, for two compounding reasons:
/// reaching the phone at all requires foregrounding this app (WatchConnectivity
/// interactive messaging needs `isReachable`, which on watchOS holds only in the
/// foreground), and opening the app ends Siri's session — long before an agent
/// turn settles. So the intent hands the question here and returns immediately;
/// the app owns the wait, then shows and speaks the answer on the wrist.
///
/// The router, not a view, owns the relay. The screen switches between the
/// ask and note flows while a relay is out, and a relay tied to a view would
/// be cancelled with it and sent again when the view came back. A relay is
/// cancelled only when a newer question replaces it.
@MainActor
@Observable
final class WatchAskRouter {
    static let shared = WatchAskRouter()

    enum State: Equatable {
        case idle
        case asking(question: String, ref: String)
        /// The answer stands alone — the question it settles is not carried
        /// into this state, because the screen showing an answer shows only
        /// the answer.
        case answered(text: String, kind: SiriAskOutcome.Kind, statusTitle: String)
    }

    private(set) var state: State = .idle

    /// The privacy-safe aggregate state streamed from the phone. Progress is
    /// best-effort, so the UI remains useful when this is nil.
    private(set) var activity: SiriAskActivitySnapshot?

    /// The relay in flight, cancelled when a newer question replaces it.
    private var relay: Task<Void, Never>?

    func submit(question: String) {
        let ref = UUID().uuidString
        state = .asking(question: question, ref: ref)
        activity = nil
        relay?.cancel()
        relay = Task {
            let outcome = await WatchLink.shared.relayAsk(question: question, ref: ref)
            // A newer question owns the screen now; committing this one
            // would replace its answer, speak the wrong reply, and buzz for
            // a question already gone.
            guard !Task.isCancelled else { return }
            answered(outcome: outcome)
            // The wrist is often down through a long wait, so the result
            // announces itself through the one channel that reaches it. The
            // three kinds stay distinguishable without looking.
            WKInterfaceDevice.current().play(Self.haptic(for: outcome.kind))
            // Everything is spoken, failures included: the whole point is not
            // having to look at the wrist, and "I couldn't reach your iPhone"
            // is exactly the sentence you need to hear rather than discover.
            WatchSpeaker.shared.speak(SiriAskDialog.text(for: outcome))
        }
    }

    func report(activity: SiriAskActivitySnapshot, ref: String?) {
        // Late progress from a finished turn must not overwrite the answer.
        guard case .asking(_, let activeRef) = state, ref == activeRef else { return }
        self.activity = activity
    }

    func answered(outcome: SiriAskOutcome) {
        state = .answered(
            text: SiriAskDialog.text(for: outcome),
            kind: outcome.kind,
            statusTitle: SiriAskDialog.statusTitle(for: outcome)
        )
        activity = nil
    }

    private static func haptic(for kind: SiriAskOutcome.Kind) -> WKHapticType {
        switch kind {
        case .answer: .success
        case .status: .notification
        case .failure: .failure
        }
    }

    #if DEBUG
    /// Put the screen into a mid-ask state for a preview or a screenshot
    /// without starting a relay. Only `submit` relays, so a staged state
    /// simply stays put instead of resolving to an unreachable phone a few
    /// seconds later.
    func stage(question: String, activity: SiriAskActivitySnapshot?) {
        state = .asking(question: question, ref: "staged")
        self.activity = activity
    }

    /// Return to the standing hint. Previews and the screenshot lane share
    /// one router, so each must start from a known state rather than
    /// inheriting whatever the last one left behind.
    func reset() {
        relay?.cancel()
        relay = nil
        state = .idle
        activity = nil
    }
    #endif
}

/// Speaks an answer aloud and reports how far it has got, so the text on
/// screen can follow along word by word instead of sitting inert while audio
/// plays separately.
///
/// The on-screen text is the reliable channel; audio is best-effort (watch
/// audio routing is fussy), so setup failures are ignored rather than
/// surfaced.
@MainActor
@Observable
final class WatchSpeaker: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = WatchSpeaker()

    private let synthesizer = AVSpeechSynthesizer()
    /// The utterance currently being spoken. Delegate callbacks for a
    /// superseded utterance still arrive after a new one starts, so every
    /// callback checks identity before touching state — otherwise the old
    /// utterance's cancellation reports the new one as finished.
    private var current: AVSpeechUtterance?

    private(set) var isSpeaking = false
    /// UTF-16 offset of the end of the word being spoken — the unit speech
    /// ranges arrive in. The view shades everything before it as already-read.
    private(set) var spokenUpTo = 0
    /// The utterance currently on screen, so `replay` needs no argument.
    private(set) var text = ""

    override private init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        guard !text.isEmpty else { return }
        self.text = text
        spokenUpTo = 0
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        synthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        current = utterance
        isSpeaking = true
        synthesizer.speak(utterance)
    }

    /// Re-speak what is on screen. Missing the answer should not cost a whole
    /// fresh agent turn.
    func replay() {
        speak(text)
    }

    func stop() {
        current = nil
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        // Stopping means the reader is done with it: show the whole answer as
        // read rather than freezing the highlight mid-sentence.
        spokenUpTo = text.utf16.count
    }

    // MARK: - AVSpeechSynthesizerDelegate

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        let end = characterRange.location + characterRange.length
        Task { @MainActor in
            guard utterance === self.current else { return }
            self.spokenUpTo = end
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            guard utterance === self.current else { return }
            self.isSpeaking = false
            self.spokenUpTo = self.text.utf16.count
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            guard utterance === self.current else { return }
            self.isSpeaking = false
        }
    }
}
#endif

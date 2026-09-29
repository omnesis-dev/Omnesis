// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The copy every mic touchpoint uses for gateway dictation, so the wait and
/// the fallback read the same wherever they appear.
enum DictationCopy {
    static let refining = "Transcribing on your gateway…"
    static let fallback = "Used on-device transcript"
    static let refined = "Transcript updated"
    static let useDraft = "Use draft"
    static let cancel = "Cancel"

    /// The way out of the wait: keep the on-device draft, or cancel when
    /// there is none.
    static func skip(hasDraft: Bool) -> String {
        hasDraft ? useDraft : cancel
    }
}

/// The wait cue while the gateway transcribes a recording: a small spinner,
/// one calm line, and — when `onSkip` is given — the way out of the wait.
/// The on-device draft stays visible next to it.
@available(iOS 17.0, *)
struct DictationRefiningCue: View {
    var fontSize: CGFloat = 12
    var tint: Color = Theme.textSecondary
    /// "Use draft" when there is on-device text to keep, "Cancel" otherwise.
    var skipLabel: String = DictationCopy.useDraft
    var onSkip: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(fontSize > 13 ? .small : .mini)
                    .tint(tint)
                Text(DictationCopy.refining)
                    .font(.system(size: fontSize))
                    .foregroundStyle(tint)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(DictationCopy.refining)
            if let onSkip {
                Button(skipLabel, action: onSkip)
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("dictationSkipRefinement")
            }
        }
    }
}

/// The brief note after a gateway transcription failed and the on-device
/// text was kept.
@available(iOS 17.0, *)
struct DictationFallbackNote: View {
    static let displaySeconds: Double = 4

    var body: some View {
        Label(DictationCopy.fallback, systemImage: "iphone")
            .font(.system(size: 12))
            .foregroundStyle(Theme.textMuted)
            .labelStyle(DictationNoteLabelStyle())
            .lineLimit(1)
    }
}

/// Icon and title set tight, at caption scale.
@available(iOS 17.0, *)
private struct DictationNoteLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.font(.system(size: 11))
            configuration.title
        }
    }
}

extension View {
    /// Recedes the on-device draft while the gateway rewrites it.
    @available(iOS 17.0, *)
    func dictationDraftReceding(_ state: DictationState) -> some View {
        opacity(state == .refining ? 0.55 : 1)
    }

    /// Tells VoiceOver how a gateway transcription ended: the draft was
    /// replaced, or kept.
    @available(iOS 17.0, *)
    func dictationAnnouncements(_ speech: SpeechRecognizer) -> some View {
        onChange(of: speech.state) { oldValue, newValue in
            guard oldValue == .refining, newValue == .idle, speech.hasDraft, !speech.skippedRefinement else {
                return
            }
            let message = speech.usedOnDeviceFallback ? DictationCopy.fallback : DictationCopy.refined
            AccessibilityNotification.Announcement(message).post()
        }
    }

    /// Withdraws a fallback note a few seconds after `raised` turns on: a
    /// fallback is worth mentioning once, not for as long as the text stays on
    /// screen. Attach to a view that stays mounted; `expired` resets whenever
    /// the flag changes.
    @available(iOS 17.0, *)
    func dictationFallbackExpiry(raised: Bool, expired: Binding<Bool>) -> some View {
        task(id: raised) {
            expired.wrappedValue = false
            guard raised else { return }
            try? await Task.sleep(for: .seconds(DictationFallbackNote.displaySeconds))
            expired.wrappedValue = true
        }
    }
}
#endif

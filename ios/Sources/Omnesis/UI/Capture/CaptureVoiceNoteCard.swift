// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// A Tell Omnesis voice note in place of the transcript: that it is
/// recording or recorded, how long it is, and the way back to typing. The
/// phone's own transcript is never shown here — the gateway transcribes the
/// note.
@available(iOS 17.0, *)
struct CaptureVoiceNoteCard: View {
    let state: VoiceNoteCaptureState
    var discardDisabled = false
    let onDiscard: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let duration = state.duration(at: context.date)
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: state.isRecording ? "waveform" : "waveform.circle.fill")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(state.isRecording ? Theme.accent : Theme.textSecondary)
                    .symbolEffect(.variableColor.iterative, isActive: state.isRecording)
                    .frame(width: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Voice note · \(VoiceNoteCaptureState.clock(duration))")
                        .font(.system(size: 17, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                    Text("Your gateway will transcribe it.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textSecondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "\(state.isRecording ? "Recording" : "Voice note"), "
                        + VoiceNoteCaptureState.spokenDuration(duration)
                        + ". Your gateway will transcribe it."
                )
                Spacer(minLength: 0)
                Button(role: .destructive, action: onDiscard) {
                    Image(systemName: "trash")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(discardDisabled)
                .accessibilityLabel("Discard recording")
                .accessibilityHint("Type the note instead")
                .accessibilityIdentifier("captureDiscardRecording")
            }
            .padding(.leading, Theme.Spacing.md + 4)
            .padding(.trailing, Theme.Spacing.sm)
            .padding(.vertical, Theme.Spacing.md)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CaptureView.transcriptShape.fill(LandingPalette.fieldFill.opacity(0.72)))
        .background(CaptureView.transcriptShape.fill(.ultraThinMaterial))
        .overlay(
            CaptureView.transcriptShape
                .strokeBorder(
                    state.isRecording ? Theme.accent.opacity(0.6) : LandingPalette.fieldRim,
                    lineWidth: state.isRecording ? 1 : 0.8
                )
        )
        .clipShape(CaptureView.transcriptShape)
        .padding(.bottom, Theme.Spacing.md)
        .accessibilityIdentifier("captureVoiceNote")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Voice note card — recording") {
    CaptureVoiceNoteCard(state: .previewRecording(seconds: 12)) {}
        .padding()
        .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Voice note card — recorded") {
    CaptureVoiceNoteCard(state: .previewRecorded(seconds: 72)) {}
        .padding()
        .background(Theme.bgPrimary)
}
#endif
#endif

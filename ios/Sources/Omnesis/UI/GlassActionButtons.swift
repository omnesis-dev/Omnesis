// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// The 44pt circular glass action controls shared by the card-shaped
// surfaces such as brief detail: an icon button, a
// dictation mic, and the glass chrome they sit on. The glass treatment
// comes from the system material — Liquid Glass on iOS 26, an
// `.ultraThinMaterial` circle below — so the controls read as a
// translucent shade over the card rather than solid buttons.

/// One icon-only glass action. `busy` replaces the icon with a spinner
/// (used while a talk-back thread opens).
@available(iOS 17.0, *)
struct GlassActionIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var busy: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary.opacity(0.8))
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .modifier(GlassActionCircle())
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Liquid Glass circle for the action buttons, with a translucent
/// material fallback for systems older than iOS 26.
@available(iOS 17.0, *)
struct GlassActionCircle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(Circle().fill(Theme.bgPrimary.opacity(0.35)))
                .background(Circle().fill(.ultraThinMaterial))
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 0.5))
        }
    }
}

/// The dictation shortcut. Idle: a glass circle matching the other
/// actions. Listening: the composer's mic language — an accent-filled
/// circle with pulse rings radiating outward — so "the app is listening"
/// reads identically everywhere. Finishing shows a short spinner while
/// the recognizer finalizes the transcript.
@available(iOS 17.0, *)
struct GlassMicButton: View {
    var speech: SpeechRecognizer
    /// What dictation is about, for VoiceOver ("this brief", "this entry").
    var subjectLabel: String = "this"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if speech.isListening {
                    MicPulseRing(color: Theme.accent)
                        .frame(width: 44, height: 44)
                    Circle()
                        .fill(Theme.accent)
                        .frame(width: 44, height: 44)
                    Image(systemName: "mic.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                } else if speech.state == .finishing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(
                            speech.state == .unavailable
                                ? Theme.textMuted.opacity(0.4)
                                : Theme.textPrimary.opacity(0.8)
                        )
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .modifier(GlassMicChrome(active: speech.isListening))
        .disabled(speech.state == .unavailable || speech.state == .finishing)
        // Fire the one-time system permission prompts from the button's
        // first appearance, mirroring the agent composer's mic.
        .onAppear { speech.requestPermissionsIfNeeded() }
        .animation(.easeInOut(duration: 0.2), value: speech.isListening)
        .accessibilityLabel(
            speech.isListening
                ? "Stop dictating and send to the agent"
                : "Dictate a question about \(subjectLabel)"
        )
    }
}

/// Glass chrome for the mic while idle; while listening the accent
/// fill IS the surface, so the glass steps aside.
@available(iOS 17.0, *)
private struct GlassMicChrome: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active {
            content
        } else {
            content.modifier(GlassActionCircle())
        }
    }
}
#endif

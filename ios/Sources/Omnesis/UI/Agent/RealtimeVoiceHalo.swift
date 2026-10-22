// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

enum RealtimeVoiceActivity: Equatable {
    case quiet, user, agent

    static func resolve(
        active: Bool, muted: Bool, userSpeaking: Bool, agentSpeaking: Bool
    )
        -> Self {
        guard active else { return .quiet }
        if userSpeaking, !muted { return .user }
        if agentSpeaking { return .agent }
        return .quiet
    }
}

#if canImport(UIKit)
import SwiftUI

private struct VoiceHaloMotionKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// Lets a still preview disable motion; system Reduce Motion always wins.
    var voiceHaloMotion: Bool {
        get { self[VoiceHaloMotionKey.self] }
        set { self[VoiceHaloMotionKey.self] = newValue }
    }
}

/// Motion describes who is speaking, rather than pretending to measure loudness.
struct RealtimeVoiceHalo: View {
    let activity: RealtimeVoiceActivity
    let muted: Bool
    var size: CGFloat = 160
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.voiceHaloMotion) private var motionEnabled

    var body: some View {
        Group {
            if reduceMotion || !motionEnabled || activity == .quiet {
                artwork(phase: nil)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    let period = activity == .user ? 1.8 : 1.2
                    artwork(phase: context.date.timeIntervalSinceReferenceDate / period)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func artwork(phase: Double?) -> some View {
        let incoming = activity == .user
        let color = incoming ? Color.cyan : Theme.accent
        let disk = size * 0.58
        return ZStack {
            Circle().fill(color.opacity(activity == .quiet ? 0.06 : 0.10))
            ForEach(0 ..< 3) { index in
                let progress = phase.map { ($0 + Double(index) / 3).truncatingRemainder(dividingBy: 1) }
                let travel = progress.map { incoming ? 1 - $0 : $0 } ?? Double(index + 1) / 3
                let diameter = disk + (size - disk) * travel
                Circle()
                    .strokeBorder(color.opacity(progress.map { 0.42 * sin($0 * .pi) } ?? 0.18), lineWidth: incoming ? 2 : 1)
                    .background(Circle().fill(color.opacity(
                        progress.map { (incoming ? 0.025 : 0.045) * sin($0 * .pi) } ?? (incoming ? 0.025 : 0.045)
                    )))
                    .frame(width: diameter, height: diameter)
            }
            Circle()
                .fill(LinearGradient(
                    colors: [Theme.accent, Theme.accent.opacity(0.65)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .frame(width: disk, height: disk)
                .shadow(color: color.opacity(activity == .quiet ? 0.08 : 0.24), radius: 12)
            Image(systemName: muted ? "mic.slash.fill" : "waveform")
                .font(.system(size: disk * 0.35, weight: .medium))
                .foregroundStyle(.white)
        }
    }
}

#if DEBUG
#Preview("Voice halo · Your voice") {
    RealtimeVoiceHalo(activity: .user, muted: false).padding()
}

#Preview("Voice halo · Agent voice") {
    RealtimeVoiceHalo(activity: .agent, muted: false).padding()
}

#Preview("Voice halo · Reduced motion") {
    HStack {
        RealtimeVoiceHalo(activity: .user, muted: false)
        RealtimeVoiceHalo(activity: .agent, muted: true)
    }
    .environment(\.voiceHaloMotion, false)
    .padding()
}
#endif
#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import SwiftUI

/// The two outward, fading ripples used by Tell Omnesis on iPhone, sized
/// for the wrist. Voice changes the light, never the rhythm of the rings.
struct WatchCaptureHalo: View {
    let listening: Bool
    let level: Float
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if listening, !reduceMotion, scenePhase == .active {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    artwork(phase: context.date.timeIntervalSinceReferenceDate / 1.6)
                }
            } else {
                artwork(phase: nil)
            }
        }
        .frame(height: 96)
        .accessibilityHidden(true)
    }

    private func artwork(phase: Double?) -> some View {
        let energy = listening ? Double(level) : 0
        return ZStack {
            Circle()
                .fill(RadialGradient(
                    colors: [color.opacity(0.14 + energy * 0.12), color.opacity(0)],
                    center: .center,
                    startRadius: 16,
                    endRadius: 48
                ))
                .frame(width: 96, height: 96)
                .animation(.easeInOut(duration: 0.3), value: level)
            ForEach(0 ..< 2) { index in
                let progress = phase.map { ($0 + Double(index) / 2).truncatingRemainder(dividingBy: 1) }
                let travel = progress.map { 1 - pow(1 - $0, 2) } ?? Double(index + 1) / 2
                let opacity = progress.map { 0.48 * sin(.pi * $0) * (1 - 0.35 * $0) } ?? (listening ? 0.26 : 0.12)
                Circle()
                    .strokeBorder(color.opacity(opacity), lineWidth: 1.5)
                    .frame(width: 44 + 52 * travel, height: 44 + 52 * travel)
            }
            Image("OmnesisMark")
                .resizable()
                .scaledToFit()
                .frame(width: 36, height: 36)
                .foregroundStyle(color)
                .shadow(color: color.opacity(0.10 + energy * 0.20), radius: 7)
                .scaleEffect(reduceMotion ? 1 : 1 + energy * 0.025)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: level)
        }
    }
}
#endif

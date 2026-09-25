// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Placeholder transcript shown while a resumed conversation's messages are
/// still loading. Opening a stored conversation switches the surface to the
/// target the instant it's tapped (`AgentCoordinator.beginResume`); this
/// skeleton fills the brief gap until the real transcript lands, so
/// navigation never blocks on the network and the user always sees *a*
/// conversation taking shape rather than the previous one lingering.
///
/// A few shimmering bubble placeholders — alternating assistant (leading,
/// multi-line) and user (trailing pill) — approximate a real transcript's
/// rhythm so the moment reads as "this conversation is loading", not "empty".
@available(iOS 17.0, *)
struct AgentTranscriptSkeleton: View {
    /// Drives the highlight sweep. Animated on appear; a static mid-sweep
    /// value is perfectly legible in snapshot renders.
    @State private var shimmerPhase: CGFloat = -0.6

    var body: some View {
        GeometryReader { geo in
            let width = max(geo.size.width - Theme.Spacing.md * 2, 0)
            VStack(alignment: .leading, spacing: 16) {
                assistantBlock(width: width, lineFractions: [0.86, 0.72, 0.5])
                userBlock(width: width, fraction: 0.55)
                assistantBlock(width: width, lineFractions: [0.9, 0.76])
                userBlock(width: width, fraction: 0.4)
                assistantBlock(width: width, lineFractions: [0.8, 0.64, 0.68, 0.36])
            }
            .padding(.horizontal, Theme.Spacing.md)
            // Clear the floating menu / new-conversation buttons at the top.
            .padding(.top, 72)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .allowsHitTesting(false)
        .accessibilityElement()
        .accessibilityLabel("Loading conversation")
        .onAppear {
            withAnimation(.linear(duration: 1.25).repeatForever(autoreverses: false)) {
                shimmerPhase = 1.3
            }
        }
    }

    /// A leading-aligned stack of placeholder lines — an assistant reply.
    private func assistantBlock(width: CGFloat, lineFractions: [CGFloat]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(lineFractions.enumerated()), id: \.offset) { _, fraction in
                bar(width: width * fraction)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A trailing-aligned accent pill — a user message.
    private func userBlock(width: CGFloat, fraction: CGFloat) -> some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            bar(
                width: width * fraction,
                height: 34,
                tint: Theme.accent.opacity(0.16),
                // Match the real user bubble's corner radius (AgentBubbleViews)
                // so the placeholder reads as a message, not a boxy block.
                cornerRadius: 12
            )
        }
    }

    /// One shimmering placeholder bar. The base fill keeps the shape visible
    /// at every animation phase (and in a static snapshot); a soft highlight
    /// strip sweeps across it left-to-right.
    private func bar(
        width: CGFloat,
        height: CGFloat = 13,
        tint: Color = Theme.bgSecondary,
        cornerRadius: CGFloat = Theme.Radius.medium
    )
        -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius)
        return shape
            .fill(tint)
            .frame(width: width, height: height)
            .overlay(
                LinearGradient(
                    colors: [.clear, Color.white.opacity(0.22), .clear],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: max(width * 0.4, 1))
                .offset(x: shimmerPhase * width)
            )
            .clipShape(shape)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("AgentTranscriptSkeleton — dark") {
    AgentTranscriptSkeleton()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        .environment(\.colorScheme, .dark)
}

@available(iOS 17.0, *)
#Preview("AgentTranscriptSkeleton — light") {
    AgentTranscriptSkeleton()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        .environment(\.colorScheme, .light)
}
#endif
#endif

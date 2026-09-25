// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import SwiftUI

/// The palette of the app's two landing surfaces — the agent's empty state and
/// quick capture. Both are one calm screen with a single glowing subject in the
/// middle: the Omnesis mark on one, the microphone on the other.
///
/// Deliberately not in `Theme`: these are not reusable semantic tokens, they are
/// the four washes that compose one screen's backdrop. Putting them in `Theme`
/// would invite reuse somewhere the layering assumption doesn't hold.
///
/// Every value is adaptive. The design brief is written for dark mode — a
/// near-black navy base with blue glows — and the light variants are the same
/// idea inverted: a white base with a pale blue wash, so the screen reads as
/// "quiet with a halo" under either scheme rather than looking broken in one.
enum LandingPalette {
    /// The ground the whole screen sits on.
    static let base = Color(light: 0xFFFFFF, dark: 0x070B12)

    /// A slightly lighter navy across the upper middle, so the screen is not a
    /// flat slab. Peaks around the logo band and dies out top and bottom.
    /// Kept close to the base on purpose — this wash covers most of the screen,
    /// so any real saturation here is what makes the whole thing read as blue.
    static let lift = Color(light: 0xF4F7FC, dark: 0x0C1220)

    /// The blue behind the mark and the headline — the one place the screen is
    /// allowed to be blue.
    static let halo = Color(light: 0x4B9BFF, dark: 0x3F7DFF)

    /// Darkens the corners so the glow reads as light rather than as a tint.
    static let vignette = Color(light: 0x93A6BC, dark: 0x00030A)

    /// The mark's gradient, light to deep, top-leading to bottom-trailing.
    static let markLight = Color(hex: 0x72C7FF)
    static let markMid = Color(hex: 0x4B9BFF)
    static let markDeep = Color(hex: 0x386FFF)

    /// The colour a subject's two glow layers are drawn in.
    static let markGlow = Color(hex: 0x4B9BFF)

    // MARK: - Field chrome

    /// The translucent fill of a text surface on a landing screen — the agent
    /// composer's pill and quick capture's transcript area.
    static let fieldFill = Color(light: 0xFFFFFF, dark: 0x0C1421)

    /// Their fine outer rim — blue-gray, not neutral grey.
    static let fieldRim = Color(light: 0xC3D2E6, dark: 0x2B3D5C)

    /// The highlight along a field's upper edge, drawn additively so it catches
    /// the top curve the way a real glass lip would.
    static let fieldHighlight = Color(light: 0xFFFFFF, dark: 0x9CC4FF)
}

/// The layered wash behind a landing surface: base, an upper-middle lift, a halo
/// under the subject, and a vignette.
///
/// All gradients and blurs — no raster asset — so it costs nothing to ship and
/// scales to any device. `focusY` is the subject's centre in unit space so the
/// halo tracks it instead of a magic constant that drifts when the layout moves.
struct LandingBackdrop: View {
    var focusY: CGFloat = 0.44

    var body: some View {
        GeometryReader { proxy in
            let diagonal = max(proxy.size.width, proxy.size.height)

            ZStack {
                LandingPalette.base

                // Upper-middle lift. Zero at both ends so it never draws an edge.
                LinearGradient(
                    stops: [
                        .init(color: LandingPalette.lift.opacity(0), location: 0.0),
                        .init(color: LandingPalette.lift, location: 0.40),
                        .init(color: LandingPalette.lift.opacity(0), location: 0.92),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )

                // The halo behind the mark and headline. Three stops rather than
                // two: a single linear falloff reads as a spotlight, and the brief
                // asks for diffuse. Held to roughly the upper half of the screen —
                // spread wider it stops being a halo and becomes a blue screen.
                RadialGradient(
                    stops: [
                        .init(color: LandingPalette.halo.opacity(0.17), location: 0.0),
                        .init(color: LandingPalette.halo.opacity(0.06), location: 0.34),
                        .init(color: LandingPalette.halo.opacity(0.018), location: 0.62),
                        .init(color: LandingPalette.halo.opacity(0), location: 1.0),
                    ],
                    center: UnitPoint(x: 0.5, y: focusY),
                    startRadius: 0,
                    endRadius: diagonal * 0.52
                )

                // No glow under the composer. The pill is chrome, not a light
                // source, and one below the mark's read as a second sun.

                // Vignette. Clear well past the centre so it only ever touches the
                // corners — but firm there, since it is what keeps the halo
                // legible as light instead of an overall tint.
                RadialGradient(
                    stops: [
                        .init(color: LandingPalette.vignette.opacity(0), location: 0.0),
                        .init(color: LandingPalette.vignette.opacity(0), location: 0.48),
                        .init(color: LandingPalette.vignette.opacity(0.55), location: 1.0),
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: diagonal * 0.74
                )
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

/// A landing surface's subject: a glyph filled with the landing blue and lit from
/// behind by two glow layers — a wide ambient one, and a tight bloom on the
/// strokes themselves.
///
/// The glow sits behind the shape and never on it, which is the difference
/// between a lit glyph and a neon one. `glowIntensity` scales only the glow, so a
/// subject can breathe without the shape itself changing brightness.
struct LandingGlyph<Glyph: View>: View {
    var size: CGFloat
    var glowIntensity: Double = 1

    @ViewBuilder var glyph: () -> Glyph

    var body: some View {
        ZStack {
            // Ambient: large and faint, the light the subject spills on the backdrop.
            glyph()
                .foregroundStyle(LandingPalette.markGlow)
                .blur(radius: size * 0.30)
                .opacity(0.40 * glowIntensity)

            // Close: tight and stronger, the bloom on the strokes themselves.
            glyph()
                .foregroundStyle(LandingPalette.markGlow)
                .blur(radius: size * 0.10)
                .opacity(0.55 * glowIntensity)

            LinearGradient(
                colors: [
                    LandingPalette.markLight,
                    LandingPalette.markMid,
                    LandingPalette.markDeep,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .frame(width: size, height: size)
            .mask { glyph() }
        }
        .frame(width: size, height: size)
    }
}

/// The Omnesis mark, as the agent landing screen's subject.
///
/// The asset is the canonical vector (`OmnesisMark`, a vector-preserving PDF cut
/// from `assets/brand/omnesis-mark-white.svg`) drawn as a **template**, so the
/// shape is never redrawn or approximated here — it is masked. Drawing the
/// artwork directly would paint its white fill.
struct OmnesisMarkGlyph: View {
    var width: CGFloat = 88

    var body: some View {
        LandingGlyph(size: width) {
            Image("OmnesisMark")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: width, height: width)
        }
        .accessibilityHidden(true)
    }
}

/// The microphone, as quick capture's subject — the same treatment the mark gets
/// on the agent landing screen, breathing while the recogniser is hot.
///
/// The breath is a slow scale on the glyph with a stronger swell in the glow: on
/// a screen this diffuse, expanding rings would read as a different design
/// language, where a subject that visibly breathes says "listening" on its own.
struct LandingMicGlyph: View {
    var isListening: Bool
    var size: CGFloat = 96

    @State private var breathing = false

    private var glyph: some View {
        Image(systemName: "mic.fill")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }

    var body: some View {
        LandingGlyph(size: size, glowIntensity: breathing ? 1.5 : 1) { glyph }
            .scaleEffect(breathing ? 1.05 : 1)
            .animation(
                isListening
                    ? .easeInOut(duration: 1.1).repeatForever(autoreverses: true)
                    : .easeInOut(duration: 0.25),
                value: breathing
            )
            .onAppear { breathing = isListening }
            // A view recycled while listening keeps `breathing == true`, fires no
            // new animation transaction, and freezes mid-breath — so the flag is
            // driven off appearance as well as off the state it reflects.
            .onDisappear { breathing = false }
            .onChange(of: isListening) { _, listening in breathing = listening }
            .accessibilityHidden(true)
    }
}

/// The microphone when speech is unavailable: no gradient, no glow. It is not a
/// lit subject — it is the reason the screen cannot listen.
struct LandingMicUnavailableGlyph: View {
    var size: CGFloat = 96

    var body: some View {
        Image(systemName: "mic.slash.fill")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(Theme.textMuted)
            .accessibilityHidden(true)
    }
}

#if DEBUG
#Preview("Landing backdrop") {
    ZStack {
        LandingBackdrop()
        OmnesisMarkGlyph()
    }
    .omnesisColorScheme()
}

#Preview("Landing backdrop — light") {
    ZStack {
        LandingBackdrop()
        OmnesisMarkGlyph()
    }
    .preferredColorScheme(.light)
}
#endif
#endif

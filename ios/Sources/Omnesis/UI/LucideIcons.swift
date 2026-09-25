// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// SwiftUI `Shape` ports of selected Lucide icons. Lucide publishes
// 24×24 viewBox SVGs that stroke each path with `stroke-linecap:
// round`, `stroke-linejoin: round`, and `stroke-width: 2`. Each
// shape below traces the same path so the SwiftUI rendering
// visually matches what the portal draws from the same SVG.
//
// Add new icons here when SF Symbols doesn't have a close-enough
// match. Keep the vertex coordinates and arc params close to the
// upstream SVG so future Lucide updates can be ported by re-reading
// the icon file.

// MARK: - SVG arc helper

/// Append a circular arc to `path` using SVG endpoint-form params:
/// the existing current point is the implicit start, `to` is the
/// end point. `sweepFlag` mirrors SVG's `sweep-flag`:
///   - 0 → arc bends in the visually-CCW direction (y-down screen)
///   - 1 → arc bends in the visually-CW direction
/// Assumes `large-arc-flag = 0` (short arc < 180°) and circular
/// arcs (rx == ry) — every arc in Lucide's `timeline` and `quote`
/// icons satisfies this.
private func appendSvgArc(
    to path: inout Path,
    from start: CGPoint,
    to end: CGPoint,
    radius r: CGFloat,
    sweepFlag: Int
) {
    let dx = end.x - start.x
    let dy = end.y - start.y
    let d = (dx * dx + dy * dy).squareRoot()
    if d < 1e-6 { return }
    let halfChord = d / 2
    // Numerical guard: when the chord is essentially equal to the
    // diameter, h underflows to a tiny negative. Clamp to 0.
    let h = max(0, r * r - halfChord * halfChord).squareRoot()
    let mx = (start.x + end.x) / 2
    let my = (start.y + end.y) / 2
    // Unit perpendicular to the chord (rotated 90° CCW in math).
    let px = -dy / d
    let py = dx / d
    // Sign convention verified against Lucide's `timeline` BL-lobe
    // arc: from (9.414, 5.414) → (10.828, 6), r=2, sweep=0 must
    // produce centre (10.828, 4).
    let sign: CGFloat = (sweepFlag == 0) ? -1 : 1
    let cx = mx + sign * h * px
    let cy = my + sign * h * py
    let center = CGPoint(x: cx, y: cy)
    let startAngle = atan2(start.y - cy, start.x - cx)
    let endAngle = atan2(end.y - cy, end.x - cx)
    // SwiftUI `clockwise: true` traces in visually-CW direction
    // (angles increasing in y-down screen space). SVG sweep=1 means
    // the same thing → map directly.
    path.addArc(
        center: center,
        radius: r,
        startAngle: .radians(startAngle),
        endAngle: .radians(endAngle),
        clockwise: sweepFlag == 1
    )
}

// MARK: - timeline

/// Lucide `timeline`: five dots on the left joined by three
/// leftward-pointing rounded "arrow" rectangles reaching right.
/// Source: <https://lucide.dev/icons/timeline> — viewBox 24, 8
/// paths. Dots at `x=4`, rows `y={4, 8, 12, 16, 20}`; three
/// arrow-rectangles whose tips point at rows 1, 3, 5.
@available(iOS 17.0, *)
struct LucideTimelineShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        var path = Path()

        // Five dots: Lucide's `M4 yh.01` — a zero-length stroked
        // line with a round cap renders as a filled circle of
        // diameter = stroke width.
        for y in [CGFloat(4), 8, 12, 16, 20] {
            path.move(to: CGPoint(x: 4 * s, y: y * s))
            path.addLine(to: CGPoint(x: 4.01 * s, y: y * s))
        }

        appendArrow(to: &path, tipY: 4, scale: s)
        appendArrow(to: &path, tipY: 12, scale: s)
        appendArrow(to: &path, tipY: 20, scale: s)

        return path
    }

    /// One arrow-rectangle from Lucide's path data:
    ///   `M9.414 (tipY+1.414) a2 2 0 0 0 1.414 .586 H19 a1 1 0 0 0 1 -1
    ///    v-2 a1 1 0 0 0 -1 -1 h-8.172 a2 2 0 0 0 -1.414 .586 L8 tipY z`
    /// scaled into screen units.
    private func appendArrow(to path: inout Path, tipY: CGFloat, scale s: CGFloat) {
        let tip = CGPoint(x: 8 * s, y: tipY * s)
        path.move(to: CGPoint(x: 9.414 * s, y: (tipY + 1.414) * s))
        appendSvgArc(
            to: &path,
            from: CGPoint(x: 9.414 * s, y: (tipY + 1.414) * s),
            to: CGPoint(x: 10.828 * s, y: (tipY + 2) * s),
            radius: 2 * s, sweepFlag: 0
        )
        path.addLine(to: CGPoint(x: 19 * s, y: (tipY + 2) * s))
        appendSvgArc(
            to: &path,
            from: CGPoint(x: 19 * s, y: (tipY + 2) * s),
            to: CGPoint(x: 20 * s, y: (tipY + 1) * s),
            radius: 1 * s, sweepFlag: 0
        )
        path.addLine(to: CGPoint(x: 20 * s, y: (tipY - 1) * s))
        appendSvgArc(
            to: &path,
            from: CGPoint(x: 20 * s, y: (tipY - 1) * s),
            to: CGPoint(x: 19 * s, y: (tipY - 2) * s),
            radius: 1 * s, sweepFlag: 0
        )
        path.addLine(to: CGPoint(x: 10.828 * s, y: (tipY - 2) * s))
        appendSvgArc(
            to: &path,
            from: CGPoint(x: 10.828 * s, y: (tipY - 2) * s),
            to: CGPoint(x: 9.414 * s, y: (tipY - 1.414) * s),
            radius: 2 * s, sweepFlag: 0
        )
        path.addLine(to: tip)
        path.closeSubpath()
    }
}

// MARK: - quote

/// Lucide `quote`: a pair of quotation-mark hooks. Both hooks share
/// identical SVG path commands; the left hook is the right hook
/// translated by -11 in x (right starts at `M16 3`, left at `M5 3`).
/// Source: <https://lucide.dev/icons/quote>.
@available(iOS 17.0, *)
struct LucideQuoteShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        var path = Path()
        // Right hook spans x ∈ [14, 21]; left hook spans x ∈ [3, 10]
        // — same shape translated, NOT mirrored.
        appendHook(to: &path, dx: 0, scale: s)
        appendHook(to: &path, dx: -11, scale: s)
        return path
    }

    /// Trace one quote-mark hook with an x-offset. Lucide's path
    /// (right hook, dx=0):
    ///   M16 3 a2 2 0 0 0 -2 2 v6 a2 2 0 0 0 2 2 a1 1 0 0 1 1 1 v1
    ///   a2 2 0 0 1 -2 2 a1 1 0 0 0 -1 1 v2 a1 1 0 0 0 1 1
    ///   a6 6 0 0 0 6 -6 V5 a2 2 0 0 0 -2 -2 z
    /// The left hook (dx=-11) uses the same commands; only the
    /// origin shifts. The shape is asymmetric: the upper-right
    /// corner is a tight 2pt arc, the lower-left a sweeping 6pt
    /// arc — both hooks face the same direction (hook opening
    /// down-and-left toward the centre).
    private func appendHook(to path: inout Path, dx: CGFloat, scale s: CGFloat) {
        func X(_ x: CGFloat) -> CGFloat {
            (x + dx) * s
        }

        path.move(to: CGPoint(x: X(16), y: 3 * s))
        // a2 2 0 0 0 -2 2 → (14, 5)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(16), y: 3 * s),
            to: CGPoint(x: X(14), y: 5 * s),
            radius: 2 * s, sweepFlag: 0
        )
        // v6 → (14, 11)
        path.addLine(to: CGPoint(x: X(14), y: 11 * s))
        // a2 2 0 0 0 2 2 → (16, 13)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(14), y: 11 * s),
            to: CGPoint(x: X(16), y: 13 * s),
            radius: 2 * s, sweepFlag: 0
        )
        // a1 1 0 0 1 1 1 → (17, 14)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(16), y: 13 * s),
            to: CGPoint(x: X(17), y: 14 * s),
            radius: 1 * s, sweepFlag: 1
        )
        // v1 → (17, 15)
        path.addLine(to: CGPoint(x: X(17), y: 15 * s))
        // a2 2 0 0 1 -2 2 → (15, 17)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(17), y: 15 * s),
            to: CGPoint(x: X(15), y: 17 * s),
            radius: 2 * s, sweepFlag: 1
        )
        // a1 1 0 0 0 -1 1 → (14, 18)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(15), y: 17 * s),
            to: CGPoint(x: X(14), y: 18 * s),
            radius: 1 * s, sweepFlag: 0
        )
        // v2 → (14, 20)
        path.addLine(to: CGPoint(x: X(14), y: 20 * s))
        // a1 1 0 0 0 1 1 → (15, 21)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(14), y: 20 * s),
            to: CGPoint(x: X(15), y: 21 * s),
            radius: 1 * s, sweepFlag: 0
        )
        // a6 6 0 0 0 6 -6 → (21, 15)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(15), y: 21 * s),
            to: CGPoint(x: X(21), y: 15 * s),
            radius: 6 * s, sweepFlag: 0
        )
        // V5 → (21, 5)
        path.addLine(to: CGPoint(x: X(21), y: 5 * s))
        // a2 2 0 0 0 -2 -2 → (19, 3)
        appendSvgArc(
            to: &path,
            from: CGPoint(x: X(21), y: 5 * s),
            to: CGPoint(x: X(19), y: 3 * s),
            radius: 2 * s, sweepFlag: 0
        )
        // z → close to (16, 3)
        path.closeSubpath()
    }
}

// MARK: - Rendered icon views

/// Renders a Lucide-derived shape with the same stroke style the
/// upstream SVG uses (2pt round cap / join). `lineWidth` scales
/// with the requested size when not specified.
@available(iOS 17.0, *)
struct LucideStrokedIcon<S: Shape>: View {
    let shape: S
    var size: CGFloat = 16
    var color: Color = Theme.textSecondary
    var lineWidth: CGFloat?

    var body: some View {
        let lw = lineWidth ?? max(1.5, size / 10)
        shape
            .stroke(
                color,
                style: StrokeStyle(
                    lineWidth: lw,
                    lineCap: .round,
                    lineJoin: .round
                )
            )
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

@available(iOS 17.0, *)
struct LucideTimelineIcon: View {
    var size: CGFloat = 16
    var color: Color = Theme.textSecondary
    var lineWidth: CGFloat?
    var body: some View {
        LucideStrokedIcon(
            shape: LucideTimelineShape(),
            size: size,
            color: color,
            lineWidth: lineWidth
        )
    }
}

@available(iOS 17.0, *)
struct LucideQuoteIcon: View {
    var size: CGFloat = 16
    var color: Color = Theme.textSecondary
    var lineWidth: CGFloat?
    var body: some View {
        LucideStrokedIcon(
            shape: LucideQuoteShape(),
            size: size,
            color: color,
            lineWidth: lineWidth
        )
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Lucide timeline & quote icons") {
    VStack(spacing: 20) {
        HStack(spacing: 24) {
            VStack(spacing: 6) {
                LucideTimelineIcon(size: 24)
                Text("timeline").font(.caption2).foregroundStyle(Theme.textMuted)
            }
            VStack(spacing: 6) {
                LucideQuoteIcon(size: 24)
                Text("quote").font(.caption2).foregroundStyle(Theme.textMuted)
            }
        }
        ForEach([14, 18, 28, 40], id: \.self) { size in
            HStack(spacing: 12) {
                LucideTimelineIcon(size: CGFloat(size))
                LucideQuoteIcon(size: CGFloat(size))
                Text("\(size)pt")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
    .padding(32)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif

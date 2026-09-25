// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation

/// Geometry, thresholds and the gesture decisions for the slide-out menu —
/// the menu that sits under the app, which the app slides aside to reveal.
///
/// Deliberately free of SwiftUI and UIKit so it compiles, and is tested,
/// natively on macOS in the sim-less logic lane. `MenuRevealContainer` renders
/// what these functions decide; the timing curves that need `SwiftUI.Animation`
/// live alongside it. Every value a reveal is tuned by is here, so a toolbar
/// tap, a menu row and a released drag cannot drift apart.
enum MenuReveal {
    struct ReleaseOutcome: Equatable {
        let shouldOpen: Bool
        let emitsFeedback: Bool
    }

    // MARK: - Geometry

    /// How far the app travels, as a fraction of the container width. The
    /// remainder is the strip of app left standing on the trailing edge:
    /// enough to keep the user anchored in what they were doing, and a target
    /// they can tap to come back to it.
    static let openFraction: CGFloat = 0.78

    /// Ceiling on that travel, and so on the menu's width. A fraction alone
    /// suits a phone but not an iPad, where it would give a menu wide enough
    /// to strand a row's label at one end and the Settings button at the
    /// other, with a gulf between them. Past this width the menu stops growing
    /// and the app simply keeps more of the screen.
    static let maximumMenuWidth: CGFloat = 400

    /// The leading fraction of the width in which a rightward drag reveals the
    /// menu. The trailing remainder is held clear so that edge stays
    /// unambiguously the Timeline's: the Agent surface opens its Timeline from
    /// there, and a reveal that reached the whole way would leave no part of
    /// the screen that belongs to one gesture only.
    static let gestureFraction: CGFloat = 0.8

    /// Corner radius the app's leading corners reach at full travel, matching
    /// the display's own. A constant rather than a measurement: the true
    /// display radius is exposed only through private API, which this app will
    /// not ship. 55pt is the value for the iPhone models it targets — and only
    /// the *leading* corners are ever on screen, mid-screen at that, so there
    /// is nothing beside them to be out by a point against.
    static let screenCornerRadius: CGFloat = 55

    /// Opacity and geometry of the lift shadow at full travel.
    /// `shadowOpacity` / `shadowRadius` are the dark-mode values, which
    /// never change. Light mode renders the same darkness over a
    /// quarter of the width instead — a soft edge rather than a blur
    /// (see `shadowOpacity(isLight:)` / `shadowRadius(isLight:)`).
    static let shadowOpacity: Double = 0.4
    static let shadowOpacityLight: Double = 0.3
    static let shadowRadius: CGFloat = 24
    static let shadowRadiusLight: CGFloat = 6
    static let shadowOffsetX: CGFloat = -4

    /// Shadow opacity for the current appearance. Dark keeps the full
    /// value; light renders darker but thinner (see `shadowRadius`).
    static func shadowOpacity(isLight: Bool) -> Double {
        isLight ? shadowOpacityLight : shadowOpacity
    }

    /// Shadow radius for the current appearance. Dark keeps the full
    /// blur; light quarters it for a thinner edge at the same darkness.
    static func shadowRadius(isLight: Bool) -> CGFloat {
        isLight ? shadowRadiusLight : shadowRadius
    }

    /// Opacity of the wash over the app at full travel. Deliberately slight:
    /// it only has to say "not this one just now", since the menu is already
    /// the rest of the screen. Pushed further, the app goes muddy grey in
    /// light mode and in dark mode crosses *under* the menu's own surface,
    /// which reads as the app sinking behind the menu rather than lifting off
    /// it. A hairline on the cut edge draws the separation instead, which
    /// works the same way in both.
    static let scrimOpacity: Double = 0.18

    /// The space exclusion frames and a drag's start location are both
    /// resolved in, so the two are comparable wherever in the hierarchy an
    /// excluded view happens to sit.
    static let coordinateSpace = "menuReveal"

    // MARK: - Thresholds

    /// How far through the travel a released drag must have come to settle
    /// open rather than back where it started. Applied to the distance moved
    /// during *this* drag, so it reads the same opening and closing.
    static let commitFraction: CGFloat = 1.0 / 3.0

    /// Speed (pt/s) above which the direction of the flick decides the outcome
    /// outright, whatever distance was covered.
    static let flickVelocity: CGFloat = 500

    /// Speed (pt/s) and axis dominance (1.5x ≈ within ~34° of the axis) at
    /// which a touch is claimed on velocity alone.
    static let axisMinimumVelocity: CGFloat = 150
    static let axisDominance: CGFloat = 1.5

    /// Distance (pt) at which a touch is claimed on travel alone, for the
    /// deliberate slow drag that never reaches `axisMinimumVelocity`. Without
    /// it, moving the app aside slowly would simply not work.
    static let distanceThreshold: CGFloat = 12

    // MARK: - Derived geometry

    /// The width the menu lays out in, for a container of `width`. Identical
    /// to the distance the app travels, because the menu is exactly what the
    /// app uncovers. Previews and snapshots of the menu on its own use this so
    /// they render it at the width it actually gets.
    static func menuWidth(forContainerWidth width: CGFloat) -> CGFloat {
        min(width * openFraction, maximumMenuWidth)
    }

    /// 0 closed, 1 fully open. The single number every visual property is
    /// derived from, so offset, scrim and corner radius cannot disagree.
    static func progress(restingDistance: CGFloat, dragDistance: CGFloat, travel: CGFloat) -> CGFloat {
        guard travel > 0 else { return 0 }
        return clamped(unit: (restingDistance + dragDistance) / travel)
    }

    static func clamped(unit value: CGFloat) -> CGFloat {
        min(max(value, 0), 1)
    }

    /// Holds a drag to the travel still available in its direction, so a drag
    /// reversed past where it began pins at rest instead of overshooting.
    static func clampDragDistance(
        _ translation: CGFloat,
        restingDistance: CGFloat,
        travel: CGFloat
    )
        -> CGFloat {
        min(max(translation, -restingDistance), travel - restingDistance)
    }

    // MARK: - Gesture decisions

    /// What a touch has been judged to be. Decided while `.undetermined` and
    /// then held for the rest of the touch, so an ambiguous early wobble
    /// cannot flip the app back and forth across the boundary.
    enum DragMode: Equatable {
        case undetermined
        /// Claimed as a reveal; the app follows the finger.
        case horizontal
        /// Yielded to whatever scrolls underneath, for the rest of the touch.
        case vertical
    }

    /// Judge a touch. A drag only ever moves the menu *towards* its other
    /// state, and — while the menu is closed — only if it began clear of any
    /// region that scrolls horizontally itself.
    ///
    /// Claimed on either a decisive velocity or enough accumulated distance:
    /// velocity alone misses the slow deliberate drag, distance alone is slow
    /// to respond to a flick.
    static func mode(
        velocity: CGPoint,
        startLocation: CGPoint,
        translation: CGPoint,
        width: CGFloat,
        isOpen: Bool,
        exclusions: [CGRect]
    )
        -> DragMode {
        let (absVx, absVy) = (abs(velocity.x), abs(velocity.y))
        let (absDx, absDy) = (abs(translation.x), abs(translation.y))

        let horizontalByVelocity = absVx > axisMinimumVelocity && absVx > absVy * axisDominance
        let horizontalByDistance = absDx > distanceThreshold && absDx > absDy * axisDominance
        guard horizontalByVelocity || horizontalByDistance else {
            let verticalByVelocity = absVy > axisMinimumVelocity && absVy > absVx * axisDominance
            let verticalByDistance = absDy > distanceThreshold && absDy > absDx * axisDominance
            return verticalByVelocity || verticalByDistance ? .vertical : .undetermined
        }

        // Direction is read from whichever signal claimed the touch, so a
        // flick and a slow drag agree about which way the finger is going.
        let goingRight = horizontalByVelocity ? velocity.x > 0 : translation.x > 0
        if isOpen {
            return goingRight ? .undetermined : .horizontal
        }
        guard goingRight,
              startLocation.x <= width * gestureFraction,
              !exclusions.contains(where: { $0.contains(startLocation) })
        else {
            return .undetermined
        }
        return .horizontal
    }

    /// Where a released drag settles: a decisive flick decides on direction
    /// alone, otherwise the distance moved during this drag has to have
    /// crossed `commitFraction` of the travel.
    static func shouldOpen(
        velocity: CGFloat,
        dragDistance: CGFloat,
        travel: CGFloat,
        isOpen: Bool
    )
        -> Bool {
        if abs(velocity) > flickVelocity { return velocity > 0 }
        let threshold = travel * commitFraction
        return isOpen ? dragDistance > -threshold : dragDistance > threshold
    }

    /// Resolve a released drag and whether its settle crosses to the opposite
    /// resting state. A nudge that returns to where it started stays silent.
    static func releaseOutcome(
        velocity: CGFloat,
        dragDistance: CGFloat,
        travel: CGFloat,
        isOpen: Bool
    )
        -> ReleaseOutcome {
        let shouldOpen = shouldOpen(
            velocity: velocity,
            dragDistance: dragDistance,
            travel: travel,
            isOpen: isOpen
        )
        return ReleaseOutcome(shouldOpen: shouldOpen, emitsFeedback: isOpen != shouldOpen)
    }

    /// Launch speed for the settle, as a fraction of the remaining distance
    /// per second — the form `interpolatingSpring` takes. Zero when there is
    /// effectively nothing left to travel, which would otherwise divide by
    /// approximately nothing.
    static func initialVelocity(velocity: CGFloat, remaining: CGFloat) -> Double {
        abs(remaining) > 1 ? Double(velocity / remaining) : 0
    }
}

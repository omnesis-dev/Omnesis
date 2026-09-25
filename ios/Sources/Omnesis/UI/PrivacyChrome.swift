// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

// The chrome every Privacy surface shares: the tone palette, the status chips,
// the three fixed actor glyphs, and the spine's rail and boundary hairlines.
//
// The glyphs are deliberately abstract. An exchange has exactly three actors —
// the external agent that asked, Omnesis which drafted, and the privacy check
// which decided — and each gets one fixed mark. The caller's display name is
// self-asserted, so a vendor logo would assert an identity Omnesis cannot
// verify; the reviewer is a function of Omnesis rather than a product, so it
// gets a padlock rather than anything logo-shaped. Every glyph sits at lower
// visual weight than the text label beside it, so the whole design survives
// being read in monochrome.

// MARK: - Tone palette

/// The Privacy tones, resolved. One question decides the colour: did an answer
/// reach the caller? Green says yes — with or without details removed — and
/// amber says no, whether the exchange is waiting on a decision or was refused
/// outright. A reader scanning the list is asking that question and nothing
/// else, so the two answers are the two colours and the label carries the
/// nuance between "shared" and "shared with details removed". States that have
/// not reached an outcome at all are grey rather than a third answer, and a
/// check that failed keeps the red every other failure in the app wears.
///
/// Green and amber are close in lightness, and under red-green colour blindness
/// they converge — so colour is the redundant channel here, never the only one.
/// Every chip is labelled in words that say the outcome outright, and the light
/// values are chosen dark enough to clear 4.5:1 against their own tint at the
/// chip's 11pt, which is what stops the amber reading as beige.
@available(iOS 17.0, *)
extension PrivacyTone {
    var foreground: Color {
        switch self {
        case .released: Color(light: 0x116329, dark: 0x3FB950)
        case .reduced: Color(light: 0x15702F, dark: 0x56D364)
        // Waiting on you and refused are the same answer to the question the
        // palette asks — nothing reached the caller — so they are one amber,
        // and the label says which of the two it is.
        case .review, .kept: Color(light: 0x8A5D00, dark: 0xE3B341)
        case .waiting: Color(light: 0x57606A, dark: 0x8B949E)
        case .failed: Color(light: 0xCF222E, dark: 0xF85149)
        }
    }

    var background: Color {
        foreground.opacity(0.13)
    }

    /// The in-flight state is the only one drawn without a coloured border: a
    /// coloured edge reads as a verdict, and it has not reached one.
    var bordered: Bool {
        self != .waiting
    }
}

/// The rail that marks which side of the trust boundary a band is on.
@available(iOS 17.0, *)
enum PrivacySpineStyle {
    static let outsideRail = Theme.textMuted
    static let insideRail = Theme.accent
    /// One width for every band. The reader is meant to compare a dash pattern
    /// against a solid line, and a muted grey against the accent — not a thin
    /// line against a thick one, which reads as one of them mattering more.
    static let railWidth: CGFloat = 3
    /// The space a zone keeps between its last card and the hairline that ends
    /// the band.
    static let boundaryGap: CGFloat = 14
    /// How far short of the crossing the rail stops: the crossing is a mark of
    /// its own, so the spine leaves it clear air rather than running into it.
    /// Measured to the crossing's box, not to its rule — the rule is centred in
    /// that box, under the label's line height — so what renders either side of
    /// the rule is this plus roughly nine points more.
    static let boundaryClearance: CGFloat = 6
    static let railInset: CGFloat = 7
    static let gutter: CGFloat = 28
}

// MARK: - Chips

@available(iOS 17.0, *)
struct PrivacyChip: View {
    let text: String
    let tone: PrivacyTone

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(tone.foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tone.background)
            .overlay {
                Capsule().stroke(
                    tone.bordered ? tone.foreground.opacity(0.5) : Theme.borderLight,
                    lineWidth: 1
                )
            }
            .clipShape(Capsule())
    }
}

@available(iOS 17.0, *)
struct PrivacyOutcomeChip: View {
    let outcome: PrivacyExchangeOutcome

    var body: some View {
        let display = privacyOutcomeDisplay(outcome)
        PrivacyChip(text: display.label, tone: display.tone)
    }
}

@available(iOS 17.0, *)
struct PrivacyExchangeOutcomeChip: View {
    let exchange: PrivacyExchangePresentation

    var body: some View {
        let display = privacyExchangeOutcomeDisplay(exchange)
        PrivacyChip(text: display.label, tone: display.tone)
    }
}

/// A ledger status. Renders nothing at all when the gateway supplied no status
/// or one outside the closed set — the decoder has already dropped those.
@available(iOS 17.0, *)
struct PrivacyAuditStatusChip: View {
    let status: PrivacyAuditStatusDisplay?

    var body: some View {
        if let status {
            PrivacyChip(text: status.label, tone: privacyAuditStatusTone(status.code))
        }
    }
}

/// What the privacy check found, as short labels. Never quotes the answer.
@available(iOS 17.0, *)
struct PrivacyFindingChips: View {
    let findings: [PrivacyFinding]
    var limit = 4

    var body: some View {
        let labels = privacyFindingLabels(findings, limit: limit)
        if !labels.isEmpty {
            FlowChips(labels: labels)
                // `ViewThatFits` is not itself an accessibility element, so a
                // bare label on it would be dropped. Containing the chips gives
                // the label something to attach to without hiding them.
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Information the check found")
        }
    }
}

/// Chips that wrap rather than truncate — a finding label is never abbreviated,
/// because a half-read category is worse than a taller card.
@available(iOS 17.0, *)
private struct FlowChips: View {
    let labels: [String]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Spacing.xs) {
                ForEach(labels, id: \.self) { chip($0) }
            }
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                ForEach(labels, id: \.self) { chip($0) }
            }
        }
    }

    private func chip(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.bgTertiary)
            .clipShape(Capsule())
    }
}

// MARK: - Actors

/// The three actors an exchange has. One fixed mark each — never a per-vendor
/// logo, which would dress a self-asserted name up as verified identity.
@available(iOS 17.0, *)
enum PrivacyActorKind {
    case external
    case omnesis
    case check
}

/// The actor line at the head of a spine card. The text carries the meaning;
/// the glyph is quieter reinforcement, so the card reads in monochrome.
@available(iOS 17.0, *)
struct PrivacyActorLine: View {
    let kind: PrivacyActorKind
    let label: String

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            // The glyph restates the label it sits beside, so VoiceOver reads
            // the line once rather than twice.
            glyph.accessibilityHidden(true)
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
        }
    }

    @ViewBuilder
    private var glyph: some View {
        switch kind {
        case .external:
            // An arrow leaving an enclosure: something outside the boundary,
            // reaching in. Generic for every caller by design.
            Image(systemName: "arrow.up.forward.square")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Theme.textSecondary)
        case .omnesis:
            Image("OmnesisLogo")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 15, height: 15)
                .foregroundStyle(Theme.textSecondary)
        case .check:
            // A closed padlock: the reviewer is a function of Omnesis, not a
            // vendor with a mark of its own.
            Image(systemName: "lock")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Theme.textSecondary)
        }
    }
}

// MARK: - The spine's rail

/// One unbroken stretch of the spine. Drawn as a single path over the whole
/// zone rather than as stubs between cards, so it cannot break in a gap.
@available(iOS 17.0, *)
private struct PrivacyRail: View {
    let dashed: Bool
    let color: Color

    private var width: CGFloat {
        PrivacySpineStyle.railWidth
    }

    var body: some View {
        GeometryReader { geometry in
            Path { path in
                path.move(to: CGPoint(x: width / 2, y: 0))
                path.addLine(to: CGPoint(x: width / 2, y: geometry.size.height))
            }
            .stroke(
                color,
                style: StrokeStyle(
                    lineWidth: width,
                    // A round cap on a dash would swell each one into a lozenge
                    // and close the gaps the pattern exists to show.
                    lineCap: dashed ? .butt : .round,
                    dash: dashed ? [width * 2, width * 2.2] : []
                )
            )
        }
        .frame(width: width)
        .accessibilityHidden(true)
    }
}

/// One band of the story, carrying the stretch of spine beside it. Scanning the
/// left edge alone tells the story: dashed outside, a labelled hairline at the
/// crossing, solid and accented inside, then dashed again only when something
/// actually left.
@available(iOS 17.0, *)
struct PrivacySpineZone<Content: View>: View {
    enum Band {
        case outside
        case inside
        case received
    }

    let band: Band
    /// Whether a boundary hairline follows this zone. False for the last zone,
    /// whose rail ends with its content.
    var reachesForward: Bool
    @ViewBuilder let content: Content

    init(band: Band, reachesForward: Bool = true, @ViewBuilder content: () -> Content) {
        self.band = band
        self.reachesForward = reachesForward
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, PrivacySpineStyle.gutter)
            .padding(.top, followsCrossing ? PrivacySpineStyle.boundaryGap : 0)
            .padding(.bottom, reachesForward ? PrivacySpineStyle.boundaryGap : 0)
            .overlay(alignment: .topLeading) {
                // The rail stops short of each crossing it meets, and runs to
                // the zone's own edge where the spine simply begins or ends.
                PrivacyRail(dashed: band != .inside, color: railColor)
                    .padding(.top, followsCrossing ? PrivacySpineStyle.boundaryClearance : 0)
                    .padding(.bottom, reachesForward ? PrivacySpineStyle.boundaryClearance : 0)
                    .padding(.leading, PrivacySpineStyle.railInset)
            }
    }

    /// The first zone opens the spine; every later one begins at a hairline.
    private var followsCrossing: Bool {
        band != .outside
    }

    private var railColor: Color {
        band == .inside ? PrivacySpineStyle.insideRail : PrivacySpineStyle.outsideRail
    }
}

/// The hairline where the story crosses the trust boundary.
@available(iOS 17.0, *)
struct PrivacyBoundaryLine: View {
    let label: String

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            rule
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.1)
                .foregroundStyle(Theme.textMuted)
                // The crossing is one line or it is not a hairline; the rules
                // give way before the label wraps.
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
            rule
        }
        .padding(.vertical, Theme.Spacing.xs)
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    private var rule: some View {
        Rectangle()
            .fill(Theme.border)
            .frame(height: 1)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - Formatters

@available(iOS 17.0, *)
func privacyRelativeDate(_ millis: Int64) -> String {
    Date(timeIntervalSince1970: Double(millis) / 1000)
        .formatted(.relative(presentation: .named))
}

@available(iOS 17.0, *)
func privacyAbsoluteDate(_ millis: Int64) -> String {
    Date(timeIntervalSince1970: Double(millis) / 1000)
        .formatted(date: .abbreviated, time: .standard)
}

// MARK: - Small shared pieces

/// What a banner is telling the operator. The tone is a separate axis from the
/// wording because an action that *failed* — a revoke the gateway rejected, a
/// policy edit that never landed — must not read in the same amber as an
/// advisory note about something that merely needs attention.
@available(iOS 17.0, *)
enum PrivacyBannerTone: Equatable {
    /// Something the operator asked for happened.
    case ok
    /// Advisory: nothing broke, but the state is worth knowing.
    case warning
    /// A request failed. Nothing changed, and the operator must act again.
    case error

    var color: Color {
        switch self {
        case .ok: Theme.success
        case .warning: Theme.warning
        case .error: Theme.danger
        }
    }

    var symbol: String {
        switch self {
        case .ok: "checkmark.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "xmark.octagon"
        }
    }

    /// Spoken before the text so a listener knows whether to act, the way the
    /// portal's `role="alert"` / `role="status"` distinction reads.
    var spokenPrefix: String {
        switch self {
        case .ok: ""
        case .warning: "Attention: "
        case .error: "Error: "
        }
    }
}

@available(iOS 17.0, *)
struct PrivacyBanner: View {
    let text: String
    var tone: PrivacyBannerTone = .warning

    var body: some View {
        Label(text, systemImage: tone.symbol)
            .font(.system(size: 12))
            .foregroundStyle(tone.color)
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.color.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(tone.spokenPrefix)\(text)")
            // A banner appears in response to something the operator just did,
            // or to a state they need to know about, and nothing moves focus to
            // it — so it is spoken on arrival rather than waiting to be found.
            .onAppear { UIAccessibility.post(notification: .announcement, argument: text) }
    }
}

@available(iOS 17.0, *)
struct PrivacyEmptyState: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: symbol)
                .font(.system(size: 20))
                .foregroundStyle(Theme.textMuted)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Theme.Spacing.md)
    }
}

@available(iOS 17.0, *)
struct PrivacyLoadingRow: View {
    let label: String

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ProgressView().controlSize(.small).tint(Theme.accent)
            Text(label).font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Theme.Spacing.md)
    }
}

#if DEBUG
#Preview("Privacy chrome — chips and actors") {
    ScrollView {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(
                [
                    PrivacyExchangeOutcome.shared,
                    .sharedWithReductions,
                    .needsReview,
                    .ready,
                    .notShared,
                    .failed,
                    .checking,
                ],
                id: \.self
            ) { outcome in
                PrivacyOutcomeChip(outcome: outcome)
            }
            Divider()
            PrivacyActorLine(kind: .external, label: "Atlas asked")
            PrivacyActorLine(kind: .omnesis, label: "Omnesis drafted an answer")
            PrivacyActorLine(kind: .check, label: "Privacy check")
            Divider()
            PrivacyBoundaryLine(label: "your machine")
            PrivacyFindingChips(findings: PreviewMocks.privacyReview.findings)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}

/// The spine reduced to what its left edge says: dashed outside, a crossing,
/// solid and accented inside, a second crossing, dashed again. Both rails are
/// one width, so the only differences are the dash pattern and the colour, and
/// each crossing keeps clear air above and below it. Shared with the snapshot
/// suite, which measures that clearance off this render.
@available(iOS 17.0, *)
struct PrivacySpineCrossings: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PrivacySpineZone(band: .outside) { block("Outside — the caller asked") }
            PrivacyBoundaryLine(label: "your machine")
            PrivacySpineZone(band: .inside) { block("Inside — drafted and checked") }
            PrivacyBoundaryLine(label: "left your machine")
            PrivacySpineZone(band: .received, reachesForward: false) {
                block("Outside — the caller received it")
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
    }

    private func block(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 12))
            .foregroundStyle(Theme.textSecondary)
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSecondary)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }
}

#Preview("Privacy chrome — the spine's crossings") {
    PrivacySpineCrossings()
}

#Preview("Privacy chrome — banner tones") {
    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
        PrivacyBanner(text: "Policy saved.", tone: .ok)
        PrivacyBanner(
            text: "Some recent automatic privacy checks could not complete. Any affected "
                + "answer stays inside Omnesis and requires your review.",
            tone: .warning
        )
        PrivacyBanner(text: "Couldn't connect to gateway", tone: .error)
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}
#endif

#endif

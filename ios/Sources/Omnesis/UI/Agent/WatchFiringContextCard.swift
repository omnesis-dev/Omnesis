// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The watch firing that made the agent open this conversation, rendered as
/// a card pinned above it — the sibling of `BriefContextCard`.
///
/// This thread arrives unprompted: the reader is dropped into a message
/// they did not ask for, and the briefing that produced it is hidden (agent
/// context, not user content). The card is what answers "why am I reading
/// this" — the watch they set up, in the words they set it up with, and
/// when it came true. Content is a snapshot taken when the thread opened,
/// so it survives the watch being renamed, edited or deleted.
@available(iOS 17.0, *)
struct WatchFiringContextCard: View {
    @Environment(NotificationRouter.self) private var router: NotificationRouter?
    let snapshot: WatchFiringOriginSnapshot
    let watchId: String?

    var body: some View {
        if let watchId, !watchId.isEmpty, let router {
            Button {
                router.pendingTarget = .watch(watchId: watchId)
            } label: {
                cardBody(showsOpenAffordance: true)
            }
            .buttonStyle(.plain)
            .accessibilityHint(Text("Opens watch details"))
        } else {
            cardBody(showsOpenAffordance: false)
        }
    }

    private func cardBody(showsOpenAffordance: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "bell.badge")
                    .font(.system(size: 12, weight: .semibold))
                Text("Watch fired")
                    .font(.system(size: 12, weight: .semibold))
                    .textCase(.uppercase)
                    .kerning(0.6)
                Spacer(minLength: 0)
                if showsOpenAffordance {
                    Text("View watch")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(nil)
                        .kerning(0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                }
            }
            .foregroundStyle(Theme.accent)
            Text(snapshot.name)
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(Theme.textPrimary)
            // A heading rather than a sentence stem. The condition is
            // quoted verbatim in the operator's own words — often first
            // person ("a race I entered") — so framing it as "you asked
            // to be told when…" would clash on person.
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("Watching for")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .kerning(0.5)
                    .foregroundStyle(Theme.textSecondary.opacity(0.7))
                Text(snapshot.condition)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Label(firedAtText, systemImage: "clock")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .fill(Theme.bgSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .strokeBorder(Theme.border, lineWidth: 1)
        )
    }

    private var firedAtText: String {
        Date(timeIntervalSince1970: Double(snapshot.firedAt) / 1000)
            .formatted(date: .abbreviated, time: .shortened)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("WatchFiringContextCard") {
    WatchFiringContextCard(
        snapshot: PreviewMocks.watchFiringOrigin,
        watchId: PreviewMocks.watchFiringOriginWatchId
    )
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
}

@available(iOS 17.0, *)
#Preview("WatchFiringContextCard — long condition, dark") {
    WatchFiringContextCard(
        snapshot: WatchFiringOriginSnapshot(
            name: "Anything about the Northstar rebuild that needs a decision from me this quarter",
            condition: "a contractor, the architect or the council sends anything about the "
                + "Northstar rebuild that needs a decision, a signature or a payment from me",
            firedAt: 1_789_344_600_000
        ),
        watchId: PreviewMocks.longWatchFiringOriginWatchId
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
    .environment(NotificationRouter())
}

@available(iOS 17.0, *)
#Preview("WatchFiringContextCard — legacy origin") {
    WatchFiringContextCard(snapshot: PreviewMocks.watchFiringOrigin, watchId: nil)
        .padding()
        .background(Theme.bgPrimary)
        .environment(NotificationRouter())
}
#endif
#endif

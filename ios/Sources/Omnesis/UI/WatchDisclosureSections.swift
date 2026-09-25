// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What this watch is allowed to say, and to whom.
///
/// A watch that wakes an agent crosses an egress boundary, and this is the one
/// sentence that says where its firings land. The record behind it carries a
/// good deal more — its identifier, which revision of it stands, which revision
/// of the policy judged it — and none of that is on the screen: an operator
/// reading this page is asking what the watch does, and an identifier is not an
/// answer to that.
///
/// Rendered only for a watch that has a record. One that wakes nobody made no
/// disclosure, so there is nothing to account for, and an empty section would
/// report that as something missing.
@available(iOS 17.0, *)
struct WatchDisclosureSections: View {
    let disclosure: WatchDisclosure
    var actionError: Error?
    /// Absent where nothing can be revoked — a preview, or a screen with no
    /// gateway behind it.
    var onRevoke: (() -> Void)?

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(watchDisclosureWakeSentence(disclosure))
                    .font(.subheadline)
                    .foregroundStyle(Theme.textPrimary)
                Text(
                    "A firing discloses only that a matching event exists. Anything more has "
                        + "to pass the answer privacy boundary."
                )
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
            }
            .padding(.vertical, 6)
            if let actionError {
                Label(
                    "Revoke failed: \(GatewayErrorView.classify(actionError).title)",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.caption)
                .foregroundStyle(Theme.warning)
            }
            if let onRevoke, canRevokePrivacySubscription(disclosure.status) {
                Button("Revoke this watch's access", role: .destructive, action: onRevoke)
                    .font(.subheadline)
            }
        } header: {
            Text("WHAT IT TELLS AN INTEGRATION")
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
        }
        .listRowBackground(Theme.bgPrimary)
    }
}

// MARK: - Previews

#if DEBUG

/// The sections render inside the watch's own List, so the previews give them
/// that surround rather than rendering them bare.
@available(iOS 17.0, *)
private struct WatchDisclosureHarness: View {
    let sections: WatchDisclosureSections

    var body: some View {
        List { sections }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .preferredColorScheme(.dark)
    }
}

@available(iOS 17.0, *)
#Preview("Disclosure — approved and reaching out") {
    WatchDisclosureHarness(
        sections: WatchDisclosureSections(
            disclosure: PreviewMocks.watchDisclosure,
            onRevoke: {}
        )
    )
}

@available(iOS 17.0, *)
#Preview("Disclosure — the operator's own wake") {
    // Nothing was put to them for approval, because the request was theirs.
    WatchDisclosureHarness(
        sections: WatchDisclosureSections(
            disclosure: PreviewMocks.watchDisclosureUnapproved,
            onRevoke: {}
        )
    )
}

@available(iOS 17.0, *)
#Preview("Disclosure — access revoked") {
    // Terminal: nothing left to revoke, so the button is gone.
    WatchDisclosureHarness(
        sections: WatchDisclosureSections(
            disclosure: PreviewMocks.watchDisclosureRevoked,
            onRevoke: {}
        )
    )
}

@available(iOS 17.0, *)
#Preview("Disclosure — revoking failed") {
    WatchDisclosureHarness(
        sections: WatchDisclosureSections(
            disclosure: PreviewMocks.watchDisclosure,
            actionError: URLError(.cannotConnectToHost),
            onRevoke: {}
        )
    )
}
#endif
#endif

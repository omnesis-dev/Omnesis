// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

#if canImport(UIKit)
/// One device waiting to join through the owner's Tailscale network, as Waiting for your OK lists
/// it beside the devices that signed in: who wants to connect and how it asked, the machine
/// and Tailscale account it came from, when it asked and when the request runs out, then
/// Approve and Deny.
@available(iOS 17.0, *)
struct TailscaleJoinRequestRow: View {
    let request: TailscaleJoinRequest
    /// A decision is being sent for this request.
    let deciding: Bool
    /// A decision is being sent for some request, so none can be decided now.
    let busy: Bool
    let onDecide: (_ approve: Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text(PairingApprovalPresentation.headline(request.name))
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                Text(TailscaleJoinPresentation.kindLine(request))
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                ForEach(origin, id: \.self) { line in
                    Text(line).font(.subheadline).foregroundStyle(Theme.textSecondary)
                }
            }
            Text(TailscaleJoinPresentation.recognise)
                .foregroundStyle(Theme.textPrimary)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                if let timing = TailscaleJoinPresentation.timingLine(request, now: context.date) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        Text(timing).font(.caption).foregroundStyle(Theme.textMuted)
                        decisionControls
                    }
                } else {
                    Text(TailscaleJoinPresentation.expired).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, Theme.Spacing.xs)
        .accessibilityIdentifier("tailscaleJoin.request")
    }

    /// The machine and the Tailscale account, each when the gateway named it.
    private var origin: [String] {
        [TailscaleJoinPresentation.machineLine(request), TailscaleJoinPresentation.accountLine(request)].compactMap(\.self)
    }

    /// Approve above Deny, full width, as for a device that signed in.
    private var decisionControls: some View {
        VStack(spacing: Theme.Spacing.md) {
            Button { onDecide(true) } label: {
                Group {
                    if deciding {
                        ProgressView().tint(.white)
                    } else {
                        Text(TailscaleJoinPresentation.approve)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .accessibilityIdentifier("tailscaleJoin.approve")
            Button(role: .destructive) { onDecide(false) } label: {
                Text(TailscaleJoinPresentation.deny).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("tailscaleJoin.deny")
        }
        .controlSize(.large)
        .disabled(busy)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Tailscale request — collector") {
    List {
        Section {
            TailscaleJoinRequestRow(request: PreviewMocks.tailscaleJoinRows[0], deciding: false, busy: false, onDecide: { _ in })
        }
        .listRowBackground(Theme.bgSecondary)
    }
    .scrollContentBackground(.hidden)
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Tailscale request — approving") {
    List {
        Section {
            TailscaleJoinRequestRow(request: PreviewMocks.tailscaleJoinRows[1], deciding: true, busy: true, onDecide: { _ in })
        }
        .listRowBackground(Theme.bgSecondary)
    }
    .scrollContentBackground(.hidden)
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Tailscale request — expired") {
    List {
        Section {
            TailscaleJoinRequestRow(request: PreviewMocks.tailscaleJoinExpired, deciding: false, busy: false, onDecide: { _ in })
        }
        .listRowBackground(Theme.bgSecondary)
    }
    .scrollContentBackground(.hidden)
    .background(Theme.bgPrimary)
}
#endif
#endif

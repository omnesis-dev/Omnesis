// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// This iPhone signed in and the gateway holds it until the owner says yes. One state: where to
/// approve, the code that place will show, how long it waits, and a way out.
@available(iOS 17.0, *)
struct AccountPairingWaitingView: View {
    let code: String?
    let approved: Bool
    let pairing: Bool
    let expiresAt: Date?
    let continuesOnApproval: Bool
    let approvalPageAvailable: Bool
    let onApprovalPage: () -> Void
    let onPair: () -> Void
    let onCancel: () -> Void

    private var offersApprovalPage: Bool {
        approvalPageAvailable && !approved
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Image(systemName: approved ? "checkmark.circle" : "clock")
                .font(.system(size: 36))
                .foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            Text(approved ? PairingWaitingPresentation.approvedTitle : PairingWaitingPresentation.title)
                .font(.title2.bold())
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            approvalPlace
            if let code {
                PairingCodeText(code: code)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, Theme.Spacing.sm)
            }
            if !approved, let expiresAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(PairingWaitingPresentation.expiry(remaining: expiresAt.timeIntervalSince(context.date)))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .accessibilityIdentifier("pairing.account.expiry")
            }
            actions
        }
        .accessibilityIdentifier("pairing.account.waitingForOK")
    }

    /// Where the owner approves: the gateway's own page with Face ID when that can work, otherwise
    /// a device they already use. A legacy approval asks this person to confirm the codes.
    @ViewBuilder private var approvalPlace: some View {
        if approved {
            Text(continuesOnApproval ? PairingWaitingPresentation.approved : PairingWaitingPresentation.compare)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        } else if offersApprovalPage {
            Text(PairingWaitingPresentation.withFaceID)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(PairingWaitingPresentation.fromAnotherDevice)
                ForEach(PairingWaitingPresentation.places, id: \.self) { place in
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                        Text("•").accessibilityHidden(true)
                        Text(place)
                    }
                }
                Text(PairingWaitingPresentation.codeLead)
            }
            .foregroundStyle(Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actions: some View {
        VStack(spacing: Theme.Spacing.md) {
            if offersApprovalPage {
                Button(action: onApprovalPage) {
                    Label(PairingWaitingPresentation.approveWithFaceID, systemImage: "faceid").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .accessibilityIdentifier("pairing.account.approvalPage")
            }
            // Only a gateway this iPhone could not verify needs the person's word that the codes matched.
            if !continuesOnApproval, approved || pairing {
                Button(action: onPair) {
                    Text(pairing ? PairingWaitingPresentation.connecting : PairingWaitingPresentation.confirm)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(pairing)
                .accessibilityIdentifier("pairing.account.confirm")
            }
            if !pairing {
                Button(PairingWaitingPresentation.cancel, role: .cancel, action: onCancel)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("pairing.account.cancel")
            }
        }
        .controlSize(.large)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Waiting for your OK") {
    ScrollView { PreviewMocks.accountPairingWaiting().padding() }
}

@available(iOS 17.0, *)
#Preview("Waiting for your OK — Face ID on the gateway, dark") {
    ScrollView { PreviewMocks.accountPairingWaiting(approvalPage: true).padding() }.preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Waiting for your OK — approved, codes to confirm") {
    ScrollView { PreviewMocks.accountPairingWaiting(approved: true, continues: false).padding() }
}

@available(iOS 17.0, *)
#Preview("Waiting for your OK — large text") {
    ScrollView { PreviewMocks.accountPairingWaiting().padding() }.dynamicTypeSize(.accessibility2)
}
#endif
#endif

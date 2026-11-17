// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The first pairing step of a build with an Omnesis account. Sign-in runs on this one screen: its
/// progress replaces the choices, and a failure brings them back with the reason beside them.
@available(iOS 17.0, *)
struct AccountCloudPairingView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: AccountCloudPairingCoordinator
    let configuration: AccountCloudPairingConfiguration
    let onScan: () -> Void
    let onManual: () -> Void

    init(
        configuration: AccountCloudPairingConfiguration,
        model: AccountCloudPairingCoordinator? = nil,
        onScan: @escaping () -> Void,
        onManual: @escaping () -> Void
    ) {
        self.configuration = configuration
        self.onScan = onScan
        self.onManual = onManual
        _model = State(initialValue: model ?? AccountCloudPairingCoordinator(approvalBrowser: OmnesisAccountSystemBrowser()))
    }

    private var choosing: Bool {
        model.phase == .idle || model.phase == .failed
    }

    var body: some View {
        AccountCloudPairingPanel(
            phase: model.phase,
            gateways: model.gateways,
            verificationCode: model.verificationCode,
            gatewayHost: model.gatewayHost,
            approved: model.gatewayApproved,
            error: model.error,
            googleAvailable: configuration.google != nil,
            passkeysAvailable: configuration.passkeysEnabled,
            onGoogle: { model.start(configuration: configuration, method: .google) },
            onPasskey: { model.start(configuration: configuration, method: .passkey) },
            onChoose: { model.choose($0) },
            onPair: pair,
            onScan: onScan,
            onManual: onManual,
            approvalPageAvailable: model.approvalPage != nil,
            onApprovalPage: { model.openApprovalPage() },
            expiresAt: model.expiresAt,
            continuesOnApproval: model.continuesOnApproval,
            onCancel: { model.cancel() }
        )
        .onChange(of: model.phase) { _, phase in
            // The gateway joined this device, or the owner approved it on a device they already
            // use and this iPhone checked the gateway's code: there is nothing left to compare.
            if phase == .joining { pair() }
        }
        .navigationTitle("Pair with your gateway")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                // Cancel leaves a sign-in in progress first, and pairing only from the choices.
                Button("Cancel") {
                    if choosing { dismiss() } else { model.cancel() }
                }
                .disabled(model.phase == .pairing)
            }
        }
        .onDisappear { model.cancel() }
        .interactiveDismissDisabled(model.phase == .pairing)
    }

    private func pair() {
        Task {
            await model.complete { raw in
                let previous = store.pairing?.pairingGeneration
                await store.pairAsync(raw: raw)
                return model.acceptsCompletedPairing(store.pairing, previousGeneration: previous)
            }
            if model.phase == .idle { dismiss() }
        }
    }
}

@available(iOS 17.0, *)
struct AccountCloudPairingPanel: View {
    let phase: AccountCloudPairingCoordinator.Phase
    let gateways: [AccountGatewayChoice]
    let verificationCode: String?
    let gatewayHost: String?
    let approved: Bool
    let error: Error?
    let googleAvailable: Bool
    let passkeysAvailable: Bool
    let onGoogle: () -> Void
    let onPasskey: () -> Void
    let onChoose: (String) -> Void
    let onPair: () -> Void
    let onScan: () -> Void
    let onManual: () -> Void
    /// Whether the gateway offers its own page to approve this request with a confirmed passkey.
    var approvalPageAvailable = false
    var onApprovalPage: () -> Void = {}
    /// When the gateway stops waiting for this request.
    var expiresAt: Date?
    /// An approval continues by itself; otherwise the person confirms the codes once approved.
    var continuesOnApproval = false
    var onCancel: () -> Void = {}

    private var waiting: Bool {
        phase == .comparing || phase == .pairing
    }

    var body: some View {
        if phase == .idle || phase == .failed {
            PairingAccountEntryView(
                googleAvailable: googleAvailable,
                passkeysAvailable: passkeysAvailable,
                notice: (error as? AccountPairingError)?.signInNotice,
                failure: error.map(accountPairingErrorMessage),
                onGoogle: onGoogle,
                onPasskey: onPasskey,
                onScan: onScan,
                onManual: onManual
            )
        } else {
            progress
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(phase == .choosing ? "Choose a gateway" : "Pair using your Omnesis Account")
                .font(.title3.bold())
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(
                phase == .choosing
                    ? "Your Omnesis account has more than one. Pick the one this device joins."
                    : PairingAccountEntryView.accountDetail
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var progress: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if !waiting { header }
                switch phase {
                case .idle, .failed:
                    EmptyView()
                case .connecting:
                    VStack(alignment: .leading, spacing: 12) {
                        ProgressView()
                        Text("Connecting securely…").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                case .signingIn:
                    VStack(alignment: .leading, spacing: 12) {
                        ProgressView()
                        Text("Complete sign-in in the system dialog.").foregroundStyle(.secondary).fixedSize(
                            horizontal: false,
                            vertical: true
                        )
                    }
                case .finding:
                    VStack(alignment: .leading, spacing: 12) {
                        ProgressView()
                        Text("Finding your gateways…").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                case .choosing:
                    VStack(spacing: 10) {
                        ForEach(gateways) { gateway in
                            Button { onChoose(gateway.gatewayId) } label: { AccountGatewayRow(gateway: gateway) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("pairing.account.gateway.\(gateway.gatewayId)")
                        }
                    }
                case .waitingForGateway:
                    VStack(alignment: .leading, spacing: 12) {
                        ProgressView()
                        Text("Waiting for your gateway to come online")
                            .font(.headline)
                            .foregroundStyle(Theme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Keep this screen open. This continues on its own when your gateway is back.")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }.accessibilityIdentifier("pairing.account.waiting")
                case .joining:
                    VStack(alignment: .leading, spacing: 12) {
                        ProgressView()
                        // A code on screen means the owner approved a held request; none, that the gateway joined it.
                        Text(verificationCode == nil ? "Connecting this device…" : PairingWaitingPresentation.approved)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                case .comparing, .pairing:
                    AccountPairingWaitingView(
                        code: verificationCode,
                        approved: approved,
                        pairing: phase == .pairing,
                        expiresAt: expiresAt,
                        continuesOnApproval: continuesOnApproval,
                        approvalPageAvailable: approvalPageAvailable,
                        onApprovalPage: onApprovalPage,
                        onPair: onPair,
                        onCancel: onCancel
                    )
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
    }
}

/// One gateway in the chooser. A relay address is one long unbreakable word, so it gets a single
/// line cut in the middle; the name carries the row.
@available(iOS 17.0, *)
struct AccountGatewayRow: View {
    let gateway: AccountGatewayChoice

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "server.rack")
                .font(.title3)
                .foregroundStyle(Theme.accent)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(Self.title(gateway))
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(Self.host(gateway))
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                AccountGatewayPresence(online: gateway.online)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    static func host(_ gateway: AccountGatewayChoice) -> String {
        URL(string: gateway.publicOrigin)?.host ?? gateway.publicOrigin
    }

    /// A gateway linked before names existed has none; its address stays visible on the second line.
    static func title(_ gateway: AccountGatewayChoice) -> String {
        let name = gateway.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Gateway" : name
    }
}

/// Whether the relay holds this gateway's tunnel right now. The word is always shown, so the state
/// never rests on colour alone; the dot is decoration and is not read aloud. A hint only: an offline
/// gateway can still be chosen.
@available(iOS 17.0, *)
struct AccountGatewayPresence: View {
    let online: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(online ? Theme.success : Theme.textMuted)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(Self.label(online: online))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    static func label(online: Bool) -> String {
        online ? "Online" : "Offline"
    }
}

#if DEBUG
#Preview("Omnesis account sign-in") {
    AccountCloudPairingPanel(
        phase: .idle,
        gateways: [],
        verificationCode: nil,
        gatewayHost: nil,
        approved: false,
        error: nil,
        googleAvailable: true,
        passkeysAvailable: true,
        onGoogle: {},
        onPasskey: {},
        onChoose: { _ in },
        onPair: {},
        onScan: {},
        onManual: {}
    )
}

#Preview("Choose a gateway") {
    AccountCloudPairingPanel(
        phase: .choosing,
        gateways: PreviewMocks.accountGatewayChoices,
        verificationCode: nil,
        gatewayHost: nil,
        approved: false,
        error: nil,
        googleAvailable: true,
        passkeysAvailable: true,
        onGoogle: {},
        onPasskey: {},
        onChoose: { _ in },
        onPair: {},
        onScan: {},
        onManual: {}
    )
}

#Preview("Choose a gateway, online and offline, dark") { PreviewMocks.accountPairingPanel(.choosing).preferredColorScheme(.dark) }
#Preview("Choose a gateway, large text") { PreviewMocks.accountPairingPanel(.choosing).dynamicTypeSize(.accessibility2) }

#Preview("Waiting for your OK") { PreviewMocks.accountPairingPanel(.comparing) }
#Preview("Waiting for your OK, Face ID on the gateway") { PreviewMocks.accountPairingPanel(.comparing, approvalPage: true) }
#Preview("Waiting for your OK, Face ID, large text") {
    PreviewMocks.accountPairingPanel(.comparing, approvalPage: true).dynamicTypeSize(.accessibility2)
}

#Preview("Waiting for your OK, Face ID, dark") {
    PreviewMocks.accountPairingPanel(.comparing, approvalPage: true).preferredColorScheme(.dark)
}

#Preview("Approved, codes to confirm, large text") {
    PreviewMocks.accountPairingPanel(.comparing, approved: true, continues: false).dynamicTypeSize(.accessibility2)
}

#Preview("Approved, connecting") { PreviewMocks.accountPairingPanel(.joining, approvedHeld: true) }
#Preview("Signing in") { PreviewMocks.accountPairingPanel(.signingIn) }
#Preview("No linked gateways") { PreviewMocks.accountPairingPanel(.failed).preferredColorScheme(.dark) }
#Preview("Waiting for the gateway") { PreviewMocks.accountPairingPanel(.waitingForGateway) }
#Preview("Joining") { PreviewMocks.accountPairingPanel(.joining) }
#Preview("No Omnesis account") { PreviewMocks.accountPairingPanel(.failed, error: .noAccount) }
#Preview("No Omnesis account with large text") {
    PreviewMocks.accountPairingPanel(.failed, error: .noAccount).dynamicTypeSize(.accessibility2)
}

#Preview("Sign-in expired") { PreviewMocks.accountPairingPanel(.failed, error: .expired) }
#Preview("Not your gateway") { PreviewMocks.accountPairingPanel(.failed, error: .notYourGateway) }
#Preview("Gateway needs an update") { PreviewMocks.accountPairingPanel(.failed, error: .gatewayNeedsUpdate) }
#Preview("No passkey on this iPhone") { PreviewMocks.accountPairingPanel(.failed, error: .noPasskey) }
#endif
#endif

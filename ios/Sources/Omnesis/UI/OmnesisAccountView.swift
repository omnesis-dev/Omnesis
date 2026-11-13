// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Settings → Omnesis account: the gateway's account link and remote access,
/// the native counterpart of the portal page with the same name.
///
/// The screen leads with one state and at most one primary action, then says
/// anything wrong in one box and lists the account, remote access and new devices.
/// Custom addresses, certificate directories and invitation files stay in the portal.
@available(iOS 17.0, *)
struct OmnesisAccountView: View {
    let model: OmnesisAccountModel
    let client: (any CloudRelayManaging)?
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirming: OmnesisAccountConfirmation?

    private struct Poll: Equatable {
        let active: Bool
        let interval: Duration
    }

    var body: some View {
        content
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Omnesis account")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SettingsBackButton() }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .refreshable { await model.load(client: client) }
            // Restarts when the app returns to the foreground, so the status is fresh
            // after a sign-in finished in the browser.
            .task(id: Poll(active: scenePhase == .active, interval: model.pollInterval)) { await poll() }
            .confirmationDialog(
                CloudRelayPresentation.unlinkTitle,
                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                titleVisibility: .visible,
                presenting: confirming
            ) { confirmation in
                Button(CloudRelayPresentation.unlinkConfirm, role: .destructive) { perform(confirmation.operation) }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text(CloudRelayPresentation.unlinkMessage)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let status = model.status {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    OmnesisAccountHero(
                        status: status,
                        busy: model.busy,
                        onConnect: connect,
                        onOpenSignIn: { model.openSignIn() },
                        perform: perform
                    )
                    messages(status)
                    sections(status)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.lg)
            }
        } else if let error = model.loadError {
            GatewayErrorView(context: "load your Omnesis account", error: error) {
                Task { await model.load(client: client) }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading your Omnesis account")
        }
    }

    @ViewBuilder
    private func messages(_ status: CloudRelayStatus) -> some View {
        if let failure = model.failure {
            OmnesisAccountNotice(text: failure, symbol: "exclamationmark.triangle.fill", tint: Theme.danger)
                .accessibilityIdentifier("omnesisAccount.failure")
        }
        if CloudRelayPresentation.troubled(status) {
            OmnesisAccountProblems(
                messages: CloudRelayPresentation.problems(status),
                details: { CloudRelayPresentation.diagnostics(status) }
            )
        }
    }

    @ViewBuilder
    private func sections(_ status: CloudRelayStatus) -> some View {
        if status.phase.established {
            let busy = model.busy != nil
            OmnesisAccountLinkSection(
                status: status,
                busy: busy,
                unlinking: model.busy == .accountUnlink || model.busy == .googleUnlink,
                onManage: { model.openAccountPage() },
                confirm: { confirming = $0 }
            )
            OmnesisAccountRemoteAccessSection(status: status, busy: model.busy, perform: perform)
            if status.account?.linked == true, let enrollment = status.deviceEnrollment {
                OmnesisAccountNewDevicesSection(enrollment: enrollment, busy: busy, perform: perform)
            }
        }
    }

    private func poll() async {
        guard scenePhase == .active, client != nil else { return }
        while !Task.isCancelled {
            await model.load(client: client)
            do {
                try await Task.sleep(for: model.pollInterval)
            } catch {
                return
            }
        }
    }

    private func connect(_ intent: CloudRelayConnectIntent) {
        guard let client else { return }
        Task { await model.connect(intent, client: client) }
    }

    private func perform(_ operation: CloudRelayOperation) {
        guard let client else { return }
        Task { await model.perform(operation, client: client) }
    }
}

/// Leaving the account is asked twice: it is the one change here that is not undone with a tap.
enum OmnesisAccountConfirmation: Equatable {
    case unlinkAccount, unlinkGoogle

    var operation: CloudRelayOperation {
        self == .unlinkAccount ? .accountUnlink : .googleUnlink
    }
}

/// The state headline with its one action.
@available(iOS 17.0, *)
struct OmnesisAccountHero: View {
    let status: CloudRelayStatus
    let busy: CloudRelayOperation?
    let onConnect: (CloudRelayConnectIntent) -> Void
    let onOpenSignIn: () -> Void
    let perform: (CloudRelayOperation) -> Void

    private var phase: CloudRelayPhase {
        status.phase
    }

    var body: some View {
        let copy = CloudRelayPresentation.hero(status)
        OmnesisCard(padding: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(alignment: phase.inProgress ? .center : .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    indicator
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(copy.title)
                            .font(.title3.bold())
                            .foregroundStyle(Theme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        if let hostname = copy.hostname {
                            Text(hostname)
                                .font(Theme.monospace(size: 14, weight: .medium))
                                .foregroundStyle(Theme.textPrimary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Text(copy.lede)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                actions
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("omnesisAccount.hero.\(phase.rawValue)")
    }

    @ViewBuilder
    private var indicator: some View {
        switch phase {
        case .notConnected:
            EmptyView()
        case .waiting, .registering, .linking:
            ProgressView().controlSize(.small)
        case .failed:
            dot(Theme.danger)
        case .connected:
            dot(Theme.success)
        case .reconnecting, .disconnected:
            dot(Theme.warning)
        case .off, .unavailable:
            dot(Theme.textMuted)
        }
    }

    private func dot(_ color: Color) -> some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var actions: some View {
        switch phase {
        case .notConnected:
            primary("Create an Omnesis account", working: "Connecting…", action: .connect(.create)) { onConnect(.create) }
                .accessibilityIdentifier("omnesisAccount.create")
            Button { onConnect(.existing) } label: {
                Text(isBusy(.connect(.existing)) ? "Connecting…" : "I already have one").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy != nil)
            .accessibilityIdentifier("omnesisAccount.existing")
        case .waiting:
            OmnesisAccountWaiting(connect: status.connect, busy: busy, onOpenSignIn: onOpenSignIn, perform: perform)
        case .failed:
            // The gateway does not say which of the two ways the failed attempt began with.
            primary("Try again", working: "Connecting…", action: .connect(.existing)) { onConnect(.existing) }
        case .disconnected:
            primary("Reconnect", working: "Reconnecting…", action: .reconnect, enabled: status.can?.reconnect == true) {
                perform(.reconnect)
            }
        case .off:
            primary("Turn on", working: "Turning on…", action: .enable, enabled: status.can?.enable == true) {
                perform(.enable)
            }
            .accessibilityIdentifier("omnesisAccount.turnOn")
            OmnesisAccountFootnote(text: CloudRelayPresentation.turnOnFootnote)
        case .connected, .reconnecting, .registering, .linking, .unavailable:
            EmptyView()
        }
    }

    private func isBusy(_ operation: CloudRelayOperation) -> Bool {
        busy == operation
    }

    private func primary(
        _ title: String,
        working: String,
        action: CloudRelayOperation,
        enabled: Bool = true,
        run: @escaping () -> Void
    )
        -> some View {
        Button(action: run) {
            Text(isBusy(action) ? working : title).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(Theme.accent)
        .disabled(busy != nil || !enabled)
    }
}

/// The sign-in under way: reopen it, cancel it, or finish it on another device with a code.
@available(iOS 17.0, *)
struct OmnesisAccountWaiting: View {
    let connect: CloudRelayStatus.Connect?
    let busy: CloudRelayOperation?
    let onOpenSignIn: () -> Void
    let perform: (CloudRelayOperation) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if CloudRelayPresentation.httpsURL(connect?.authorizeUrl) != nil {
                Button(action: onOpenSignIn) {
                    Text("Open sign-in").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(Theme.accent)
                .disabled(busy != nil)
                .accessibilityIdentifier("omnesisAccount.openSignIn")
            }
            Button { perform(.cancelConnect) } label: {
                Text(busy == .cancelConnect ? "Cancelling…" : "Cancel").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy != nil)
            .accessibilityIdentifier("omnesisAccount.cancel")
            elsewhere
        }
    }

    /// The relay's short address is only shown; the code is what the other device needs.
    @ViewBuilder
    private var elsewhere: some View {
        let address = CloudRelayPresentation.httpsURL(connect?.connectShortUrl) ?? CloudRelayPresentation.httpsURL(connect?.connectUrl)
        if CloudRelayPresentation.httpsURL(connect?.connectUrl) != nil, let address,
           let code = CloudRelayPresentation.connectCode(connect?.code) {
            let shown = Text(CloudRelayPresentation.displayAddress(address)).bold()
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Divider()
                Text("Or on another device, visit \(shown) and enter")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Theme.Spacing.md) {
                    Text(code)
                        .font(Theme.monospace(size: 24, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("omnesisAccount.code")
                    OmnesisAccountCopyButton(text: code, label: "Copy code")
                }
                if let expires = CloudRelayPresentation.clock(connect?.expiresAt) {
                    Text("The code works until \(expires).")
                        .font(.footnote)
                        .foregroundStyle(Theme.textMuted)
                }
            }
        }
    }
}

/// A problem or limit, set apart from the sections it concerns.
@available(iOS 17.0, *)
struct OmnesisAccountNotice: View {
    let text: String
    let symbol: String
    let tint: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
    }
}

/// Copies a short value and says so for a moment.
@available(iOS 17.0, *)
struct OmnesisAccountCopyButton: View {
    let text: String
    let label: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.body)
                .foregroundStyle(copied ? Theme.success : Theme.accent)
                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : label)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
private func omnesisAccountPreview(_ status: CloudRelayStatus?, failure: String? = nil, loadError: Error? = nil) -> some View {
    NavigationStack {
        OmnesisAccountView(model: OmnesisAccountModel(enabled: true, status: status, failure: failure, loadError: loadError), client: nil)
    }
}

@available(iOS 17.0, *)
#Preview("Omnesis account — not connected") {
    omnesisAccountPreview(PreviewMocks.cloudRelayNotConnected)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — waiting with a code") {
    omnesisAccountPreview(PreviewMocks.cloudRelayWaiting)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — registering") {
    omnesisAccountPreview(PreviewMocks.cloudRelayRegistering)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — failed") {
    omnesisAccountPreview(PreviewMocks.cloudRelayFailed)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — connected") {
    omnesisAccountPreview(PreviewMocks.cloudRelayConnected)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — connected, checking the address") {
    omnesisAccountPreview(PreviewMocks.cloudRelayChecking)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — problems") {
    omnesisAccountPreview(PreviewMocks.cloudRelayProblems)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — unexpected certificate, large text") {
    omnesisAccountPreview(PreviewMocks.cloudRelayIncident).dynamicTypeSize(.accessibility2)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — connected, not linked, light") {
    omnesisAccountPreview(PreviewMocks.cloudRelayConnectedNotLinked).preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — disconnected") {
    omnesisAccountPreview(PreviewMocks.cloudRelayDisconnected)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — off") {
    omnesisAccountPreview(PreviewMocks.cloudRelayOff)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — unavailable") {
    omnesisAccountPreview(PreviewMocks.cloudRelayUnavailable)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — a change failed, large text") {
    omnesisAccountPreview(PreviewMocks.cloudRelayConnected, failure: CloudRelayPresentation.error("operation-in-progress"))
        .dynamicTypeSize(.accessibility2)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — loading") {
    omnesisAccountPreview(nil)
}

@available(iOS 17.0, *)
#Preview("Omnesis account — couldn't load") {
    omnesisAccountPreview(nil, loadError: URLError(.notConnectedToInternet))
}
#endif
#endif

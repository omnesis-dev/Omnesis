// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

#if canImport(UIKit)
@available(iOS 17.0, *)
@MainActor
struct GatewayPairingApprovalView: View {
    let client: (any GatewayPairingApproving)?
    /// The request a notification named: listed first, so the tap lands on it.
    let focus: String?
    @State private var model: GatewayPairingApprovalModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    init(client: (any GatewayPairingApproving)?, model: GatewayPairingApprovalModel? = nil, focus: String? = nil) {
        self.client = client
        self.focus = focus
        _model = State(initialValue: model ?? GatewayPairingApprovalModel())
    }

    var body: some View {
        NavigationStack {
            List {
                if let error = GatewayErrorView.signInError(model.error) {
                    if model.requests.isEmpty {
                        GatewayErrorView(context: "manage pairing requests", error: error, onRetry: { Task { await refresh() } })
                            .frame(minHeight: GatewayErrorView.minScrollHeight)
                            .listRowBackground(Color.clear)
                    } else {
                        let kind = GatewayErrorView.classify(error)
                        Label(kind.title, systemImage: kind.symbol).foregroundStyle(kind.tint)
                            .listRowBackground(Theme.bgSecondary)
                    }
                }
                if model.denied != nil {
                    Section { deniedFollowUp }.listRowBackground(Theme.bgSecondary)
                }
                if model.requests.isEmpty, !model.busy, model.error == nil {
                    Text(PairingApprovalPresentation.empty)
                        .foregroundStyle(Theme.textSecondary)
                        .listRowBackground(Color.clear)
                }
                ForEach(Self.ordered(model.requests, focus: focus)) { request in
                    Section { requestRows(request) }
                        .listRowBackground(Theme.bgSecondary)
                        .listRowSeparator(.hidden)
                }
            }
            // The list draws on the app's own background, like every other screen, instead
            // of the system's grouped grey.
            .scrollContentBackground(.hidden)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle(PairingApprovalPresentation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
                        .disabled(model.busy)
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .overlay { if model.busy { ProgressView() } }
            .task { await refresh() }
            .refreshable { await refresh() }
            .onDisappear { model.stop() }
        }
        .presentationBackground(Theme.bgPrimary)
    }

    /// One waiting device as a question: who wants to connect, whether it shows this code, then
    /// yes or no. A device removed before says so above its code.
    @ViewBuilder
    private func requestRows(_ request: GatewayPairingApprovalRequest) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(PairingApprovalPresentation.headline(request.name)).font(.headline).foregroundStyle(Theme.textPrimary)
            Text(Self.kindLine(request)).font(.subheadline).foregroundStyle(Theme.textSecondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        if request.revokedDevice == true {
            Label(PairingApprovalPresentation.revoked, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairingApproval.revoked")
        }
        Text(PairingApprovalPresentation.question(kind: request.kind))
            .foregroundStyle(Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("pairingApproval.explanation")
        PairingCodeText(code: request.verificationCode)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, Theme.Spacing.sm)
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let expired = request.expiresAt <= context.date.timeIntervalSince1970 * 1000
            if request.status == "pending", !expired {
                decisionControls(request)
            } else {
                Text(expired ? "Expired" : request.status.capitalized).foregroundStyle(Theme.textSecondary)
            }
        }
        if let stepUp = model.stepUp, stepUp.requestId == request.id {
            stepUpNotice(stepUp, page: client?.approvalPage(requestId: request.id))
        }
    }

    private func decisionControls(_ request: GatewayPairingApprovalRequest) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if request.otherGoogleAccount == true {
                Text(PairingApprovalPresentation.otherGoogleAccount)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if request.canTrustSignIn == true {
                Toggle(
                    isOn: Binding(
                        get: { model.trustsSignIn(request) },
                        set: { model.setTrustSignIn($0, requestId: request.id) }
                    )
                ) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(PairingApprovalPresentation.remember(signIn: request.signIn)).foregroundStyle(Theme.textPrimary)
                        // The address Google verified for the gateway, large: the owner checks it is theirs.
                        if let email = request.signInEmail { Text(email).font(.headline).foregroundStyle(Theme.textPrimary) }
                        Text(PairingApprovalPresentation.rememberDetail).font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .tint(Theme.accent)
                .disabled(model.busy)
                .accessibilityIdentifier("pairingApproval.trustSignIn")
            }
            Button { decide(request, approve: true) } label: {
                Text(model.stepUpRequired ? PairingApprovalPresentation.approveWithFaceID : PairingApprovalPresentation.approve)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .accessibilityIdentifier("pairingApproval.approve")
            Button(role: .destructive) { decide(request, approve: false) } label: {
                Text(PairingApprovalPresentation.deny).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("pairingApproval.deny")
        }
        .controlSize(.large)
        .disabled(model.busy)
    }

    /// The gateway wants the owner's passkey for this approval. Its own page can take it; during a
    /// security lock nothing on this phone can.
    private func stepUpNotice(_ stepUp: PairingStepUp, page: URL?) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Label(stepUp.refusal.title, systemImage: stepUp.refusal == .required ? "faceid" : "lock.shield")
                .font(.headline)
                .foregroundStyle(Theme.warning)
            Text(stepUp.refusal.message)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if let action = stepUp.refusal.action, let page {
                Button(action) { openURL(page) }
                    .buttonStyle(.bordered)
                    .tint(Theme.accent)
                    .accessibilityIdentifier("pairingApproval.stepUp.open")
            }
        }
        .accessibilityIdentifier("pairingApproval.stepUp")
    }

    /// Right after a denial: the owner may not have started that sign-in at all.
    @ViewBuilder
    private var deniedFollowUp: some View {
        if let denied = model.denied {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(denied.signIn == "google" ? PairingApprovalPresentation.denied : "Denied.")
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if model.askingFirst {
                    Label(PairingApprovalPresentation.askingFirst, systemImage: "checkmark.circle")
                        .foregroundStyle(Theme.success)
                } else if let policy = client as? any CloudRelayManaging {
                    Button(PairingApprovalPresentation.askFirst) { Task { await model.askFirst(client: policy) } }
                        .buttonStyle(.bordered)
                        .tint(Theme.accent)
                        .disabled(model.busy)
                        .accessibilityIdentifier("pairingApproval.askFirst")
                }
            }
            .accessibilityIdentifier("pairingApproval.denied")
        }
    }

    /// The named request first, the others in the gateway's order.
    static func ordered(_ requests: [GatewayPairingApprovalRequest], focus: String?) -> [GatewayPairingApprovalRequest] {
        requests.filter { $0.id == focus } + requests.filter { $0.id != focus }
    }

    /// The kind of device, and the sign-in it used when the gateway verified one.
    static func kindLine(_ request: GatewayPairingApprovalRequest) -> String {
        [
            DeviceKindMeta.label(request.kind),
            DeviceJoinPresentation.signInMethod(request.signIn).map { "signed in with \($0)" },
            request.signInEmail,
        ].compactMap(\.self).joined(separator: " · ")
    }

    private func refresh() async {
        guard let client else { return }
        await model.refresh(client: client)
    }

    private func decide(_ request: GatewayPairingApprovalRequest, approve: Bool) {
        guard let client else { return }
        Task {
            if approve {
                await model.confirmAndApprove(request, client: client)
            } else {
                await model.decide(request, approve: false, client: client)
            }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Pairing requests — trust this sign-in") {
    GatewayPairingApprovalView(client: PreviewMocks.pairingRequestsWithTrust)
}

@available(iOS 17.0, *)
#Preview("Pairing requests — none, dark") {
    GatewayPairingApprovalView(client: PreviewMocks.PreviewPairingRequests(rows: [])).preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Waiting for your OK — removed before") {
    GatewayPairingApprovalView(client: PreviewMocks.pairingRequestRevoked)
}

@available(iOS 17.0, *)
#Preview("Waiting for your OK — confirm it's you") {
    let model = GatewayPairingApprovalModel()
    return GatewayPairingApprovalView(client: PreviewMocks.pairingRequestsNeedingStepUp, model: model)
        .task {
            if let request = model.requests.first {
                await model.confirmAndApprove(request, client: PreviewMocks.pairingRequestsNeedingStepUp)
            }
        }
}

@available(iOS 17.0, *)
#Preview("Pairing requests — two waiting, large text") {
    GatewayPairingApprovalView(client: PreviewMocks.pairingRequestsSeveral).dynamicTypeSize(.accessibility2)
}
#endif
#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

#if canImport(UIKit)
@available(iOS 17.0, *)
@MainActor
struct GatewayPairingApprovalView: View {
    let client: (any GatewayPairingApproving)?
    @State private var model: GatewayPairingApprovalModel
    @Environment(\.dismiss) private var dismiss

    init(client: (any GatewayPairingApproving)?, model: GatewayPairingApprovalModel? = nil) {
        self.client = client
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
                if model.requests.isEmpty, !model.busy, model.error == nil {
                    Text(PairingApprovalPresentation.empty)
                        .foregroundStyle(Theme.textSecondary)
                        .listRowBackground(Color.clear)
                }
                ForEach(model.requests) { request in
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

    /// One waiting device: who it is, the one explanation, the code, then the decision.
    @ViewBuilder
    private func requestRows(_ request: GatewayPairingApprovalRequest) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(request.name).font(.headline).foregroundStyle(Theme.textPrimary)
            Text(Self.kindLine(request)).font(.subheadline).foregroundStyle(Theme.textSecondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        Text(PairingApprovalPresentation.explanation)
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
    }

    private func decisionControls(_ request: GatewayPairingApprovalRequest) -> some View {
        VStack(spacing: Theme.Spacing.md) {
            if request.canTrustSignIn == true {
                Toggle(
                    "Trust this sign-in from now on",
                    isOn: Binding(
                        get: { model.trustsSignIn(request) },
                        set: { model.setTrustSignIn($0, requestId: request.id) }
                    )
                )
                .tint(Theme.accent)
                .disabled(model.busy)
                .accessibilityIdentifier("pairingApproval.trustSignIn")
            }
            Button { decide(request, approve: true) } label: {
                Text(PairingApprovalPresentation.approve).frame(maxWidth: .infinity)
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

    /// The kind of device, and the sign-in it used when the gateway verified one.
    static func kindLine(_ request: GatewayPairingApprovalRequest) -> String {
        [DeviceKindMeta.label(request.kind), DeviceJoinPresentation.signInMethod(request.signIn)]
            .compactMap(\.self).joined(separator: " · ")
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
#Preview("Pairing requests — two waiting, large text") {
    GatewayPairingApprovalView(client: PreviewMocks.pairingRequestsSeveral).dynamicTypeSize(.accessibility2)
}
#endif
#endif

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
                Section {
                    Text(
                        "Compare every code group with the new device through an already trusted connection to your gateway. "
                            + "You can also use the gateway’s local portal or terminal. Approve only a device you are pairing now."
                    )
                }
                if let error = model.error {
                    if model.requests.isEmpty {
                        GatewayErrorView(context: "manage pairing requests", error: error, onRetry: { Task { await refresh() } })
                            .frame(minHeight: GatewayErrorView.minScrollHeight)
                    } else {
                        let kind = GatewayErrorView.classify(error)
                        Label(kind.title, systemImage: kind.symbol).foregroundStyle(kind.tint)
                    }
                }
                if model.requests.isEmpty, !model.busy, model.error == nil {
                    Text("No pending pairing requests.").foregroundStyle(.secondary)
                }
                ForEach(model.requests) { request in
                    Section {
                        Text(request.name).font(.headline)
                        Text(request.kind.capitalized).foregroundStyle(.secondary)
                        Text(request.verificationCode)
                            .font(.system(.body, design: .monospaced).weight(.semibold))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("Verification code \(request.verificationCode)")
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if request.status == "pending", request.expiresAt > context.date.timeIntervalSince1970 * 1000 {
                                Toggle("I compared every group with the new device and they match", isOn: Binding(
                                    get: { model.isCompared(request) },
                                    set: { model.setCompared($0, requestId: request.id) }
                                ))
                                .disabled(model.busy)
                                .accessibilityIdentifier("pairingApproval.compare")
                                Button("Approve device") { decide(request, approve: true) }
                                    .buttonStyle(.borderless)
                                    .disabled(!model.canApprove(request))
                                    .accessibilityIdentifier("pairingApproval.approve")
                                Button("Reject request", role: .destructive) { decide(request, approve: false) }
                                    .buttonStyle(.borderless)
                                    .disabled(model.busy)
                            } else {
                                Text(request.expiresAt <= context.date.timeIntervalSince1970 * 1000 ? "Expired" : request.status
                                    .capitalized)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Pairing requests")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
                        .disabled(model.busy)
                }
            }
            .overlay { if model.busy { ProgressView() } }
            .task { await refresh() }
            .refreshable { await refresh() }
            .onDisappear { model.stop() }
        }
    }

    private func refresh() async {
        guard let client else { return }
        await model.refresh(client: client)
    }

    private func decide(_ request: GatewayPairingApprovalRequest, approve: Bool) {
        guard let client else { return }
        Task { await model.decide(request, approve: approve, client: client) }
    }
}
#endif

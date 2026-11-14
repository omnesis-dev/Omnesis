// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

#if canImport(UIKit)
/// Waiting to join: the devices that reached this gateway through the owner's
/// Tailscale network, each with Approve and Deny. A `tailscale-join`
/// notification opens it over Devices.
@available(iOS 17.0, *)
@MainActor
struct TailscaleJoinRequestsView: View {
    let client: (any TailscaleJoinDeciding)?
    @State private var model: TailscaleJoinRequestsModel
    @Environment(\.dismiss) private var dismiss
    /// The icon column grows with the text size so the icon never runs into the name.
    @ScaledMetric(relativeTo: .title3) private var iconColumn: CGFloat = 28

    /// `model` lets a preview or snapshot show a list it already loaded.
    init(client: (any TailscaleJoinDeciding)?, model: TailscaleJoinRequestsModel? = nil) {
        self.client = client
        _model = State(initialValue: model ?? TailscaleJoinRequestsModel())
    }

    var body: some View {
        NavigationStack {
            List {
                if let notice = model.notice {
                    Label(notice, systemImage: "clock.badge.xmark")
                        .foregroundStyle(Theme.textSecondary)
                        .listRowBackground(Theme.bgSecondary)
                        .accessibilityIdentifier("tailscaleJoin.notice")
                }
                if let error = model.error {
                    if model.requests.isEmpty {
                        GatewayErrorView(context: "load devices waiting to join", error: error, onRetry: { Task { await refresh() } })
                            .frame(minHeight: GatewayErrorView.minScrollHeight)
                            .listRowBackground(Color.clear)
                    } else {
                        let kind = GatewayErrorView.classify(error)
                        Label(kind.title, systemImage: kind.symbol).foregroundStyle(kind.tint)
                            .listRowBackground(Theme.bgSecondary)
                    }
                }
                if model.requests.isEmpty, model.loaded, model.error == nil {
                    emptyState
                } else if !model.requests.isEmpty {
                    Section {
                        ForEach(model.requests) { request in
                            requestRow(request)
                                .listRowBackground(Theme.bgSecondary)
                        }
                    } header: {
                        Text(TailscaleJoinPresentation.explanation)
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .textCase(nil)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle(TailscaleJoinPresentation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("tailscaleJoin.done")
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .overlay { if model.busy, !model.loaded { ProgressView() } }
            .task { await refresh() }
            .refreshable { await refresh() }
            .onDisappear { model.stop() }
        }
        .presentationBackground(Theme.bgPrimary)
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
            Text(TailscaleJoinPresentation.empty)
                .foregroundStyle(Theme.textSecondary)
                .accessibilityIdentifier("tailscaleJoin.empty")
            Button { dismiss() } label: {
                Text("Done").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .controlSize(.large)
            .padding(.top, Theme.Spacing.sm)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.xl)
        .listRowBackground(Color.clear)
    }

    /// One waiting device: what it is and where it came from, then the decision.
    private func requestRow(_ request: TailscaleJoinRequest) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                Image(systemName: DeviceKindMeta.icon(request.kind))
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .frame(width: iconColumn)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(request.name)
                        .font(.headline)
                        .foregroundStyle(Theme.textPrimary)
                    Text(detailLines(request))
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(TailscaleJoinPresentation.requestedLine(request, now: context.date))
                            .font(.caption)
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            decisionControls(request)
        }
        .padding(.vertical, Theme.Spacing.xs)
        .accessibilityIdentifier("tailscaleJoin.request")
    }

    private func detailLines(_ request: TailscaleJoinRequest) -> String {
        let machine = TailscaleJoinPresentation.machineLine(request)
        let kindAndMachine = [DeviceKindMeta.label(request.kind), machine].compactMap(\.self).joined(separator: " ")
        return [kindAndMachine, TailscaleJoinPresentation.accountLine(request)].compactMap(\.self).joined(separator: "\n")
    }

    /// Deny and Approve side by side, or Approve above Deny when a large text size leaves
    /// no room for both labels on one line.
    private func decisionControls(_ request: TailscaleJoinRequest) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Spacing.md) {
                denyButton(request)
                approveButton(request)
            }
            VStack(spacing: Theme.Spacing.sm) {
                approveButton(request)
                denyButton(request)
            }
        }
        .controlSize(.large)
        .disabled(model.busy)
    }

    private func denyButton(_ request: TailscaleJoinRequest) -> some View {
        Button(role: .destructive) { decide(request, approve: false) } label: {
            Text(TailscaleJoinPresentation.deny).lineLimit(1).fixedSize().frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("tailscaleJoin.deny")
    }

    private func approveButton(_ request: TailscaleJoinRequest) -> some View {
        Button { decide(request, approve: true) } label: {
            Group {
                if model.deciding == request.id {
                    ProgressView().tint(.white)
                } else {
                    Text(TailscaleJoinPresentation.approve).lineLimit(1).fixedSize()
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.accent)
        .accessibilityIdentifier("tailscaleJoin.approve")
    }

    private func refresh() async {
        guard let client else { return }
        await model.refresh(client: client)
    }

    private func decide(_ request: TailscaleJoinRequest, approve: Bool) {
        guard let client else { return }
        Task { await model.decide(request, approve: approve, client: client) }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Waiting to join — two devices") {
    TailscaleJoinRequestsView(client: PreviewMocks.tailscaleJoinRequestsTwo)
}

@available(iOS 17.0, *)
#Preview("Waiting to join — two devices, dark") {
    TailscaleJoinRequestsView(client: PreviewMocks.tailscaleJoinRequestsTwo).preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Waiting to join — none") {
    TailscaleJoinRequestsView(client: PreviewMocks.PreviewTailscaleJoinRequests(rows: []))
}

@available(iOS 17.0, *)
#Preview("Waiting to join — request gone") {
    TailscaleJoinRequestsView(client: PreviewMocks.PreviewTailscaleJoinRequests(rows: PreviewMocks.tailscaleJoinRows, decisionGone: true))
}

@available(iOS 17.0, *)
#Preview("Waiting to join — large text") {
    TailscaleJoinRequestsView(client: PreviewMocks.tailscaleJoinRequestsTwo).dynamicTypeSize(.accessibility2)
}

@available(iOS 17.0, *)
#Preview("Waiting to join — unavailable") {
    TailscaleJoinRequestsView(client: PreviewMocks.PreviewTailscaleJoinRequests(rows: [], unavailable: true))
}
#endif
#endif

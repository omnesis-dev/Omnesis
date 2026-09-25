// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct PrivacySubscriptionApprovalRow: View {
    let approval: PrivacySubscriptionApprovalSummary

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 14))
                .foregroundStyle(Theme.warning)
                .frame(width: 26, height: 26)
                .background(Theme.warning.opacity(0.13))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
            VStack(alignment: .leading, spacing: 4) {
                Text("\(externalAgentNarrativeName(approval.integration)) wants a standing watch")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(approval.interpretedCondition.summary)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                Text(subscriptionRelativeDate(approval.createdAt))
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .padding(.top, 5)
        }
        .padding(.vertical, Theme.Spacing.sm)
        .contentShape(Rectangle())
    }
}

@available(iOS 17.0, *)
struct PrivacySubscriptionApprovalDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let approvalId: String
    let onResolved: () -> Void
    @State private var detail: PrivacySubscriptionApprovalDetail?
    @State private var loading = true
    @State private var loadError: Error?
    @State private var actionError: Error?
    @State private var busy: String?
    @State private var generation = 0
    private let isPreview: Bool

    init(approvalId: String, onResolved: @escaping () -> Void) {
        self.approvalId = approvalId
        self.onResolved = onResolved
        self.isPreview = false
    }

    #if DEBUG
    init(
        previewDetail: PrivacySubscriptionApprovalDetail? = nil,
        previewLoading: Bool = false,
        previewLoadError: Error? = nil,
        previewActionError: Error? = nil
    ) {
        self.approvalId = previewDetail?.id ?? "preview-subscription-approval"
        self.onResolved = {}
        self._detail = State(initialValue: previewDetail)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self._actionError = State(initialValue: previewActionError)
        self.isPreview = true
    }
    #endif

    var body: some View {
        Group {
            if loading {
                ProgressView("Loading watch request…")
            } else if let loadError, detail == nil {
                GatewayErrorView(
                    context: "load the watch request",
                    error: loadError,
                    onRetry: { Task { await load() } }
                )
            } else if let detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        privacyBanner
                        trustedTextSection(
                            title: "What to watch for",
                            text: detail.condition.description
                        )
                        trustedTextSection(
                            title: "What the agent says it will do",
                            text: detail.reaction.instruction,
                            footnote: "Exact subscriber-authored text. Omnesis never adds private data to this instruction."
                        )
                        metadata(detail)
                        if let actionError {
                            Label(
                                "Request failed: \(GatewayErrorView.classify(actionError).title)",
                                systemImage: "exclamationmark.triangle"
                            )
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.warning)
                        } else if let loadError {
                            Label(
                                "Refresh failed: \(GatewayErrorView.classify(loadError).title)",
                                systemImage: "exclamationmark.triangle"
                            )
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.warning)
                        }
                        if detail.status == "pending" {
                            actionButtons
                        }
                    }
                    .padding(Theme.Spacing.lg)
                }
            }
        }
        .navigationTitle(
            (detail?.revision ?? 1) > 1
                ? "Watch revision \(detail?.revision ?? 1)"
                : "Watch request"
        )
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.bgPrimary.ignoresSafeArea())
        .task {
            guard !isPreview else { return }
            await load()
        }
    }

    private var privacyBanner: some View {
        Label(
            "Your privacy policy requires approval before this integration can learn that the condition occurred. Documents, titles, people, content, and private evidence stay inside Omnesis.",
            systemImage: "shield.lefthalf.filled"
        )
        .font(.system(size: 12))
        .foregroundStyle(Theme.warning)
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.warning.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    private func trustedTextSection(
        title: String,
        text: String,
        footnote: String? = nil
    )
        -> some View {
        FlatSection(title) {
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.md)
                .background(Theme.bgSecondary)
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.medium)
                        .stroke(Theme.border, lineWidth: 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            if let footnote {
                Text(footnote)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private func metadata(_ detail: PrivacySubscriptionApprovalDetail) -> some View {
        FlatSection("Approval envelope") {
            metadataRow("Owner", detail.integration.displayName)
            metadataRow("Owner device", detail.integrationDevice.name)
            metadataRow("Workflow", detail.workflow.name)
            metadataRow("Workflow purpose", detail.workflow.purpose)
            metadataRow("Workflow handle", shortSubscriptionId(detail.workflowHandle))
            metadataRow("Disclosure", detail.interpretedCondition.pushDetail)
            metadataRow("Expires", detail.expiresAt > 0 ? subscriptionDate(detail.expiresAt) : "Never")
            metadataRow("Revision", detail.revision.formatted())
            metadataRow("Policy", shortSubscriptionId(detail.policyRevision))
            if !detail.categories.isEmpty {
                metadataRow("Categories", detail.categories.joined(separator: ", "))
            }
        }
    }

    private func metadataRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(Theme.textSecondary)
            Spacer()
            Text(value)
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.trailing)
        }
        .font(.system(size: 12))
    }

    private var actionButtons: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Button {
                Task { await resolve(approve: true) }
            } label: {
                Group {
                    if busy == "approve" {
                        ProgressView()
                    } else {
                        Text("Approve watch")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy != nil)

            Button("Don’t allow", role: .destructive) {
                Task { await resolve(approve: false) }
            }
            .buttonStyle(.bordered)
            .frame(maxWidth: .infinity)
            .disabled(busy != nil)
        }
    }

    private func load() async {
        generation += 1
        let request = generation
        loading = true
        loadError = nil
        defer { if generation == request { loading = false } }
        guard let client = store.privacy else {
            loadError = URLError(.cannotConnectToHost)
            return
        }
        do {
            let loaded = try await client.getSubscriptionApproval(id: approvalId)
            guard generation == request else { return }
            detail = loaded
            loadError = nil
        } catch {
            if generation == request { loadError = error }
        }
    }

    private func resolve(approve: Bool) async {
        guard busy == nil else { return }
        guard let client = store.privacy else {
            actionError = URLError(.cannotConnectToHost)
            return
        }
        generation += 1
        busy = approve ? "approve" : "deny"
        actionError = nil
        defer { busy = nil }
        do {
            let outcome = try await resolveSubscriptionApprovalAndReconcile(
                resolve: {
                    if approve {
                        try await client.approveSubscription(id: approvalId)
                    } else {
                        try await client.denySubscription(id: approvalId)
                    }
                },
                reload: {
                    try await client.getSubscriptionApproval(id: approvalId)
                }
            )
            switch outcome {
            case .accepted:
                onResolved()
                dismiss()
            case .reconciled(let latest):
                detail = latest
                onResolved()
                dismiss()
            case .failed(let error, let latest):
                if let latest { detail = latest }
                actionError = error
            }
        } catch is CancellationError {
            return
        } catch {
            actionError = error
        }
    }
}

private func subscriptionRelativeDate(_ millis: Int64) -> String {
    Date(timeIntervalSince1970: TimeInterval(millis) / 1000).formatted(.relative(presentation: .named))
}

#if DEBUG
#Preview("Subscription approval - pending") {
    NavigationStack {
        PrivacySubscriptionApprovalDetailView(previewDetail: PreviewMocks.subscriptionApprovalDetail)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Subscription approval - revision") {
    NavigationStack {
        PrivacySubscriptionApprovalDetailView(
            previewDetail: PreviewMocks.subscriptionApprovalRevisionDetail
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Subscription approval - loading") {
    NavigationStack {
        PrivacySubscriptionApprovalDetailView(previewLoading: true)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Subscription approval - error") {
    NavigationStack {
        PrivacySubscriptionApprovalDetailView(
            previewLoadError: URLError(.cannotConnectToHost)
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Subscription approval - action failure") {
    NavigationStack {
        PrivacySubscriptionApprovalDetailView(
            previewDetail: PreviewMocks.subscriptionApprovalDetail,
            previewActionError: URLError(.cannotConnectToHost)
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#endif
#endif

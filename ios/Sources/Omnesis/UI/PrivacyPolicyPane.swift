// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The read-only text of one policy family — the document a grant, a review
/// or the Settings list points at. Policy authorship and its version ledger
/// live in the portal; this view is the portable reference copy.
@available(iOS 17.0, *)
struct PrivacyPolicyPane: View {
    @Environment(AppStore.self) private var store

    @State private var policy: PrivacyPolicyDocument?
    @State private var loading = true
    @State private var loadError: Error?
    @State private var loadGeneration = 0

    private let isPreview: Bool
    private let familyId: String

    init(familyId: String) {
        self.isPreview = false
        self.familyId = familyId
    }

    #if DEBUG
    init(
        previewPolicy: PrivacyPolicyDocument?,
        previewLoading: Bool = false,
        previewLoadError: Error? = nil
    ) {
        self._policy = State(initialValue: previewPolicy)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self.isPreview = true
        self.familyId = "preview-family"
    }
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                // A statement of where editing lives, not a problem to solve — so it reads as
                // ordinary text rather than as a warning the reader has to clear.
                Text("The policy can only be edited on the web portal.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let loadError, policy != nil {
                    PrivacyRefreshFailureBanner(error: loadError)
                }
                content
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .refreshable { await load() }
        .task {
            guard !isPreview else { return }
            await load()
        }
        .onDisappear { loadGeneration += 1 }
    }

    @ViewBuilder
    private var content: some View {
        if loading, policy == nil {
            PrivacyLoadingRow(label: "Loading policy…")
        } else if let loadError, policy == nil {
            GatewayErrorView(
                context: "load the privacy policy",
                error: loadError,
                onRetry: { Task { await load() } }
            )
            .frame(minHeight: GatewayErrorView.minScrollHeight)
        } else if let policy {
            FlatSection("Privacy policy") {
                MarkdownView(text: policy.policy, bodyFont: .system(size: 14))
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(Theme.bgSecondary)
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.Radius.medium)
                            .stroke(Theme.borderLight, lineWidth: 1)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            }
        }
    }

    private func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        guard let client = store.privacy else {
            if generation == loadGeneration {
                loading = false
                loadError = URLError(.cannotConnectToHost)
            }
            return
        }
        loading = true
        defer {
            if generation == loadGeneration { loading = false }
        }
        do {
            let fresh = try await client.getPolicyFamily(id: familyId)
            guard generation == loadGeneration else { return }
            policy = fresh
            loadError = nil
        } catch {
            if generation == loadGeneration {
                loadError = privacyRefreshFailure(previous: loadError, caught: error)
            }
        }
    }
}

/// One policy's text as a pushed screen: the pane under the family's name,
/// or "Policy" when the caller has none. Every route that opens a policy —
/// the Settings list, an exchange's review, an access grant — pushes this.
@available(iOS 17.0, *)
struct PrivacyPolicyScreen: View {
    private let name: String?
    private let pane: PrivacyPolicyPane

    init(familyId: String, name: String?) {
        self.name = name
        self.pane = PrivacyPolicyPane(familyId: familyId)
    }

    #if DEBUG
    init(previewPolicy: PrivacyPolicyDocument?, name: String?) {
        self.name = name
        self.pane = PrivacyPolicyPane(previewPolicy: previewPolicy)
    }
    #endif

    var body: some View {
        pane
            .navigationTitle(privacyPolicyDisplayName(name))
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.bgPrimary.ignoresSafeArea())
    }
}

/// The row an exchange or an approval shows for the policy its review was
/// judged against. Pushes that family's text; a record that kept the family's
/// name puts it in the row, so two grants judged under different policies
/// read differently at a glance.
@available(iOS 17.0, *)
struct PrivacyReviewedUnderRow: View {
    let policy: PrivacyReviewedPolicy

    var body: some View {
        NavigationLink(value: PrivacyRoute.policy(familyId: policy.familyId, name: policy.name)) {
            HStack(spacing: Theme.Spacing.sm) {
                Label(privacyReviewedUnderLabel(policy), systemImage: "doc.text")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                Spacer(minLength: Theme.Spacing.sm)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The one-line banner a screen that still shows its last good data puts
/// above that data when a refresh fails: the failure is stated, the data is
/// not replaced by it.
@available(iOS 17.0, *)
struct PrivacyRefreshFailureBanner: View {
    let error: Error

    var body: some View {
        PrivacyBanner(text: "Refresh failed: \(GatewayErrorView.classify(error).title)")
    }
}

#if DEBUG
#Preview("Privacy policy pane — read only") {
    PrivacyPolicyPane(previewPolicy: PreviewMocks.privacyPolicy)
        .environment(AppStore.preview())
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
}

#Preview("Privacy policy pane — loading") {
    PrivacyPolicyPane(previewPolicy: nil, previewLoading: true)
        .environment(AppStore.preview())
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
}

#Preview("Privacy policy screen — one named family") {
    NavigationStack {
        PrivacyPolicyScreen(previewPolicy: PreviewMocks.privacyPolicyFamily, name: "Work safe")
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy policy screen — nameless family") {
    NavigationStack {
        PrivacyPolicyScreen(previewPolicy: PreviewMocks.privacyPolicyFamily, name: nil)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy policy pane — error") {
    PrivacyPolicyPane(previewPolicy: nil, previewLoadError: URLError(.cannotConnectToHost))
        .environment(AppStore.preview())
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
}

#Preview("Privacy policy pane — refresh failed, text kept") {
    PrivacyPolicyPane(
        previewPolicy: PreviewMocks.privacyPolicyFamily,
        previewLoadError: URLError(.cannotConnectToHost)
    )
    .environment(AppStore.preview())
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}

#Preview("Reviewed-under rows") {
    NavigationStack {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            PrivacyReviewedUnderRow(
                policy: PrivacyReviewedPolicy(familyId: "policy-work-safe", name: "Work safe")
            )
            PrivacyReviewedUnderRow(
                policy: PrivacyReviewedPolicy(familyId: "policy-work-safe", name: nil)
            )
        }
        .padding(Theme.Spacing.lg)
        .background(Theme.bgPrimary)
        .navigationDestination(for: PrivacyRoute.self) { route in
            PrivacyRouteDestination(route: route, onChanged: {})
        }
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}
#endif

#endif

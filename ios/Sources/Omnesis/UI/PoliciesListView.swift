// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Every privacy policy the gateway holds, as Settings lists them. A row is
/// one family — its name, where its text stands, and how many grants are
/// judged against it — and opens that family's read-only text. Retired
/// families are left out: they govern nothing and are kept only as history.
///
/// Which family is the default is what the access overview reports. It is
/// asked alongside the catalogue and never waited on: a refresh that cannot
/// ask keeps the marker it had, and a list that was never told marks nothing.
@available(iOS 17.0, *)
struct PoliciesListView: View {
    @Environment(AppStore.self) private var store

    @State private var families: [PrivacyPolicyFamilySummary]?
    @State private var defaultFamilyId: String?
    @State private var loading = true
    @State private var loadError: Error?
    @State private var loadGeneration = 0

    private let isPreview: Bool

    init() {
        self.isPreview = false
    }

    #if DEBUG
    init(
        previewFamilies: [PrivacyPolicyFamilySummary]?,
        previewDefaultFamilyId: String? = nil,
        previewLoading: Bool = false,
        previewLoadError: Error? = nil
    ) {
        self._families = State(initialValue: previewFamilies)
        self._defaultFamilyId = State(initialValue: previewDefaultFamilyId)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self.isPreview = true
    }
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text("A policy is the text an answer is judged against before it leaves Omnesis. "
                    + "Policies can only be edited on the web portal.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let loadError, families != nil {
                    PrivacyRefreshFailureBanner(error: loadError)
                }
                content
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .navigationTitle("Policies")
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.bgPrimary.ignoresSafeArea())
        .refreshable { await load() }
        .task {
            guard !isPreview else { return }
            await load()
        }
        .onDisappear { loadGeneration += 1 }
    }

    @ViewBuilder
    private var content: some View {
        if loading, families == nil {
            PrivacyLoadingRow(label: "Loading policies…")
        } else if let loadError, families == nil {
            GatewayErrorView(
                context: "load the privacy policies",
                error: loadError,
                onRetry: { Task { await load() } }
            )
            .frame(minHeight: GatewayErrorView.minScrollHeight)
        } else if let families {
            let listed = privacyPolicyFamiliesForListing(families, defaultFamilyId: defaultFamilyId)
            if listed.isEmpty {
                PrivacyEmptyState(
                    symbol: "doc.text",
                    title: "No privacy policy exists yet",
                    detail: "Write one on the web portal and it appears here."
                )
            } else {
                FlatSection("Policies", trailing: "\(listed.count)") {
                    VStack(spacing: 0) {
                        ForEach(listed) { family in
                            NavigationLink(
                                value: SettingsDestination.policy(familyId: family.id, name: family.name)
                            ) {
                                PolicyFamilyRow(family: family, isDefault: family.id == defaultFamilyId)
                            }
                            .buttonStyle(.plain)
                            if family.id != listed.last?.id {
                                Divider().overlay(Theme.borderLight)
                            }
                        }
                    }
                }
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
        let access = store.access
        async let advice: PrivacyDefaultPolicyAdvice = {
            guard let access else { return .unavailable }
            do {
                return try await .reported(access.overview().defaultPolicyFamilyId)
            } catch {
                return .unavailable
            }
        }()
        do {
            let fresh = try await client.listPolicyFamilies()
            let advised = await advice
            guard generation == loadGeneration else { return }
            families = fresh
            defaultFamilyId = privacyDefaultPolicyMarker(previous: defaultFamilyId, advice: advised)
            loadError = nil
        } catch {
            if generation == loadGeneration {
                loadError = privacyRefreshFailure(previous: loadError, caught: error)
            }
        }
    }
}

/// One family in the list. The revision is shortened to what tells two
/// revisions apart; the grant count says whether the text is in force.
@available(iOS 17.0, *)
struct PolicyFamilyRow: View {
    let family: PrivacyPolicyFamilySummary
    let isDefault: Bool

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: "doc.text")
                .font(.system(size: 14))
                .foregroundStyle(Theme.accent)
                .frame(width: 26, height: 26)
                .background(Theme.accent.opacity(0.13))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
            VStack(alignment: .leading, spacing: 3) {
                Text(privacyPolicyDisplayName(family.name))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(
                    "\(privacyPolicyShortRevision(family.currentRevision)) · "
                        + privacyPolicyGovernanceLine(grantCount: family.affectedGrantIds.count)
                )
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .monospacedDigit()
                if isDefault {
                    Text("Default policy")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                        .textCase(.uppercase)
                        .tracking(0.5)
                }
            }
            Spacer(minLength: Theme.Spacing.sm)
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .padding(.top, 5)
        }
        .padding(.vertical, Theme.Spacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview("Policies — several, default first") {
    NavigationStack {
        PoliciesListView(
            previewFamilies: PreviewMocks.privacyPolicyFamilies,
            previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Policies — default unknown") {
    NavigationStack {
        PoliciesListView(previewFamilies: PreviewMocks.privacyPolicyFamilies)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Policies — one family") {
    NavigationStack {
        PoliciesListView(
            previewFamilies: PreviewMocks.privacyPolicyFamilySingle,
            previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Policies — a very long name") {
    NavigationStack {
        PoliciesListView(
            previewFamilies: PreviewMocks.privacyPolicyFamiliesLongName,
            previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Policies — none yet") {
    NavigationStack {
        PoliciesListView(previewFamilies: [])
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Policies — loading") {
    NavigationStack {
        PoliciesListView(previewFamilies: nil, previewLoading: true)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Policies — error") {
    NavigationStack {
        PoliciesListView(previewFamilies: nil, previewLoadError: URLError(.cannotConnectToHost))
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Policies — refresh failed, list kept") {
    NavigationStack {
        PoliciesListView(
            previewFamilies: PreviewMocks.privacyPolicyFamilies,
            previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId,
            previewLoadError: URLError(.cannotConnectToHost)
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}
#endif

#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

@available(iOS 17.0, *)
struct AppAttentionBanner: View {
    let problems: [SourcePermissionProblem]
    let notificationWarning: (title: String, detail: String)?
    let onOpenPermissions: () -> Void
    let onOpenNotificationSettings: () -> Void
    var onDismissNotification: (() -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            if let warning = notificationWarning {
                dismissibleAttentionRow(
                    title: warning.title,
                    detail: "Permission alerts may not reach you",
                    action: onOpenNotificationSettings,
                    onDismiss: onDismissNotification
                )
            }
            if let first = problems.first {
                attentionRow(
                    title: problems.count == 1
                        ? "\(first.displayName) needs attention"
                        : "Phone sources need attention",
                    detail: problems.count == 1
                        ? first.capability.label
                        : "\(problems.count) permissions are affecting your data",
                    action: onOpenPermissions
                )
            }
        }
        .background(Theme.bgSecondary)
        .overlay(alignment: .bottom) { Divider().background(Theme.borderLight) }
    }

    private func attentionRow(title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { Divider().background(Theme.borderLight) }
    }

    private func dismissibleAttentionRow(
        title: String,
        detail: String,
        action: @escaping () -> Void,
        onDismiss: (() -> Void)?
    )
        -> some View {
        HStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.warning)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                .padding(.leading, Theme.Spacing.lg)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.textMuted)
                        .padding(Theme.Spacing.md)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss notifications warning")
            }
        }
        .padding(.trailing, Theme.Spacing.sm)
        .overlay(alignment: .bottom) { Divider().background(Theme.borderLight) }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Attention — notifications turned off") {
    AppAttentionBanner(
        problems: [],
        notificationWarning: PushDeliveryHealth.permissionDenied.warning,
        onOpenPermissions: {},
        onOpenNotificationSettings: {},
        onDismissNotification: {}
    )
}
#endif

@available(iOS 17.0, *)
struct SourcePermissionHealthView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.returnToSettingsRoot) private var returnToSettingsRoot
    let refreshOnAppear: Bool
    let focusedSourceId: String?

    init(refreshOnAppear: Bool = true, focusedSourceId: String? = nil) {
        self.refreshOnAppear = refreshOnAppear
        self.focusedSourceId = focusedSourceId
    }

    var body: some View {
        List {
            if case .deferred(let sourceIds) = store.sourcePermissionHealthDelivery {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Gateway update deferred", systemImage: "wifi.exclamationmark")
                            .font(.headline)
                            .foregroundStyle(Theme.warning)
                        Text(
                            sourceIds.count == 1
                                ? "This permission check could not reach your gateway. Your local status is still shown below."
                                : "Some permission checks could not reach your gateway. Your local status is still shown below."
                        )
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        Button("Try again") {
                            Task { await store.refreshSourcePermissionHealth() }
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    .padding(.vertical, 4)
                }
            }
            switch store.sourcePermissionHealthEvaluation {
            case .notEvaluated:
                ContentUnavailableView(
                    "Permission status not checked",
                    systemImage: "shield.lefthalf.filled",
                    description: Text("Open this screen while paired to check phone-source access.")
                )
                .listRowBackground(Color.clear)
            case .loading:
                HStack {
                    Spacer()
                    ProgressView("Checking permissions…")
                    Spacer()
                }
                .listRowBackground(Color.clear)
            case .evaluated where focusedSourceId != nil && visibleProblems.isEmpty:
                ContentUnavailableView(
                    "Permission issue cleared",
                    systemImage: "checkmark.shield.fill",
                    description: Text(
                        "This source no longer reports the permission problem that opened this screen."
                    )
                )
                .listRowBackground(Color.clear)
            case .evaluated where store.degradedSourcePermissions.isEmpty:
                if store.unknownSourcePermissions.isEmpty {
                    ContentUnavailableView(
                        "Permissions look good",
                        systemImage: "checkmark.shield.fill",
                        description: Text("Omnesis has not detected an actionable permission problem on this iPhone.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    let description = "iOS does not reveal every read permission. "
                        + "If a source is missing data, open its Omnesis settings and request access again."
                    ContentUnavailableView(
                        "Some access is unknown",
                        systemImage: "questionmark.circle.fill",
                        description: Text(description)
                    )
                    .listRowBackground(Color.clear)
                }
            case .evaluated:
                ForEach(Array(visibleProblems.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 8) {
                        Label(item.capability.label, systemImage: "exclamationmark.triangle.fill")
                            .font(.headline).foregroundStyle(Theme.warning)
                        Text(item.displayName)
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        if let impact = item.capability.impact {
                            Text(impact).font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                        if let remediation = item.capability.remediation {
                            Text(remediation).font(.footnote).foregroundStyle(Theme.textMuted)
                        }
                        repairButton(item.capability.repairAction)
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(Theme.bgSecondary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
        .navigationTitle("Source permissions")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if refreshOnAppear { await store.refreshSourcePermissionHealth() }
        }
    }

    private var visibleProblems: [SourcePermissionProblem] {
        guard let focusedSourceId else { return store.degradedSourcePermissions }
        return store.degradedSourcePermissions.filter { $0.sourceId == focusedSourceId }
    }

    @ViewBuilder
    private func repairButton(_ action: PermissionRepairAction) -> some View {
        switch action {
        case .openAppSettings, .openSystemSettings:
            Button("Open iOS Settings") { openAppSettings() }.font(.footnote.weight(.semibold))
        case .openSourceSettings:
            if let returnToSettingsRoot {
                Button("Open Omnesis Settings", action: returnToSettingsRoot)
                    .font(.footnote.weight(.semibold))
            }
        case .none:
            EmptyView()
        }
    }

    private func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// A source-permission push may describe a different paired phone. This screen
/// intentionally does not consult local permission health or offer local iOS
/// Settings actions, because either could falsely imply that the remote source
/// is healthy or repairable from this device.
@available(iOS 17.0, *)
struct RemoteSourcePermissionView: View {
    let sourceId: String
    let deviceId: String
    let sourceName: String
    let deviceName: String

    var body: some View {
        let description = "\(sourceName) needs attention on \(deviceName). "
            + "Open Omnesis there to review and restore its permissions."
        ContentUnavailableView(
            "\(deviceName) needs attention",
            systemImage: "iphone.gen2.badge.exclamationmark",
            description: Text(description)
        )
        .background(Theme.bgPrimary)
        .navigationTitle("Source permissions")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("remote-source-permission:\(sourceId):\(deviceId)")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Source permissions — degraded") {
    NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
        .environment(AppStore.preview(sourcePermissionHealth: PreviewMocks.sourcePermissionHealth))
}

#Preview("Source permissions — not checked") {
    NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
        .environment(AppStore.preview())
}

#Preview("Source permissions — healthy") {
    NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
        .environment(AppStore.preview(sourcePermissionHealth: [
            PhotosPermissionHealth.report(access: .full, backgroundRefresh: .available),
        ]))
}

#Preview("Source permissions — unknown") {
    NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
        .environment(AppStore.preview(sourcePermissionHealth: [
            AppleHealthPermissionHealth.report(backgroundRefresh: .available),
        ]))
}

#Preview("Source permissions — loading") {
    NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
        .environment(AppStore.preview(sourcePermissionHealthLoading: true))
}

#Preview("Source permissions — gateway update deferred") {
    NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
        .environment(AppStore.preview(
            sourcePermissionHealth: PreviewMocks.sourcePermissionHealth,
            sourcePermissionHealthDeferred: ["fictional-mobile:local"]
        ))
}

#Preview("Source permissions — another device") {
    NavigationStack {
        RemoteSourcePermissionView(
            sourceId: "fictional-mobile:local",
            deviceId: "11111111-1111-4111-8111-111111111111",
            sourceName: "Fictional Mobile Source",
            deviceName: "Fictional iPhone"
        )
    }
}

#Preview("Source permissions — focused problem resolved") {
    NavigationStack {
        SourcePermissionHealthView(refreshOnAppear: false, focusedSourceId: "fictional-mobile:resolved")
    }
    .environment(AppStore.preview(sourcePermissionHealth: PreviewMocks.sourcePermissionHealth))
}
#endif
#endif

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct DesktopSourceHealthView: View {
    let source: DesktopSource
    let status: DesktopSourceHealth?
    let current: Bool
    let devices: [DesktopDevice]
    let canSignIn: Bool
    var reviewAccess: (String?) -> Void = { _ in }
    var checkStatus: (() -> Void)?
    let signIn: (String) -> Void
    @State private var showDetails = false

    private var reports: [DesktopSourceHealth] {
        guard let status else { return [] }
        if let members = status.members, !members.isEmpty { return members }
        return [status]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.xSmall) {
            if DesktopSourceActionPolicy(source: source, devices: devices).historical {
                Label("Historical data", systemImage: "clock.arrow.circlepath")
                Text("Indexed information is kept. Attach a computer to collect again.")
                    .foregroundStyle(DesktopTheme.secondary)
            } else if let status, current {
                Label(source.enabled ? status.title : "Paused", systemImage: source.enabled ? symbol(status) : "pause.circle")
                    .foregroundStyle(source.enabled && status.needsAttention ? DesktopTheme.warning : DesktopTheme.ink)
                if source.enabled, status.state == "syncing", !status.needsAccessRecovery {
                    if let fraction = status.progress?.fraction { ProgressView(value: fraction) }
                    else { ProgressView().controlSize(.small) }
                    if let message = status.progress?.message, !message.isEmpty {
                        Text(message).foregroundStyle(DesktopTheme.secondary).lineLimit(2)
                    }
                }
                if let date = status.lastSyncDate {
                    (Text("Last synced ") + Text(date, style: .relative)).foregroundStyle(DesktopTheme.secondary)
                }
                if reports.count > 1 {
                    ForEach(reports) { report in
                        Text("\(deviceName(report)): \(report.title)")
                            .foregroundStyle(DesktopTheme.secondary)
                    }
                }
                ForEach(reports.filter(\.needsSignIn)) { report in
                    if let deviceId = repairDevice(report), canSignIn {
                        Button(reports.count > 1 ? "Sign in again on \(deviceName(report))" : "Sign in again") {
                            signIn(deviceId)
                        }.accessibilityIdentifier("source-reauth-\(source.id)-\(deviceId)")
                    }
                }
                ForEach(reports.filter(\.needsAccessRecovery)) { report in
                    Button("Review access on \(deviceName(report))") { reviewAccess(report.deviceId) }
                        .accessibilityLabel("Review collection access for \(source.accountId) on \(deviceName(report))")
                }
                if reports.contains(where: { !$0.displayNotices.isEmpty }) {
                    Button("Review details") { showDetails = true }
                        .accessibilityLabel("Review collection details for \(source.accountId)")
                }
            } else {
                Label(source.enabled ? "Status unavailable" : "Paused", systemImage: source.enabled ? "clock" : "pause.circle")
                    .foregroundStyle(DesktopTheme.secondary)
            }
            if source.enabled, !DesktopSourceActionPolicy(source: source, devices: devices).historical, needsStatusCheck {
                Text("Omnesis hasn’t confirmed collection status yet. Your saved information is kept.")
                    .foregroundStyle(DesktopTheme.secondary)
                if let checkStatus {
                    Button("Check status", action: checkStatus)
                        .buttonStyle(DesktopButtonStyle())
                        .accessibilityIdentifier("source-check-status-\(source.id)")
                        .accessibilityLabel("Check collection status for \(source.accountId)")
                }
            }
        }.font(DesktopDesignTokens.Typography.secondary).frame(maxWidth: 290, alignment: .leading)
            .omnesisSheet(isPresented: $showDetails) {
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
                    Text("Collection details").font(DesktopDesignTokens.Typography.pageTitle).accessibilityAddTraits(.isHeader)
                    ScrollView {
                        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
                            ForEach(reports) { report in
                                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                                    if reports
                                        .count > 1 { Text(deviceName(report)).font(DesktopDesignTokens.Typography.body.weight(.medium)) }
                                    ForEach(Array(report.displayNotices.enumerated()), id: \.offset) { _, notice in
                                        VStack(alignment: .leading, spacing: 6) {
                                            Label(
                                                notice.title,
                                                systemImage: notice.severity == "error" ? "exclamationmark.circle" : "info.circle"
                                            )
                                            .font(DesktopDesignTokens.Typography.body.weight(.medium))
                                            if let detail = notice.detail { Text(detail).foregroundStyle(DesktopTheme.secondary) }
                                            ForEach(
                                                Array((report.needsAccessRecovery ? [] : notice.steps ?? []).enumerated()),
                                                id: \.offset
                                            ) { index, step in
                                                Text("\(index + 1). \(step)").foregroundStyle(DesktopTheme.secondary)
                                            }
                                            if report.needsAccessRecovery {
                                                Text(
                                                    "Review this source’s collection access. Existing indexed information is kept; opening Settings alone does not verify access."
                                                )
                                                .foregroundStyle(DesktopTheme.secondary)
                                            }
                                        }.textSelection(.enabled)
                                    }
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack { Spacer()
                        Button("Done") { showDetails = false }.keyboardShortcut(.cancelAction)
                    }
                }.padding(DesktopDesignTokens.Space.section).frame(width: 520, height: 440).omnesisTheme()
            }
    }

    private var needsStatusCheck: Bool {
        guard current, let status else { return true }
        return switch status.state {
        case "idle", "syncing", "synced", "completed", "paused", "needs-auth", "auth-expiring", "rate-limited",
             "permission-degraded", "background-access-missing", "stale", "error": false
        default: true
        }
    }

    private func repairDevice(_ report: DesktopSourceHealth) -> String? {
        let id = report.deviceId ?? (reports.count == 1 ? source.deviceId : "")
        return DesktopSourceActionPolicy(source: source, devices: devices).canRepair(id) ? id : nil
    }

    private func deviceName(_ report: DesktopSourceHealth) -> String {
        devices.first(where: { $0.id == report.deviceId })?.name ?? "Another device"
    }

    private func symbol(_ status: DesktopSourceHealth) -> String {
        switch status.state {
        case "synced", "completed": "checkmark.circle"
        case "syncing": "arrow.triangle.2.circlepath"
        case "paused": "pause.circle"
        case "needs-auth", "auth-expiring": "person.crop.circle.badge.exclamationmark"
        case "error", "stale", "permission-degraded", "background-access-missing": "exclamationmark.circle"
        case "unavailable": "wifi.slash"
        default: "clock"
        }
    }
}

struct DesktopSourceRepair: Identifiable {
    let source: DesktopSource
    let deviceId: String
    var id: String {
        source.id + ":" + deviceId
    }
}

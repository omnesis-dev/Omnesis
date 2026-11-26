// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Observation

struct DesktopSourceHealth: Decodable, Identifiable {
    struct Progress: Decodable {
        let total: Double?
        let processed: Double?
        let percentComplete: Double?
        let message: String?

        var fraction: Double? {
            if let percentComplete, percentComplete.isFinite, (0 ... 100).contains(percentComplete) {
                return percentComplete / 100
            }
            if let total, let processed, total.isFinite, processed.isFinite,
               total > 0, (0 ... total).contains(processed) { return processed / total }
            return nil
        }
    }

    struct Notice: Decodable, Identifiable {
        let kind: String
        let severity: String
        let title: String
        let detail: String?
        let steps: [String]?
        var id: String {
            kind + ":" + title
        }
    }

    struct Remediation: Decodable {
        struct Access: Decodable { let status: String
            let checkedAt: String
            let scopeDigest: String
            let target: String
        }

        let summary: String
        let steps: [String]
        let actions: [DesktopPermissionAction]?
        let access: Access?
    }

    let sourceId: String
    let deviceId: String?
    let state: String
    let lastSyncAt: String?
    let progress: Progress?
    let notices: [Notice]?
    let members: [DesktopSourceHealth]?
    let errorMessage: String?
    let remediation: Remediation?
    var needsAccessRecovery: Bool {
        ["permission-degraded", "background-access-missing"].contains(state) ||
            remediation?.access?.status == "denied" ||
            remediation?.actions?.isEmpty == false ||
            (notices ?? []).contains { ["permission-degraded", "background-access-missing"].contains($0.kind) }
    }

    var id: String {
        sourceId + ":" + (deviceId ?? "")
    }

    /// Older gateways have structured remedies but no composed notices yet.
    var displayNotices: [Notice] {
        if let notices { return notices }
        if let remediation {
            return [Notice(kind: "error", severity: "error", title: remediation.summary, detail: nil, steps: remediation.steps)]
        }
        if let errorMessage, !errorMessage.isEmpty {
            return [Notice(kind: "error", severity: "error", title: "Collection needs attention", detail: errorMessage, steps: nil)]
        }
        return []
    }

    var title: String {
        switch state {
        case _ where remediation?.access?.status == "denied": "Collection access needs attention"
        case "idle": "Waiting for first sync"
        case "syncing": "Collecting information"
        case "synced", "completed": "Last sync complete"
        case "paused": "Paused"
        case "needs-auth": "Sign-in needed"
        case "auth-expiring": "Sign-in expires soon"
        case "rate-limited": "Waiting to retry"
        case "permission-degraded": "Some access is missing"
        case "background-access-missing": "Background access needed"
        case "unavailable": "Device unavailable"
        case "stale": "Data feed needs attention"
        case "error": "Needs attention"
        default: "Status unavailable"
        }
    }

    var needsSignIn: Bool {
        state == "needs-auth" || state == "auth-expiring"
    }

    var needsAttention: Bool {
        ["needs-auth", "auth-expiring", "permission-degraded", "background-access-missing", "stale", "error"]
            .contains(state) || needsAccessRecovery
    }

    var lastSyncDate: Date? {
        guard let lastSyncAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: lastSyncAt) ?? ISO8601DateFormatter().date(from: lastSyncAt)
    }
}

extension DesktopAPI {
    func sourceHealth() async throws -> [DesktopSourceHealth] {
        let page: Rows<DesktopSourceHealth> = try await request("GET", "admin/sync/status")
        return page.items
    }
}

@MainActor @Observable
final class DesktopSourceHealthMonitor {
    private(set) var statuses: [String: DesktopSourceHealth] = [:]
    private(set) var failure: String?
    private(set) var loaded = false
    private(set) var revision = 0
    var onUpdate: (() -> Void)?
    private var generation = UUID()
    init(initialStatuses: [DesktopSourceHealth] = []) {
        statuses = Dictionary(initialStatuses.map { ($0.sourceId, $0) }, uniquingKeysWith: { _, latest in latest })
        loaded = !initialStatuses.isEmpty
    }

    func invalidate(clear: Bool = false) {
        generation = UUID()
        loaded = false
        if clear {
            statuses = [:]
            failure = nil
        }
    }

    /// One aggregate request while the source list is visible; an old connection
    /// cannot publish after cancellation or mark retained reports as current.
    func observe(api: DesktopAPI?, refreshInterval: Duration = .seconds(5)) async {
        let requestGeneration = UUID()
        generation = requestGeneration
        statuses = [:]
        failure = nil
        loaded = false
        guard let api else { return }
        while !Task.isCancelled, generation == requestGeneration {
            do {
                let rows = try await api.sourceHealth()
                guard !Task.isCancelled, generation == requestGeneration else { return }
                statuses = Dictionary(rows.map { ($0.sourceId, $0) }, uniquingKeysWith: { _, latest in latest })
                failure = nil
                loaded = true
                revision += 1
                onUpdate?()
            } catch {
                guard !Task.isCancelled, generation == requestGeneration else { return }
                failure = "Could not refresh collection status. Check your connection, then refresh."
                onUpdate?()
            }
            do { try await Task.sleep(for: refreshInterval) } catch { return }
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

struct DesktopCollectionAccessIssue: Identifiable {
    let sourceId: String
    let account: String
    let computer: String
    let target: DesktopAccessTarget?
    var id: String {
        sourceId + ":" + (target?.deviceId ?? "unverified")
    }

    static func resolve(sources: [DesktopSource], devices: [DesktopDevice], statuses: [String: DesktopSourceHealth]) -> [Self] {
        sources.sorted { $0.id < $1.id }.flatMap { source -> [Self] in
            let policy = DesktopSourceActionPolicy(source: source, devices: devices)
            guard source.enabled, !policy.historical, let report = statuses[source.id] else { return [] }
            let members = (report.members ?? []).filter { $0.sourceId == source.id && $0.needsAccessRecovery }
            let problems = members.isEmpty && report.needsAccessRecovery ? [report] : members
            return problems.map { problem in
                let candidate = problem.deviceId ?? (policy.members.count == 1 ? policy.members.first : nil)
                let verified = candidate.flatMap { policy.canRepair($0) ? $0 : nil }
                let target = verified.map { DesktopAccessTarget(
                    descriptorId: source.type,
                    deviceId: $0,
                    sourceId: source.id,
                    accountId: source.accountId,
                    params: [:]
                ) }
                return Self(
                    sourceId: source.id,
                    account: source.accountId,
                    computer: candidate.flatMap { id in devices.first(where: { $0.id == id })?.name } ?? "the collection computer",
                    target: target
                )
            }
        }
    }
}

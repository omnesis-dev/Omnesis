// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Historical origins never confer membership or authority to collect again.
struct DesktopSourceActionPolicy {
    let source: DesktopSource
    let devices: [DesktopDevice]

    var members: [String] {
        let archived = Set((source.archivedDevices ?? []).map(\.deviceId))
        return Array(Set(source.members ?? (source.archived == true ? [] : [source.deviceId])))
            .filter { !archived.contains($0) }.sorted()
    }

    var historical: Bool {
        source.archived == true || (members.isEmpty && !(source.archivedDevices ?? []).isEmpty)
    }

    var eligibleMembers: [String] {
        guard !historical else { return [] }
        return members.filter { id in
            !(source.dormantHosts ?? []).contains(id) &&
                devices.contains { $0.id == id && $0.revokedAt == nil && $0.needsPairing != true }
        }
    }

    var canResume: Bool {
        !eligibleMembers.isEmpty
    }

    var canSync: Bool {
        source.enabled && canResume
    }

    func canRepair(_ id: String) -> Bool {
        eligibleMembers.contains(id)
    }
}

extension DesktopAPI {
    /// Fresh source and roster snapshots authorize only this exact repair target.
    func requireSourceRepair(_ sourceId: String, deviceId: String) async throws {
        let page = try await sourcePage()
        let roster = try await devices()
        guard let source = page.items.first(where: { $0.id == sourceId }),
              DesktopSourceActionPolicy(source: source, devices: roster).canRepair(deviceId) else {
            throw DesktopAPIError
                .message("This computer can no longer sign in for this source. Refresh Sources and review its collection details.")
        }
        try Task.checkCancellation()
    }
}

extension DesktopAPIContext {
    func mutateSourceCollection(_ sourceId: String, sync: Bool, enabled: Bool = false) async throws {
        let page = try await perform { try await $0.sourcePage() }
        let roster = try await perform { try await $0.devices() }
        guard let source = page.items.first(where: { $0.id == sourceId }) else {
            throw DesktopAPIError.message("This source has changed. Refresh Sources before continuing.")
        }
        let policy = DesktopSourceActionPolicy(source: source, devices: roster)
        guard sync ? policy.canSync : (!enabled || policy.canResume) else {
            throw DesktopAPIError.message("Attach or repair a computer before collecting from this source.")
        }
        try check()
        if sync { try await mutate("POST", "admin/sources/\(pathPart(sourceId))/sync") }
        else { try await mutate("PATCH", "admin/sources/\(pathPart(sourceId))", body: ["enabled": enabled]) }
    }
}

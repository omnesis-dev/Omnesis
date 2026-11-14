// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Who a change to an access level reaches: its live connections and its integrations.
struct AccessLevelUsage: Equatable {
    var connectionCount: Int
    var connections: [String]
    var integrations: [String]

    init(level: AccessLevelSummary, overview: AccessOverview) {
        connectionCount = level.connectionCount
        let names = overview.principals.filter { $0.revokedAt == nil }.flatMap { principal in
            principal.grants.filter { $0.revokedAt == nil && $0.levelId == level.id }.map { _ in principal.name }
        }
        connections = names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        integrations = (level.devices ?? []).map(\.name)
    }

    /// The agents a document's access check lists on a level, in the gateway's order: its connections, and the
    /// paired devices that answer under it.
    init(agents: [DocumentAccessAudit.Agent]) {
        let names = agents.filter { $0.kind != "device" }.map(\.name)
        connections = names
        connectionCount = names.count
        integrations = agents.filter { $0.kind == "device" }.map(\.name)
    }

    var inUse: Bool {
        connectionCount > 0 || !integrations.isEmpty
    }

    /// Why the level cannot be deleted yet, or nil when nothing uses it.
    var deletionBlock: String? {
        guard inUse else { return nil }
        if integrations.isEmpty { return "Move or remove its connections first." }
        if connectionCount == 0 { return "Move its integrations to another access level first." }
        return accessLevelInUseDeletionMessage
    }
}

/// When a saved change takes effect for the agents that use the level.
let accessLevelImpactDetail = "Connected agents receive the new permissions when they refresh. They do not need to reconnect."

let accessLevelInUseDeletionMessage = "Move its connections and integrations off it first."

/// How a refused access-level deletion is presented. A level that is already gone needs no message.
func accessLevelDeletionFailureMessage(_ error: Error) -> String? {
    if error as? GatewayClient.Error == .notFound { return nil }
    if accessLevelMutationCode(error) == "level-in-use" { return accessLevelInUseDeletionMessage }
    return "The access level could not be deleted."
}
